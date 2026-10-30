import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalsFromDepth } from '../src/buck/aux/normals';
import { imageBuf, scalarField, vectorField } from '../src/buck/field';
import { missingInputs, prepareAux, renderGraph } from '../src/buck/render';
import { BuckError } from '../src/buck/types';
import type { AuxChannels, Buf, BuckGraph, BuckNode, ImageBuf, InputDecl, NodeImpl, NodeType, ScalarField, SpaceName, VectorField } from '../src/buck/types';

// The default registry is replaced by an empty one so these tests only exercise render.ts with injected fakes.
vi.mock('../src/buck/nodes/index',()=>({NODE_IMPLS:{}}));

const W=4,H=3,N=W*H;
const calls:string[]=[];
const scal=(b:Buf|undefined)=>b as ScalarField;
const img=(b:Buf|undefined)=>b as ImageBuf;
function source(space:SpaceName='ACEScg'):ImageBuf {
  const s=imageBuf(W,H,space);
  for(let i=0;i<N;i++){s.data[i*4]=i/N;s.data[i*4+1]=0.5;s.data[i*4+2]=1-i/N;s.data[i*4+3]=0.25+i/(4*N);}
  return s;
}
const field=(v:number|((i:number)=>number),w=W,h=H)=>{const f=scalarField(w,h);for(let i=0;i<w*h;i++)f.data[i]=typeof v==='number'?v:v(i);return f;};
function mapImage(b:ImageBuf,fn:(c:number,i:number,ch:number)=>number,space=b.space,alpha?:number):ImageBuf {
  const o=imageBuf(b.width,b.height,space);
  for(let i=0;i<b.width*b.height;i++){for(let c=0;c<3;c++)o.data[i*4+c]=fn(b.data[i*4+c],i,c);o.data[i*4+3]=alpha??b.data[i*4+3];}
  return o;
}
/** Fakes: simple, exactly predictable math per type. Each call is logged with its node type. */
const FAKES:Partial<Record<NodeType,NodeImpl>>={
  'color.cdl@1':{type:'color.cdl@1',evaluate(i){calls.push('cdl');return mapImage(img(i.image),v=>v*2,undefined,0);}},
  'color.convert@1':{type:'color.convert@1',evaluate(i,p){calls.push('convert');return mapImage(img(i.image),v=>v+1,(p as {to:SpaceName}).to,9);}},
  'atmos.fog@1':{type:'atmos.fog@1',evaluate(i,p){calls.push('fog');const d=scal(i.depth),k=(p as {density:number}).density;return mapImage(img(i.image),(v,px)=>v+k*d.data[px]);}},
  'light.relight@1':{type:'light.relight@1',evaluate(i){calls.push(i.depth?'relight+depth':'relight');const n=i.normals as VectorField;return mapImage(img(i.image),(v,px)=>v+n.data[px*3+2]);}},
  'mask.depthRange@1':{type:'mask.depthRange@1',evaluate(i){calls.push('depthRange');return scalarField(W,H,new Float32Array(scal(i.depth).data));}},
  'mask.gradient@1':{type:'mask.gradient@1',evaluate(_i,_p,ctx){calls.push('gradient');return field(0.5,ctx.width,ctx.height);}},
  'mask.refine@1':{type:'mask.refine@1',evaluate(i){calls.push('refine');return field(px=>scal(i.mask).data[px]*0.5);}},
  'mask.input@1':{type:'mask.input@1',evaluate(_i,p,ctx){calls.push('input');return ctx.aux.masks[(p as {input:string}).input.replace(/^\$/,'')];}},
};
const depthDecl=(onMissing:InputDecl['onMissing']='bypass-dependents'):InputDecl=>({kind:'depth',semantics:'relative-depth',required:false,sources:[{type:'cache'}],onMissing});
const normalsDecl:InputDecl={kind:'normals',frame:'camera',required:false,sources:[{type:'cache'},{type:'derive',method:'normals-from-depth@1',from:'depth',params:{smoothing:0}}],onMissing:'bypass-dependents'};
const cdlParams={slope:[1,1,1],offset:[0,0,0],power:[1,1,1],saturation:1,style:'noClampFwd',space:'ACEScg'} as const;
const fogParams={model:'exponential',start:0,density:1,color:[1,1,1],luminance:0,maxOpacity:1,skyProtect:0} as const;
const relightParams={azimuth:0,elevation:0,color:[1,1,1],intensity:0,softness:0,mode:'add',preserveHighlights:0} as const;
const range={near:0,far:1,feather:0.1,invert:false};
function graph(nodes:unknown[],output:string,inputs:Record<string,InputDecl>={},space:SpaceName='ACEScg'):BuckGraph {
  return {format:'buck',formatVersion:'1.0',minReaderVersion:'1.0',meta:{name:'Test'},
    colorManagement:{config:'ofx-native-v1.5_aces-v1.3_ocio-v2.3',input:space,output:space,working:{linear:'ACEScg',display:'Rec.1886 Rec.709 - Display'}},
    inputs,models:{},nodes:nodes as BuckNode[],output};
}
const noAux:AuxChannels={masks:{}};
const run=(g:BuckGraph,o:Partial<Parameters<typeof renderGraph>[2]>={},src=source(g.colorManagement.input))=>{calls.length=0;return renderGraph(g,src,{frame:0,aux:noAux,files:new Map(),registry:FAKES,...o});};

