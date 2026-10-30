import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { missingFiles, readBuck, TOTAL_UNPACKED_BYTES } from '../src/buck/container';
import { addNode, ensureConversions, isLinearChain, moveNode, openForEditing, removeNode } from '../src/buck/editor/chain';
import { decodeDepthMap } from '../src/buck/editor/AuxPanel';
import { archivePath } from '../src/buck/editor/NodeInspector';
import { scalarField, imageBuf } from '../src/buck/field';
import { depthRangeMask, imageMask } from '../src/buck/nodes/masks';
import type { DepthRangeContext } from '../src/buck/nodes/masks';
import { pngDataBytes, sanitizePng } from '../src/buck/png';
import { renderGraph } from '../src/buck/render';
import { BUCK_MIMETYPE, BuckError, LIMITS } from '../src/buck/types';
import type { BuckGraph, BuckNode, RenderContext } from '../src/buck/types';

/** Regression tests for the review findings (model trust is covered in buck-auxui.test.ts). */
const fixture=():BuckGraph=>JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8'));
const u8=(s:string)=>new TextEncoder().encode(s);

// Minimal PNG writer (PNG 3 §5.3): length, type, data, CRC over type + data.
function chunk(type:string,data:Uint8Array){
  const out=new Uint8Array(12+data.length),v=new DataView(out.buffer),td=new Uint8Array(4+data.length);
  td.set(u8(type));td.set(data,4);v.setUint32(0,data.length);out.set(td,4);v.setUint32(8+data.length,crc32(td)>>>0);return out;
}
function ihdr(w:number,h:number,depth=8,color=0,interlace=0){const d=new Uint8Array(13),v=new DataView(d.buffer);v.setUint32(0,w);v.setUint32(4,h);d.set([depth,color,0,0,interlace],8);return d;}
const SIG=new Uint8Array([137,80,78,71,13,10,26,10]);
const png=(...chunks:Uint8Array[])=>{const all=[SIG,...chunks],out=new Uint8Array(all.reduce((s,c)=>s+c.length,0));let o=0;for(const c of all){out.set(c,o);o+=c.length;}return out;};
const ctx=(w:number,h:number,files=new Map<string,Uint8Array>(),extra:Partial<DepthRangeContext>={}):RenderContext=>({width:w,height:h,frame:0,aux:{masks:{}},files,workingLinear:'ACEScg',warn:()=>{},...extra});

