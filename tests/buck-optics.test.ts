import { describe, expect, it } from 'vitest';
import { GRAIN, grainField, grainNode, grainSeed, grainWeight, halationNode, highlightWeight, vignetteFalloff, vignetteGain, vignetteNode } from '../src/buck/nodes/optics';
import { relightNode } from '../src/buck/nodes/relight';
import { defaultNode } from '../src/buck/editor/chain';
import { promptToGraph } from '../src/buck/prompt';
import { renderGraph } from '../src/buck/render';
import { checkGraph } from '../src/buck/validate';
import type { BuckGraph, GrainParams, HalationParams, ImageBuf, NodeOf, NodeType, RenderContext, Resolved, VectorField, VignetteParams } from '../src/buck/types';

const ctx=(w:number,h:number,frame=0):RenderContext=>({width:w,height:h,frame,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}});
const flat=(w:number,h:number,v:number|((x:number,y:number)=>[number,number,number])):ImageBuf=>{
  const d=new Float32Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const c=typeof v==='number'?[v,v,v]:v(x,y);d.set([c[0],c[1],c[2],.5],(y*w+x)*4);}
  return {kind:'image',width:w,height:h,data:d,space:'ACEScg'};
};
const px=(img:ImageBuf,x:number,y:number)=>Array.from(img.data.subarray((y*img.width+x)*4,(y*img.width+x)*4+4));
const node=<T extends NodeType>(g:BuckGraph,type:T)=>g.nodes.find((n):n is NodeOf<T>=>n.type===type);
const build=(text:string)=>{const r=promptToGraph(text);expect(checkGraph(r.graph),text).toEqual([]);return r;};
const types=(g:BuckGraph)=>g.nodes.map(n=>n.type);
const std=(a:ArrayLike<number>)=>{let m=0;for(let i=0;i<a.length;i++)m+=a[i];m/=a.length;let v=0;for(let i=0;i<a.length;i++)v+=(a[i]-m)**2;return Math.sqrt(v/a.length);};
function corr(a:ArrayLike<number>,b:ArrayLike<number>){
  let ma=0,mb=0;for(let i=0;i<a.length;i++){ma+=a[i];mb+=b[i];}ma/=a.length;mb/=b.length;
  let sab=0,sa=0,sb=0;for(let i=0;i<a.length;i++){sab+=(a[i]-ma)*(b[i]-mb);sa+=(a[i]-ma)**2;sb+=(b[i]-mb)**2;}
  return sab/Math.sqrt(sa*sb);
}
/** FNV-1a over the bytes of a float buffer: a bit-exact fingerprint. */
function fnv(f:Float32Array){let h=0x811c9dc5;for(const b of new Uint8Array(f.buffer,f.byteOffset,f.byteLength)){h^=b;h=Math.imul(h,16777619)>>>0;}return h.toString(16);}

describe('lens.vignette@1',()=>{
  const p=(x:Partial<Resolved<VignetteParams>>={}):Resolved<VignetteParams>=>({exposure:-1,radius:.2,softness:.3,roundness:0,...x});
  it('keeps the center, darkens the corners by exactly 2^exposure at full falloff and keeps alpha',()=>{
    const img=flat(64,36,.5),out=vignetteNode.evaluate({image:img},p({radius:0,softness:.1}),ctx(64,36)) as ImageBuf;
    expect(px(out,0,0)[0]).toBeCloseTo(.25,6);expect(px(out,0,0)[3]).toBe(.5);
    const c=vignetteNode.evaluate({image:img},p(),ctx(64,36)) as ImageBuf;
    expect(px(c,32,18)[0]).toBe(.5);expect(px(c,0,0)[0]).toBeLessThan(.5);expect(px(c,0,0)[0]).toBeGreaterThanOrEqual(.25-1e-7);
  });
  it('factor mode: gain 1 − strength·f; negative strength brightens the edge',()=>{
    expect(vignetteGain(1,{strength:.4})).toBeCloseTo(.6,12);expect(vignetteGain(1,{strength:-.5})).toBeCloseTo(1.5,12);expect(vignetteGain(.5,{exposure:-2})).toBeCloseTo(.5,12);
    expect(vignetteGain(1,{strength:1})).toBe(0);
  });
  it('roundness 0 follows the frame, 1 is a circle',()=>{
    // 16:9, top edge center vs side edge center: equal falloff for roundness 0, top weaker for a circle.
    const a=16/9,top=(r:number)=>vignetteFalloff(.5,0,{radius:.2,softness:.3,roundness:r},.5,.28125,a),side=(r:number)=>vignetteFalloff(0,.28125,{radius:.2,softness:.3,roundness:r},.5,.28125,a);
    expect(top(0)).toBeCloseTo(side(0),12);expect(top(1)).toBeLessThan(side(1));
  });
  it('is resolution independent (a 2× render box-downsampled equals the 1× render)',()=>{
    const lo=vignetteNode.evaluate({image:flat(80,45,.5)},p(),ctx(80,45)) as ImageBuf,hi=vignetteNode.evaluate({image:flat(160,90,.5)},p(),ctx(160,90)) as ImageBuf;
    let max=0;
    for(let y=0;y<45;y++)for(let x=0;x<80;x++){
      let s=0;for(const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]])s+=hi.data[((2*y+dy)*160+2*x+dx)*4];
      max=Math.max(max,Math.abs(s/4-lo.data[(y*80+x)*4]));
    }
    expect(max).toBeLessThan(2e-3);
  });
  it('validator requires exactly one of strength and exposure',()=>{
    const g=build('Vignette').graph,n=node(g,'lens.vignette@1')!;
    (n.params as unknown as Record<string,unknown>).strength=.3;
    expect(checkGraph(g).join()).toMatch(/Genau einer der Parameter „strength“/);
    delete (n.params as unknown as Record<string,unknown>).strength;delete (n.params as unknown as Record<string,unknown>).exposure;
    expect(checkGraph(g).join()).toMatch(/Genau einer/);
    (n.params as unknown as Record<string,unknown>).exposure=-9;expect(checkGraph(g).join()).toMatch(/„exposure“ muss zwischen -8 und 4/);
  });
});