describe('renderGraph: evaluation order and mixing', () => {
  it('evaluates only nodes the output needs, in topological order (lowest array index among ready nodes)', () => {
    const g=graph([
      {id:'b',type:'color.cdl@1',inputs:{image:'a'},params:cdlParams},
      {id:'unused',type:'mask.gradient@1',inputs:{},params:{shape:'linear',feather:0,invert:false}},
      {id:'a',type:'color.cdl@1',inputs:{image:'$source'},params:cdlParams},
      {id:'m',type:'mask.gradient@1',inputs:{},params:{shape:'linear',feather:0,invert:false}},
      {id:'c',type:'color.cdl@1',inputs:{image:'b',mask:'m'},params:cdlParams},
    ],'c');
    const r=run(g),src=source();
    // Ready order: a (index 2) unlocks b (index 0), which is picked before m (index 3).
    expect(calls).toEqual(['cdl','cdl','gradient','cdl']);
    for(let i=0;i<N;i++){
      // a, b: ×2 each; c: mix(x4, x8, 0.5) = x6. Alpha always from the input.
      expect(img(r.output).data[i*4]).toBeCloseTo(src.data[i*4]*6,6);
      expect(img(r.output).data[i*4+3]).toBe(src.data[i*4+3]);
    }
    expect(r.bypassed).toEqual([]);expect(r.warnings).toEqual([]);
  });
  it('mixes per pixel with clamp(mask)·amount, NaN mask counting as 0', () => {
    const vals=[-1,0,0.25,1,2,Number.NaN,0.5,0.5,0.5,0.5,0.5,0.5];
    const g=graph([{id:'m',type:'mask.input@1',inputs:{},params:{input:'$sel',channel:'r'}},{id:'c',type:'color.cdl@1',inputs:{image:'$source',mask:'m'},params:cdlParams,amount:0.5}],'c',
      {sel:{kind:'mask',required:false,sources:[{type:'host-clip',clip:'Mask'}],onMissing:'bypass-dependents'}});
    const r=run(g,{aux:{masks:{sel:field(i=>vals[i])}}}),src=source(),o=img(r.output).data;
    for(let i=0;i<N;i++){
      const m=Number.isNaN(vals[i])?0:Math.min(1,Math.max(0,vals[i])),w=m*0.5,x=src.data[i*4];
      expect(o[i*4]).toBeCloseTo(x+(2*x-x)*w,6);expect(o[i*4+3]).toBe(src.data[i*4+3]);
    }
  });
  it('resolves amount and params keyframes at the requested frame', () => {
    const g=graph([{id:'f',type:'atmos.fog@1',inputs:{image:'$source',depth:'$depth'},params:{...fogParams,density:{keys:[[0,0],[10,2]],interp:'linear'}},amount:{keys:[[0,0],[10,1]],interp:'linear'}}],'f',{depth:depthDecl()});
    const aux={masks:{},depth:field(0.5)},src=source();
    const r=run(g,{frame:5,aux});
    // density 1 → effect = x + 0.5, amount 0.5 → x + 0.25.
    for(let i=0;i<N;i++)expect(img(r.output).data[i*4+1]).toBeCloseTo(src.data[i*4+1]+0.25,6);
    expect(run(g,{frame:0,aux}).output.data).toEqual(src.data);
    expect(calls).toEqual([]);
  });
  it('does not mix color.convert and warns when amount or a mask is set', () => {
    const g=graph([{id:'m',type:'mask.gradient@1',inputs:{},params:{shape:'linear',feather:0,invert:false}},{id:'cv',type:'color.convert@1',inputs:{image:'$source',mask:'m'},params:{from:'ACEScg',to:'lin_rec709_srgb'},amount:0.3}],'cv');
    const r=run(g),src=source(),o=img(r.output);
    expect(o.space).toBe('lin_rec709_srgb');
    for(let i=0;i<N;i++){expect(o.data[i*4]).toBeCloseTo(src.data[i*4]+1,6);expect(o.data[i*4+3]).toBe(src.data[i*4+3]);}
    expect(r.warnings.some(w=>w.startsWith('cv:')&&w.includes('nicht gemischt'))).toBe(true);
    expect(r.warnings.some(w=>w.includes('deklariert ist „ACEScg“'))).toBe(true);
  });
  it('registry entries replace implementations and renders are deterministic', () => {
    const g=graph([{id:'c',type:'color.cdl@1',inputs:{image:'$source'},params:cdlParams}],'c');
    const other:NodeImpl={type:'color.cdl@1',evaluate(i){return mapImage(img(i.image),v=>v-1);}};
    const r=run(g,{registry:{...FAKES,'color.cdl@1':other}});
    expect(img(r.output).data[4]).toBeCloseTo(source().data[4]-1,6);
    expect(run(g).output.data).toEqual(run(g).output.data);
  });
  it('can render an intermediate node or a declared input as target', () => {
    const g=graph([{id:'m',type:'mask.depthRange@1',inputs:{depth:'$depth'},params:range},{id:'f',type:'atmos.fog@1',inputs:{image:'$source',depth:'$depth',mask:'m'},params:fogParams}],'f',{depth:depthDecl()});
    const aux={masks:{},depth:field(i=>i/N)},r=run(g,{aux,target:'m'});
    expect(r.output.kind).toBe('scalar');expect(Array.from(r.output.data)).toEqual(Array.from(aux.depth.data));
    expect(calls).toEqual(['depthRange']);
    const d=run(g,{aux,target:'$depth'}).output;
    expect(d.data).toEqual(aux.depth.data);expect(d.data).not.toBe(aux.depth.data);
    const s=run(g,{target:'$source'}).output;expect(s.data).toEqual(source().data);
  });
});