describe('PNG gate (png.ts)',()=>{
  it('computes the exact filtered data size, Adam7 included',()=>{
    expect(pngDataBytes(3,2,8,false)).toBe(2*(1+3));
    expect(pngDataBytes(5,1,1,false)).toBe(2);
    expect(pngDataBytes(1,1,8,true)).toBe(2); // only pass 1 is non-empty
    expect(pngDataBytes(5,5,8,true)).toBe(36); // passes 2+2+3+4+4+9+12, 25 pixels + 11 filter bytes
  });
  it('accepts a normal PNG and an interlaced one, and strips ancillary chunks',()=>{
    const plain=encodePng({width:3,height:2,data:new Uint8Array([0,64,128,255,32,16]),depth:8,channels:1});
    expect(sanitizePng(plain,'Test')).toMatchObject({width:3,height:2});
    // 5×5 gray, Adam7: every scanline filter 0, all samples 200.
    const passes=[[1,1],[1,1],[1,2],[2,1],[1,3],[3,2],[2,5]],raw:number[]=[];
    for(const [rows,w] of passes)for(let r=0;r<rows;r++)raw.push(0,...new Array(w).fill(200));
    expect(raw.length).toBe(36);
    // iCCP with a zlib bomb would be inflated by fast-png without a limit; the gate drops it.
    const bomb=deflateSync(new Uint8Array(1<<20));
    const iccp=new Uint8Array([...u8('x'),0,0,...bomb]);
    const file=png(chunk('IHDR',ihdr(5,5,8,0,1)),chunk('iCCP',iccp),chunk('IDAT',deflateSync(new Uint8Array(raw))),chunk('IEND',new Uint8Array(0)));
    const clean=sanitizePng(file,'Test').png;
    expect(clean.length).toBeLessThan(file.length-bomb.length);
    const mask=imageMask.evaluate({},{file:'masks/m.png',fit:'stretch'},ctx(5,5,new Map([['masks/m.png',file]])));
    expect(Array.from(mask.data).every(v=>Math.abs(v-200/255)<1e-6)).toBe(true);
  });
  it('stops a decompression bomb behind a 1×1 header early',()=>{
    const idat=deflateSync(new Uint8Array(64<<20)),file=png(chunk('IHDR',ihdr(1,1)),chunk('IDAT',idat),chunk('IEND',new Uint8Array(0)));
    const t0=performance.now();
    expect(()=>sanitizePng(file,'Maskenbild „masks/m.png“')).toThrow(/Dekompressionsbombe/);
    expect(performance.now()-t0).toBeLessThan(2000);
    expect(()=>imageMask.evaluate({},{file:'masks/m.png',fit:'stretch'},ctx(1,1,new Map([['masks/m.png',file]])))).toThrow(/Dekompressionsbombe/);
    expect(()=>decodeDepthMap(file)).toThrow(/Tiefenkarte: .*Dekompressionsbombe/);
  });
  it('rejects malformed structure',()=>{
    const idat=chunk('IDAT',deflateSync(new Uint8Array([0,1]))),end=chunk('IEND',new Uint8Array(0)),head=chunk('IHDR',ihdr(1,1));
    expect(()=>sanitizePng(new Uint8Array(40),'T')).toThrow(/kein PNG/);
    expect(()=>sanitizePng(png(head,chunk('ABCD',new Uint8Array(0)),idat,end),'T')).toThrow(/kritischer Chunk/);
    expect(()=>sanitizePng(png(head,idat,chunk('tEXt',u8('a')),idat,end),'T')).toThrow(/direkt aufeinander/);
    expect(()=>sanitizePng(png(head,end),'T')).toThrow(/IDAT/);
    expect(()=>sanitizePng(png(head,idat),'T')).toThrow(/IEND/);
    expect(()=>sanitizePng(png(chunk('IHDR',ihdr(1,1,3,0)),idat,end),'T')).toThrow(/Bildkopf/);
    expect(()=>sanitizePng(png(chunk('IHDR',ihdr(4097,1)),idat,end),'T')).toThrow(/höchstens 4096/);
    expect(()=>sanitizePng(png(chunk('IHDR',ihdr(2,1)),idat,end),'T')).toThrow(/kleiner/);
  });
});

describe('mask.depthRange@1 with invalid depth',()=>{
  const depth=scalarField(2,1,new Float32Array([1,Infinity]));
  it('keeps the metric sky beyond every band',()=>{
    const metric=ctx(2,1,undefined,{depthSemantics:'metric'});
    expect(Array.from(depthRangeMask.evaluate({depth},{near:0,far:2,feather:.5,invert:false},metric).data)).toEqual([1,0]);
    expect(Array.from(depthRangeMask.evaluate({depth},{near:0,far:2,feather:.5,invert:true},metric).data)).toEqual([0,1]);
    expect(Array.from(depthRangeMask.evaluate({depth},{near:50,far:1e4,feather:5,invert:false},metric).data)).toEqual([0,0]);
  });
  it('puts the sky at the far end of normalized depth',()=>{
    const rel=scalarField(2,1,new Float32Array([.2,Infinity]));
    expect(Array.from(depthRangeMask.evaluate({depth:rel},{near:.55,far:1,feather:.15,invert:false},ctx(2,1)).data)).toEqual([0,1]);
  });
  it('gets the semantics of the declared input from renderGraph',()=>{
    const g=fixture();g.inputs.depth={...g.inputs.depth,semantics:'metric',normalize:{mode:'none'}};
    const src=imageBuf(2,1,'Rec.1886 Rec.709 - Display'),aux={depth:scalarField(2,1,new Float32Array([1,Infinity])),masks:{}};
    g.nodes=g.nodes.map(n=>n.id==='bgMask'&&n.type==='mask.depthRange@1'?{...n,params:{...n.params,near:0,far:2,feather:.5}}:n);
    expect(Array.from(renderGraph(g,src,{frame:0,aux,files:new Map(),target:'bgMask'}).output.data)).toEqual([1,0]);
    const r=fixture();
    expect(Array.from(renderGraph(r,src,{frame:0,aux:{depth:scalarField(2,1,new Float32Array([.2,Infinity])),masks:{}},files:new Map(),target:'bgMask'}).output.data)).toEqual([0,1]);
  });
  it('warns when two depth inputs share the single depth channel',()=>{
    const g=fixture();g.inputs.depth2={...g.inputs.depth};
    g.nodes=g.nodes.map(n=>n.id==='bgMask'?{...n,inputs:{depth:'$depth2'}}:n);
    const src=imageBuf(1,1,'Rec.1886 Rec.709 - Display'),aux={depth:scalarField(1,1,new Float32Array([.5])),masks:{}};
    const r=renderGraph(g,src,{frame:0,aux,files:new Map()});
    expect(r.warnings.some(w=>w.includes("„$depth“")&&w.includes("„$depth2“")&&w.includes("denselben Tiefenkanal"))).toBe(true);
  });
});