describe('film.grain@1',()=>{
  const base=defaultNode('film.grain@1','g').params as Resolved<GrainParams>;
  const p=(x:Partial<Resolved<GrainParams>>={})=>({...base,...x});
  const run=(img:ImageBuf,q=p(),frame=0)=>grainNode.evaluate({image:img},q,ctx(img.width,img.height,frame)) as ImageBuf;
  it('is deterministic per frame and changes with frame and seed unless static',()=>{
    const img=flat(96,54,.18);
    expect(fnv(run(img).data)).toBe(fnv(run(img).data));
    expect(fnv(run(img,p(),1).data)).not.toBe(fnv(run(img).data));
    expect(fnv(run(img,p({seed:7})).data)).not.toBe(fnv(run(img).data));
    expect(fnv(run(img,p({animate:false}),5).data)).toBe(fnv(run(img,p({animate:false}),0).data));
    expect(grainSeed(0,3,1)).not.toBe(grainSeed(0,3,2));
  });
  it('keeps black black, alpha untouched and the mean nearly unchanged',()=>{
    const black=run(flat(64,36,0));expect(Array.from(black.data).filter((_,i)=>i%4<3).every(v=>v===0)).toBe(true);
    const mid=run(flat(128,72,.18),p({intensity:.3}));expect(mid.data[3]).toBe(.5);
    let m=0;for(let i=0;i<mid.data.length;i+=4)m+=mid.data[i];m/=mid.data.length/4;
    expect(Math.abs(m/.18-1)).toBeLessThan(.03);
  });
  it('is strongest in shadows/mid-tones (Boolean-model weight) and weaker in highlights',()=>{
    expect(grainWeight(0,1)).toBe(0);expect(grainWeight(1,1)).toBeCloseTo(0,6);
    // Peak where u = t^0.7 = 0.5, i.e. display tone t ≈ 0.37.
    const tPeak=.5**(1/GRAIN.toneGamma),yPeak=tPeak**(1/GRAIN.displayGamma);
    expect(grainWeight(yPeak,1)).toBeCloseTo(1,6);expect(grainWeight(.9,1)).toBeLessThan(grainWeight(.05,1));
    expect(grainWeight(.9,0)).toBe(1);
    const rel=(v:number)=>{const o=run(flat(96,54,v),p({intensity:.3,response:1,chroma:0}));const r:number[]=[];for(let i=0;i<o.data.length;i+=4)r.push(Math.log2(o.data[i]/v));return std(r);};
    expect(rel(yPeak)).toBeGreaterThan(rel(.85));expect(rel(yPeak)).toBeGreaterThan(rel(.003));
  });
  it('monochrome grain scales all channels alike, color grain does not',()=>{
    const img=flat(48,27,()=>[.2,.15,.1]);
    const mono=run(img,p({chroma:0,intensity:.4})),color=run(img,p({chroma:1,intensity:.4}));
    for(let i=0;i<mono.data.length;i+=4)expect(mono.data[i]/.2).toBeCloseTo(mono.data[i+1]/.15,4);
    let differs=0;for(let i=0;i<color.data.length;i+=4)if(Math.abs(color.data[i]/.2-color.data[i+1]/.15)>1e-3)differs++;
    expect(differs).toBeGreaterThan(color.data.length/8);
  });
  it('has unit RMS and is tied to image widths: a 2× field downsampled correlates with the 1× field',()=>{
    const q=p({size:.01,chroma:0}),lo=grainField(200,100,q,0),hi=grainField(400,200,q,0);
    expect(std(lo.data)).toBeGreaterThan(.85);expect(std(lo.data)).toBeLessThan(1.15);
    const down=new Float32Array(200*100);for(let y=0;y<100;y++)for(let x=0;x<200;x++)down[y*200+x]=(hi.data[(2*y)*400+2*x]+hi.data[(2*y)*400+2*x+1]+hi.data[(2*y+1)*400+2*x]+hi.data[(2*y+1)*400+2*x+1])/4;
    expect(corr(lo.data,down)).toBeGreaterThan(.97);
    // Cells smaller than a pixel are supersampled: the per-pixel spread drops, as in a downscaled film scan.
    expect(std(grainField(100,50,p({size:.003,chroma:0}),0).data)).toBeLessThan(std(grainField(800,400,p({size:.003,chroma:0}),0).data));
  });
});