describe('renderGraph: missing inputs (spec §6.1)', () => {
  const chain=(onMissing:InputDecl['onMissing'])=>graph([
    {id:'near',type:'mask.depthRange@1',inputs:{depth:'$depth'},params:range},
    {id:'refined',type:'mask.refine@1',inputs:{mask:'near'},params:{blur:0,grow:0,gamma:1}},
    {id:'c',type:'color.cdl@1',inputs:{image:'$source',mask:'refined'},params:cdlParams},
    {id:'fog',type:'atmos.fog@1',inputs:{image:'c',depth:'$depth'},params:fogParams},
    {id:'d',type:'color.cdl@1',inputs:{image:'fog'},params:cdlParams},
  ],'d',{depth:depthDecl(onMissing)});
  it('bypass-dependents: masks become missing, image nodes depending on them are bypassed', () => {
    const r=run(chain('bypass-dependents')),src=source();
    expect(r.bypassed).toEqual(['near','refined','c','fog']);
    expect(calls).toEqual(['cdl']);
    for(let i=0;i<N;i++)expect(img(r.output).data[i*4]).toBeCloseTo(src.data[i*4]*2,6);
    expect(r.warnings).toContain('Eingabe „$depth“ fehlt; abhängige Knoten werden überbrückt.');
  });
  it('fail: throws a BuckError, unless the dependent nodes are switched off', () => {
    expect(()=>run(chain('fail'))).toThrow(BuckError);
    expect(()=>run(chain('fail'))).toThrow(/„\$depth“ fehlt/);
    const g=chain('fail');
    const off=run(g,{forceBypass:['c','fog']});
    expect(off.bypassed).toEqual(['c','fog']);
    expect(calls).toEqual(['cdl']);
  });
  it('constant: depth 1 with a warning', () => {
    const r=run(chain('constant')),src=source();
    expect(r.bypassed).toEqual([]);
    // c: mask = refine(depth 1) = 0.5 → x·1.5; fog: + 1; d: ×2.
    for(let i=0;i<N;i++)expect(img(r.output).data[i*4]).toBeCloseTo((src.data[i*4]*1.5+1)*2,5);
    expect(r.warnings.some(w=>w.includes('konstanter Ersatzwert'))).toBe(true);
  });
  it('an optional non-mask port that is missing stays empty instead of bypassing', () => {
    const g=graph([{id:'rl',type:'light.relight@1',inputs:{image:'$source',normals:'$normals',depth:'$depth'},params:relightParams}],'rl',{depth:depthDecl(),normals:{...normalsDecl,sources:[{type:'cache'}]}});
    const n=vectorField(W,H);for(let i=0;i<N;i++)n.data[i*3+2]=1;
    const r=run(g,{aux:{masks:{},normals:n}});
    expect(calls).toEqual(['relight']);expect(r.bypassed).toEqual([]);
    expect(run(g,{aux:{masks:{},normals:n,depth:field(0.3)}}).bypassed).toEqual([]);
    expect(calls).toEqual(['relight+depth']);
  });
  it('a missing declared mask behind mask.input bypasses its dependents', () => {
    const g=graph([{id:'m',type:'mask.input@1',inputs:{},params:{input:'$subject',channel:'r'}},{id:'c',type:'color.cdl@1',inputs:{image:'$source',mask:'m'},params:cdlParams}],'c',
      {subject:{kind:'mask',required:false,sources:[{type:'host-clip',clip:'Mask'}],onMissing:'bypass-dependents'}});
    const r=run(g);
    expect(r.bypassed).toEqual(['m','c']);expect(calls).toEqual([]);expect(r.output.data).toEqual(source().data);
  });
  it('a missing target node renders as an empty field with a warning', () => {
    const r=run(chain('bypass-dependents'),{target:'near'});
    expect(r.output.kind).toBe('scalar');expect(Array.from(r.output.data).every(v=>v===0)).toBe(true);
    expect(r.warnings.some(w=>w.includes('„near“ ist wegen fehlender Eingaben leer'))).toBe(true);
  });
  it('missingInputs lists declared inputs without any source; derive counts when its depth exists', () => {
    const g=graph([],'$source',{depth:depthDecl(),normals:normalsDecl,subject:{kind:'mask',required:false,sources:[],onMissing:'constant'}});
    expect(missingInputs(g,noAux)).toEqual(['depth','normals','subject']);
    expect(missingInputs(g,{masks:{},depth:field(0.5)})).toEqual(['subject']);
    expect(missingInputs(g,{masks:{subject:field(1)},normals:vectorField(W,H)})).toEqual(['depth']);
  });
});