describe('editor chain on foreign graphs',()=>{
  it('restores data-flow order on open, so edits do not restructure (reversed nodes[])',()=>{
    const fx=fixture(),reversed={...fx,nodes:[...fx.nodes].reverse()};
    expect(isLinearChain(fx)).toBe(true);expect(isLinearChain(reversed)).toBe(false);
    // Even unsorted, ensureConversions keeps the foreign wiring instead of rewiring it in array order.
    expect(ensureConversions(reversed)).toBe(reversed);
    const {graph,linear}=openForEditing(reversed);
    expect(linear).toBe(true);
    const ids=(g:BuckGraph)=>g.nodes.filter(n=>!n.type.startsWith('mask.')).map(n=>n.id);
    expect(ids(graph)).toEqual(ids(fx));
    expect(ensureConversions(graph).nodes.map(n=>`${n.id}<-${n.inputs.image??''}`)).toEqual(graph.nodes.map(n=>`${n.id}<-${n.inputs.image??''}`));
    expect(ensureConversions(graph).output).toBe('fargo');
  });
  it('locks image-chain edits of a branching graph but keeps masks and parameters editable',()=>{
    const fx=fixture(),side:BuckNode={id:'side',type:'color.cdl@1',inputs:{image:'toLinear'},params:{slope:[1,1,1],offset:[0,0,0],power:[1,1,1],saturation:1,style:'noClampFwd',space:'ACEScg'}};
    const luma:BuckNode={id:'lumaSide',type:'mask.luma@1',inputs:{image:'side'},params:{low:0,high:1,softness:.1,space:'ACEScg'}};
    const i=fx.nodes.findIndex(n=>n.id==='toLinear')+1,g={...fx,nodes:[...fx.nodes.slice(0,i),side,luma,...fx.nodes.slice(i)]};
    const {graph,linear}=openForEditing(g);
    expect(linear).toBe(false);
    expect(ensureConversions(graph)).toBe(graph);
    expect(()=>addNode(graph,'lens.dof@1')).toThrow(/keine einfache Kette/);
    expect(()=>removeNode(graph,'fog')).toThrow(/keine einfache Kette/);
    expect(()=>moveNode(graph,'fog',-1)).toThrow(/keine einfache Kette/);
    const m=addNode(graph,'mask.gradient@1');
    expect(m.graph.nodes.filter(n=>n.type!=='mask.gradient@1').map(n=>[n.id,n.inputs.image])).toEqual(graph.nodes.map(n=>[n.id,n.inputs.image]));
    expect(removeNode(m.graph,m.id).nodes.map(n=>n.id)).toEqual(graph.nodes.map(n=>n.id));
  });
});