describe('film.halation@1',()=>{
  const base=defaultNode('film.halation@1','h').params as Resolved<HalationParams>;
  const point=(w:number,h:number,v=8)=>flat(w,h,(x,y)=>x===Math.floor(w/2)&&y===Math.floor(h/2)?[v,v,v]:[.05,.05,.05]);
  it('leaves an image without highlights unchanged',()=>{
    const img=flat(40,24,.3),out=halationNode.evaluate({image:img},{...base,bloom:.5},ctx(40,24)) as ImageBuf;
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
    expect(highlightWeight(.8,.8,1.5)).toBeCloseTo(.5,6);
  });
  it('puts a red halo around a bright point; bloom adds the point color',()=>{
    const img=point(64,36),out=halationNode.evaluate({image:img},base,ctx(64,36)) as ImageBuf,[r,g,b]=px(out,32+2,18);
    expect(r-.05).toBeGreaterThan(3*(g-.05));expect(g-.05).toBeGreaterThan(b-.05);expect(g).toBeGreaterThanOrEqual(.05);expect(b).toBeGreaterThanOrEqual(.05-1e-7);
    const bl=halationNode.evaluate({image:img},{...base,intensity:0,bloom:1},ctx(64,36)) as ImageBuf,c=px(bl,34,18);
    expect(c[0]).toBeGreaterThan(.05);expect(c[0]).toBeCloseTo(c[1],6);expect(c[3]).toBe(.5);
    expect(Array.from((halationNode.evaluate({image:img},{...base,intensity:0,bloom:0},ctx(64,36)) as ImageBuf).data)).toEqual(Array.from(img.data));
  });
  it('scales its radius with the image width',()=>{
    const ring=(w:number)=>{const h=Math.round(w*9/16),o=halationNode.evaluate({image:point(w,h,50)},{...base,radius:.02},ctx(w,h)) as ImageBuf;return px(o,Math.floor(w/2)+Math.round(.03*w),Math.floor(h/2))[0]-.05;};
    // Same normalized distance, 2× the pixels: the halo energy spreads over 4× the pixels.
    expect(ring(128)/ring(256)).toBeGreaterThan(3);expect(ring(128)/ring(256)).toBeLessThan(5);
  });
});