describe('renderGraph: bypass, unknown nodes and space rules', () => {
  it('enabled:false and forceBypass pass the image through; disabled masks give 0, disabled refine passes its mask', () => {
    const g=graph([
      {id:'m',type:'mask.gradient@1',inputs:{},params:{shape:'linear',feather:0,invert:false}},
      {id:'r',type:'mask.refine@1',inputs:{mask:'m'},params:{blur:0,grow:0,gamma:1},enabled:false},
      {id:'a',type:'color.cdl@1',inputs:{image:'$source',mask:'r'},params:cdlParams},
      {id:'b',type:'color.cdl@1',inputs:{image:'a'},params:cdlParams,enabled:false},
    ],'b');
    const src=source(),r=run(g);
    expect(r.bypassed).toEqual(['r','b']);expect(calls).toEqual(['gradient','cdl']);
    for(let i=0;i<N;i++)expect(img(r.output).data[i*4]).toBeCloseTo(src.data[i*4]*1.5,6);
    const f=run(g,{forceBypass:['a']});
    expect(f.bypassed).toEqual(['a','b']);expect(calls).toEqual([]);expect(f.output.data).toEqual(src.data);
    const z=run({...g,nodes:g.nodes.map(n=>n.id==='m'?{...n,enabled:false}:n.id==='r'?{...n,enabled:true}:n)});
    expect(z.output.data).toEqual(src.data);expect(calls).toEqual(['refine','cdl']);
  });
  it('unknown optional nodes are bypassed with a warning, unknown required nodes refuse the render', () => {
    const unknown={id:'x',type:'fx.glow@3',inputs:{image:'$source'},params:{},optional:true};
    const g=graph([unknown,{id:'c',type:'color.cdl@1',inputs:{image:'x'},params:cdlParams}],'c');
    const r=run(g);
    expect(r.bypassed).toEqual(['x']);expect(r.warnings.some(w=>w.includes('fx.glow@3'))).toBe(true);
    expect(img(r.output).data[0]).toBeCloseTo(source().data[0]*2,6);
    expect(()=>run(graph([{...unknown,optional:false}],'x'))).toThrow(/nicht optional/);
  });
  it('enforces the source space and linear-only nodes', () => {
    const g=graph([{id:'f',type:'atmos.fog@1',inputs:{image:'$source',depth:'$depth'},params:fogParams}],'f',{depth:depthDecl()},'Rec.1886 Rec.709 - Display');
    expect(()=>run(g,{aux:{masks:{},depth:field(0.5)}})).toThrow(/linearen Arbeitsraum/);
    expect(()=>run(g,{},source('ACEScg'))).toThrow(/colorManagement.input/);
  });
  it('rejects wrong port kinds, unknown refs and unknown ports', () => {
    const bad=graph([{id:'f',type:'atmos.fog@1',inputs:{image:'$source',depth:'$normals'},params:fogParams}],'f',{normals:normalsDecl});
    const n=vectorField(W,H);
    expect(()=>run(bad,{aux:{masks:{},normals:n}})).toThrow(/erwartet ein Skalarfeld/);
    expect(()=>run(graph([{id:'c',type:'color.cdl@1',inputs:{image:'nope'},params:cdlParams}],'c'))).toThrow(/nennt keinen Knoten/);
    expect(()=>run(graph([{id:'c',type:'color.cdl@1',inputs:{image:'$nope'},params:cdlParams}],'c'))).toThrow(/keine deklarierte Eingabe/);
    expect(()=>run(graph([{id:'c',type:'color.cdl@1',inputs:{image:'$source',extra:'$source'},params:cdlParams}],'c'))).toThrow(/keinen Eingang „extra“/);
  });
  it('rejects node results of the wrong size and wraps node errors with the node id', () => {
    const g=graph([{id:'c',type:'color.cdl@1',inputs:{image:'$source'},params:cdlParams}],'c');
    expect(()=>run(g,{registry:{'color.cdl@1':{type:'color.cdl@1',evaluate:()=>imageBuf(1,1,'ACEScg')}}})).toThrow(/keinen gültigen Puffer/);
    expect(()=>run(g,{registry:{'color.cdl@1':{type:'color.cdl@1',evaluate:()=>{throw new Error('kaputt');}}}})).toThrow('Knoten „c“: kaputt');
  });
});