describe('archive files',()=>{
  const cube=u8('LUT_3D_SIZE 2\n'+'0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  it('derives a valid, unique path from a picked file after validating it',()=>{
    expect(archivePath('lut','Mein Look (v2).CUBE',cube,new Map())).toBe('luts/mein_look_v2_.cube');
    expect(archivePath('lut','a.cube',cube,new Map([['luts/a.cube',cube]]))).toBe('luts/a.cube');
    expect(archivePath('lut','a.cube',cube,new Map([['luts/a.cube',u8('x')]]))).toBe('luts/a-2.cube');
    expect(archivePath('lut','..cube',cube,new Map())).toBe('luts/lut.cube');
    expect(()=>archivePath('lut','x.cube',u8('LUT_1D_SIZE 2\n'),new Map())).toThrow(/1D/);
    const mask=encodePng({width:2,height:2,data:new Uint8Array([0,255,255,0]),depth:8,channels:1});
    expect(archivePath('mask','Vignette.png',mask,new Map())).toBe('masks/vignette.png');
    expect(()=>archivePath('mask','x.png',cube,new Map())).toThrow(/kein PNG/);
  });
  it('lists file references missing from the package',()=>{
    const g=fixture();
    expect(missingFiles(g,new Map())).toEqual(['luts/fargo_look_rec709_64.cube','thumbs/after.jpg','thumbs/before.jpg']);
    const files=new Map([['luts/fargo_look_rec709_64.cube',cube],['thumbs/after.jpg',u8('a')],['thumbs/before.jpg',u8('b')]]);
    expect(missingFiles(g,files)).toEqual([]);
    const withLut=addNode(g,'color.lut3d@1').graph;
    expect(missingFiles(withLut,files)).toEqual(['luts/eigene.cube']);
  });
});

describe('container total size',()=>{
  it('rejects archives whose entries unpack to more than 128 MiB in sum, before inflating',async()=>{
    // Hand-built: three ext/ entries claim 60 MiB each at ratio ~86:1; the bodies are never inflated.
    const enc=(s:string)=>u8(s),entries:{name:string;body:Uint8Array;usize:number;method:number}[]=[{name:'mimetype',body:enc(BUCK_MIMETYPE),usize:BUCK_MIMETYPE.length,method:0}];
    for(let i=0;i<3;i++)entries.push({name:`ext/x/${i}.bin`,body:new Uint8Array(700*1024),usize:60<<20,method:8});
    const locals:Uint8Array[]=[],centrals:Uint8Array[]=[];let offset=0;
    for(const e of entries){
      const name=enc(e.name),l=new Uint8Array(30+name.length+e.body.length),lv=new DataView(l.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint16(8,e.method,true);lv.setUint32(18,e.body.length,true);lv.setUint32(22,e.usize,true);lv.setUint16(26,name.length,true);l.set(name,30);l.set(e.body,30+name.length);
      const c=new Uint8Array(46+name.length),cv=new DataView(c.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,0x0314,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(10,e.method,true);cv.setUint32(20,e.body.length,true);cv.setUint32(24,e.usize,true);cv.setUint16(28,name.length,true);cv.setUint32(38,(0o100644<<16)>>>0,true);cv.setUint32(42,offset,true);c.set(name,46);
      locals.push(l);centrals.push(c);offset+=l.length;
    }
    const cd=centrals.reduce((s,c)=>s+c.length,0),out=new Uint8Array(offset+cd+22),v=new DataView(out.buffer);let p=0;
    for(const part of [...locals,...centrals]){out.set(part,p);p+=part.length;}
    v.setUint32(p,0x06054b50,true);v.setUint16(p+8,entries.length,true);v.setUint16(p+10,entries.length,true);v.setUint32(p+12,cd,true);v.setUint32(p+16,offset,true);
    expect(TOTAL_UNPACKED_BYTES).toBe(LIMITS.archiveBytes);
    const error=await readBuck(out,{parse:t=>JSON.parse(t) as BuckGraph}).catch((e:unknown)=>e);
    expect(error).toBeInstanceOf(BuckError);expect((error as Error).message).toMatch(/entpackt größer als 128 MiB/);
  });
});