describe('light.relight@1 skinProtect',()=>{
  const W=48,H=32;
  // Same synthetic scene as the reference hash, which was computed with the relight code before skinProtect existed.
  const scene=()=>{
    const d=new Float32Array(W*H*4),n=new Float32Array(W*H*3);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;
      const r=x<16?.42:x<32?.08:.18,g=x<16?.22:x<32?.15:.18,b=x<16?.14:x<32?.4:.18,k=.5+.5*y/H;
      d.set([r*k,g*k,b*k,1],i*4);
      const nx=Math.sin((x-24)/10),ny=Math.cos(y/7)*.3,nz=1,l=Math.hypot(nx,ny,nz);n.set(y===5&&x===5?[0,0,0]:[nx/l,ny/l,nz/l],i*3);}
    return {img:{kind:'image',width:W,height:H,data:d,space:'ACEScg'} as ImageBuf,nv:{kind:'vector3',width:W,height:H,data:n} as VectorField};
  };
  const P={azimuth:-60,elevation:25,color:{kelvin:3200},intensity:1.2,softness:.5,mode:'add' as const,preserveHighlights:.6};
  const run=(extra:Record<string,unknown>={})=>{const s=scene();return relightNode.evaluate({image:s.img,normals:s.nv},{...P,...extra} as never,ctx(W,H)) as ImageBuf;};
  it('without the field (and with 0) is bit-identical to the implementation before skinProtect',()=>{
    expect(fnv(run().data)).toBe('f157ecc');
    expect(fnv(run({skinProtect:0}).data)).toBe('f157ecc');
  });
  it('reduces and neutralizes the added light on skin tones only',()=>{
    const s=scene(),off=run(),on=run({skinProtect:1});
    const added=(o:ImageBuf,x:number,y:number)=>px(o,x,y).slice(0,3).map((v,c)=>v-s.img.data[(y*W+x)*4+c]);
    const skinOff=added(off,8,20),skinOn=added(on,8,20);
    expect(skinOn[0]).toBeLessThan(skinOff[0]);
    // The warm light tints less: red/blue ratio of the added light moves toward neutral.
    expect(skinOn[0]/skinOn[2]).toBeLessThan(skinOff[0]/skinOff[2]);
    // Blue patch (not skin) is unchanged.
    expect(px(on,24,20)).toEqual(px(off,24,20));
  });
  it('is validated and set by the prompt ("Hauttöne schützen")',()=>{
    const {graph,understood}=build('warmes Licht von links, Hauttöne schützen');
    expect(node(graph,'light.relight@1')!.params.skinProtect).toBe(1);expect(node(graph,'color.look@1')!.params.look.skinProtect).toBe(1);
    expect(understood.some(u=>u.includes('Hautschutz'))).toBe(true);
    expect(node(build('Licht von links').graph,'light.relight@1')!.params.skinProtect).toBeUndefined();
    const night=build('Nacht, Hautschutz').graph;expect(node(night,'light.relight@1')!.params.skinProtect).toBe(1);
    const g=build('Licht von links').graph;(node(g,'light.relight@1')!.params as unknown as Record<string,unknown>).skinProtect=1.5;
    expect(checkGraph(g).join()).toMatch(/„skinProtect“ muss zwischen 0 und 1/);
  });
});

describe('optics in the prompt',()=>{
  it('recognizes grain, vignette, halation and bloom in German and English',()=>{
    for(const t of ['Filmkorn','35mm-Korn','film grain','grainy','körnig'])expect(types(build(t).graph),t).toContain('film.grain@1');
    for(const t of ['Vignette','vignetting','dunkle Ecken','Randabdunklung'])expect(types(build(t).graph),t).toContain('lens.vignette@1');
    const h=node(build('Halation').graph,'film.halation@1')!;expect(h.params.intensity).toBeGreaterThan(0);expect(h.params.bloom).toBe(0);
    for(const t of ['Bloom','Glow','leichtes Glühen']){const b=node(build(t).graph,'film.halation@1')!;expect(b.params.bloom,t).toBeGreaterThan(0);expect(b.params.intensity,t).toBe(0);}
    // Lamps that glow are practicals, not bloom.
    expect(types(build('Lampen glühen').graph)).not.toContain('film.halation@1');
  });
  it('maps film formats and modifiers to grain size and strength',()=>{
    const size=(t:string)=>node(build(t).graph,'film.grain@1')!.params.size as number,ev=(t:string)=>node(build(t).graph,'film.grain@1')!.params.intensity as number;
    expect(size('35mm-Korn')).toBe(.0007);expect(size('16mm Korn')).toBeGreaterThan(size('35mm Korn'));expect(size('Super 8 Korn')).toBeGreaterThan(size('16mm Korn'));
    expect(size('65mm Korn')).toBeLessThan(size('35mm Korn'));expect(size('feines Korn')).toBeLessThan(size('Korn'));
    expect(ev('starkes Korn')).toBeGreaterThan(ev('Korn'));expect(ev('leichtes Korn')).toBeLessThan(ev('Korn'));
    expect(node(build('monochromes Korn').graph,'film.grain@1')!.params.chroma).toBe(0);
  });
  it('"Kodak-Look mit Korn" keeps the look and adds grain before it',()=>{
    const {graph,understood}=build('Kodak-Look mit Korn');
    expect(types(graph)).toEqual(['color.convert@1','film.grain@1','color.convert@1','color.look@1']);
    expect(understood.some(u=>u.startsWith('Basis: '))).toBe(true);expect(understood.some(u=>u.startsWith('Filmkorn'))).toBe(true);
  });
  it('"Dune-Look, Filmkorn, Vignette, Halation" orders lens before film, all before the look, and renders',()=>{
    const {graph}=build('Dune-Look, Filmkorn, Vignette, Halation');
    expect(types(graph)).toEqual(['color.convert@1','lens.vignette@1','film.halation@1','film.grain@1','color.convert@1','color.look@1']);
    const img=flat(64,36,(x,y)=>[(x/64)**2,(y/36)**2,.3]);img.space='Rec.1886 Rec.709 - Display';
    const r=renderGraph(graph,img,{frame:3,aux:{masks:{}},files:new Map()});
    expect(r.warnings).toEqual([]);expect(r.bypassed).toEqual([]);
    expect(Array.from((r.output as ImageBuf).data).every(Number.isFinite)).toBe(true);
  });
});