describe('prepareAux', () => {
  it('resamples depth without letting +Infinity turn into NaN, and normals to unit length', () => {
    const d=scalarField(2,1,new Float32Array([0.2,Infinity])),n=vectorField(2,1,new Float32Array([1,0,0,0,0,1]));
    const g=graph([],'$source',{depth:depthDecl(),normals:normalsDecl});
    const a=prepareAux(g,{masks:{m:field(i=>i,2,1)},depth:d,normals:n},8,2);
    expect(a.depth?.width).toBe(8);expect(a.depth?.height).toBe(2);
    const dv=Array.from(a.depth!.data);
    expect(dv.every(v=>v===Infinity||Number.isFinite(v))).toBe(true);
    expect(dv.slice(0,4).every(v=>Math.abs(v-0.2)<1e-6)).toBe(true);expect(dv.slice(4,8).every(v=>v===Infinity)).toBe(true);
    for(let i=0;i<16;i++){const x=a.normals!.data[i*3],z=a.normals!.data[i*3+2];expect(Math.hypot(x,a.normals!.data[i*3+1],z)).toBeCloseTo(1,5);}
    expect(a.masks.m.width).toBe(8);expect(a.masks.m.data[0]).toBe(0);expect(a.masks.m.data[7]).toBe(1);
  });
  it('derives missing normals from depth and fills constants', () => {
    const g=graph([],'$source',{depth:depthDecl(),normals:normalsDecl});
    const depth=field(i=>(i%W)/W),a=prepareAux(g,{masks:{},depth},W,H);
    expect(a.depth).toBe(depth);
    expect(Array.from(a.normals!.data)).toEqual(Array.from(normalsFromDepth(depth,0).data));
    expect(prepareAux(g,noAux,W,H).normals).toBeUndefined();
    const c=prepareAux(graph([],'$source',{depth:depthDecl('constant'),normals:{...normalsDecl,onMissing:'constant'},sel:{kind:'mask',required:false,sources:[],onMissing:'constant'}}),noAux,W,H);
    expect(Array.from(c.depth!.data).every(v=>v===1)).toBe(true);
    expect(Array.from(c.normals!.data.slice(0,3))).toEqual([0,0,1]);
    expect(Array.from(c.masks.sel.data).every(v=>v===1)).toBe(true);
  });
  it('rejects aux buffers of inconsistent size', () => {
    expect(()=>prepareAux(graph([],'$source'),{masks:{},depth:{kind:'scalar',width:3,height:3,data:new Float32Array(4)}},W,H)).toThrow(BuckError);
  });
});

describe('renderGraph: fixture integration', () => {
  it('renders the §13 example with constant depth through the real nodes', async ctx => {
    let real:Partial<Record<NodeType,NodeImpl>>;
    try{real=(await vi.importActual<typeof import('../src/buck/nodes/index')>('../src/buck/nodes/index')).NODE_IMPLS;}catch{ctx.skip();return;}
    const g=JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8')) as BuckGraph;
    const w=16,h=9,src=imageBuf(w,h,'Rec.1886 Rec.709 - Display');
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;src.data[i]=x/(w-1);src.data[i+1]=y/(h-1);src.data[i+2]=0.4;src.data[i+3]=1;}
    const depth=scalarField(w,h,new Float32Array(w*h).fill(0.8));
    const opts={frame:0,aux:{masks:{},depth},files:new Map<string,Uint8Array>(),registry:real};
    const r=renderGraph(g,src,opts);
    expect(r.bypassed).toEqual([]);
    expect(r.output.kind).toBe('image');expect(img(r.output).space).toBe('Rec.1886 Rec.709 - Display');
    expect(Array.from(r.output.data).every(Number.isFinite)).toBe(true);
    expect(r.output.data).toEqual(renderGraph(g,src,opts).output.data);
    // Without depth §13 says relight, fog and both masks are bypassed and only the look remains.
    const noDepth=renderGraph(g,src,{...opts,aux:{masks:{}}});
    expect(noDepth.bypassed).toEqual(['nearMask','warmKey','bgMask','fog']);
    const lookOnly=renderGraph(g,src,{...opts,forceBypass:['warmKey','fog']});
    expect(noDepth.output.data).toEqual(lookOnly.output.data);
    let diff=0;for(let i=0;i<r.output.data.length;i++)diff=Math.max(diff,Math.abs(r.output.data[i]-noDepth.output.data[i]));
    expect(diff).toBeGreaterThan(1e-3);
  });
});
