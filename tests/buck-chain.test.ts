import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NEUTRAL_LOOK } from '../src/color/look';
import { NODE_CATALOG, addNode, defaultNode, ensureConversions, ensureInputs, imageChain, isAutoNode, maskNodes, moveNode, removeNode, setMask, uniqueId } from '../src/buck/editor/chain';
import { checkGraph } from '../src/buck/validate';
import { BuckError, LIMITS, PORTS } from '../src/buck/types';
import type { BuckGraph, BuckNode, NodeType } from '../src/buck/types';

// Fake registry so the test does not depend on the depth agent's pins.
vi.mock('../src/buck/depth/models',()=>({
  DEFAULT_DEPTH_MODEL:'fake-rel@1',
  KNOWN_MODELS:{'fake-rel@1':{name:'Testmodell',upstream:'https://example.invalid/model',revision:'abc',license:'Apache-2.0',format:'onnx',opset:17,
    weightsSha256:'0'.repeat(64),output:'relative-inverse',
    preprocess:{longSide:518,multipleOf:14,resize:'bicubic',inputSpace:'sRGB - Texture',mean:[.485,.456,.406],std:[.229,.224,.225]},
    postprocess:{resize:'bilinear-to-source'}}},
}));

const FIXTURE_TEXT=readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8');
const fixture=()=>JSON.parse(FIXTURE_TEXT) as BuckGraph;
const REC709='Rec.1886 Rec.709 - Display';
const base=():BuckGraph=>({format:'buck',formatVersion:'1.0',minReaderVersion:'1.0',meta:{name:'Test'},
  colorManagement:{config:'ofx-native-v1.5_aces-v1.3_ocio-v2.3',input:REC709,output:REC709,working:{linear:'ACEScg',display:REC709}},
  inputs:{},models:{},nodes:[],output:'$source'});
const ALL=Object.keys(PORTS) as NodeType[];
const ids=(g:BuckGraph)=>imageChain(g).map(n=>n.id);
const valid=(g:BuckGraph)=>{expect(checkGraph(g)).toEqual([]);return g;};
const byId=(g:BuckGraph,id:string)=>g.nodes.find(n=>n.id===id)!;
function deepFreeze<T>(v:T):T{if(v&&typeof v==='object'){Object.freeze(v);for(const x of Object.values(v))deepFreeze(x);}return v;}

describe('NODE_CATALOG and defaultNode',()=>{
  it('lists all 14 node types once with German labels',()=>{
    expect(NODE_CATALOG.map(e=>e.type).sort()).toEqual([...ALL].sort());
    for(const e of NODE_CATALOG){expect(e.label.length).toBeGreaterThan(0);expect(e.description.length).toBeGreaterThan(10);}
    expect(NODE_CATALOG.filter(e=>e.group==='Maske')).toHaveLength(7);
  });
  it('uses the fixture values for fog and relight and the requested DOF defaults',()=>{
    const fx=fixture(),fog=defaultNode('atmos.fog@1','f'),rl=defaultNode('light.relight@1','r'),dof=defaultNode('lens.dof@1','d');
    expect(fog.params).toEqual(byId(fx,'fog').params);
    expect(rl.params).toEqual(byId(fx,'warmKey').params);
    expect(dof.params).toMatchObject({mode:'artistic',focus:.3,focusRange:.1,blurNear:.006,blurFar:.012,maxBlur:.02,blades:7});
  });
  it('starts the look neutral and returns independent objects',()=>{
    const a=defaultNode('color.look@1','a'),b=defaultNode('color.look@1','b');
    if(a.type!=='color.look@1'||b.type!=='color.look@1')throw new Error('type');
    expect(a.params.look).toEqual(NEUTRAL_LOOK);
    a.params.look.shadows[0]=.1;expect(b.params.look.shadows[0]).toBe(0);expect(NEUTRAL_LOOK.shadows[0]).toBe(0);
  });
});

describe('fixture',()=>{
  it('is valid and survives ensureConversions + ensureInputs unchanged',()=>{
    const fx=valid(fixture()),round=ensureInputs(ensureConversions(fx));
    expect(round).toEqual(fx);expect(JSON.stringify(round)).toBe(JSON.stringify(fx));
    expect(round.nodes.some(isAutoNode)).toBe(false);
    expect(ids(fx)).toEqual(['toLinear','warmKey','fog','toDisplay','fargo']);
    expect(maskNodes(fx).map(n=>n.id)).toEqual(['nearMask','bgMask']);
  });
});

describe('addNode',()=>{
  it('produces a valid graph for every node type on an empty graph',()=>{
    for(const type of ALL){
      const {graph,id}=addNode(base(),type);valid(graph);
      expect(byId(graph,id).type).toBe(type);
    }
  });
  it('wraps a linear node in minimal auto conversions and declares depth with the default pin',()=>{
    const {graph,id}=addNode(base(),'atmos.fog@1');valid(graph);
    expect(id).toBe('fog');
    expect(ids(graph)).toEqual(['auto-to-acescg','fog','auto-to-rec-1886-rec-709-display']);
    expect(graph.output).toBe('auto-to-rec-1886-rec-709-display');
    expect(Object.keys(graph.inputs)).toEqual(['depth']);
    expect(graph.inputs.depth).toMatchObject({kind:'depth',semantics:'relative-inverse',required:false,normalize:{mode:'shot-percentile',low:2,high:98},onMissing:'bypass-dependents'});
    expect(graph.inputs.depth.sources).toEqual([{type:'host-clip',clip:'Depth'},{type:'cache'},{type:'estimate',model:'fake-rel@1'}]);
    expect(Object.keys(graph.models)).toEqual(['fake-rel@1']);
  });
  it('shares one conversion between adjacent linear nodes',()=>{
    let g=addNode(base(),'atmos.fog@1').graph;g=addNode(g,'lens.dof@1').graph;g=valid(addNode(g,'light.relight@1').graph);
    // Relight belongs to the light level and goes before fog (atmosphere) and DOF (optics).
    expect(ids(g)).toEqual(['auto-to-acescg','relight','fog','dof','auto-to-rec-1886-rec-709-display']);
    expect(Object.keys(g.inputs).sort()).toEqual(['depth','normals']);
    expect(g.inputs.normals.sources[2]).toEqual({type:'derive',method:'normals-from-depth@1',from:'depth',params:{smoothing:.002}});
  });
  it('inserts at the end of the node level (before the display conversion of the grade) and after afterId of the same level',()=>{
    const fx=fixture(),a=valid(addNode(fx,'lens.dof@1').graph);
    expect(ids(a)).toEqual(['toLinear','warmKey','fog','dof','toDisplay','fargo']);
    const b=valid(addNode(fx,'lens.dof@1','fog').graph);
    expect(ids(b)).toEqual(['toLinear','warmKey','fog','dof','toDisplay','fargo']);
    const c=valid(addNode(fx,'color.cdl@1','$source').graph);
    expect(ids(c)[0]).toBe('cdl');
  });
  it('gives unique ids and sets a sensible convert direction',()=>{
    const fx=fixture(),{graph,id}=addNode(fx,'atmos.fog@1','fog');valid(graph);
    expect(id).toBe('fog-2');expect(uniqueId(graph,'fog')).toBe('fog-3');
    const conv=addNode(fx,'color.convert@1','warmKey');valid(conv.graph);
    expect(byId(conv.graph,conv.id).params).toEqual({from:'ACEScg',to:REC709});
  });
  it('feeds combine and refine from existing masks or a neutral helper',()=>{
    const fx=fixture(),c=addNode(fx,'mask.combine@1');valid(c.graph);
    expect(byId(c.graph,c.id).inputs).toEqual({a:'bgMask',b:'nearMask'});
    const r=addNode(fx,'mask.refine@1','nearMask');valid(r.graph);
    expect(byId(r.graph,r.id).inputs).toEqual({mask:'nearMask'});
    const e=addNode(base(),'mask.refine@1');valid(e.graph);
    expect(byId(e.graph,e.id).inputs.mask).toBe('gradientMask');
  });
  it('declares a host mask for mask.input',()=>{
    const {graph}=addNode(base(),'mask.input@1');valid(graph);
    expect(graph.inputs.mask).toEqual({kind:'mask',required:false,sources:[{type:'host-clip',clip:'Mask'}],onMissing:'bypass-dependents'});
  });
  it('refuses to exceed the node limit',()=>{
    let g=base();for(let i=0;i<LIMITS.nodes;i++)g=addNode(g,'color.cdl@1').graph;
    expect(g.nodes).toHaveLength(LIMITS.nodes);valid(g);
    expect(()=>addNode(g,'color.cdl@1')).toThrow(BuckError);
  });
});

describe('removeNode',()=>{
  it('disconnects a removed mask and rewires the chain',()=>{
    const g=valid(removeNode(fixture(),'nearMask'));
    expect(byId(g,'warmKey').inputs).toEqual({image:'toLinear',normals:'$normals'});
    const h=valid(removeNode(fixture(),'warmKey'));
    expect(byId(h,'fog').inputs.image).toBe('toLinear');
    expect(Object.keys(h.inputs)).toEqual(['depth']);
  });
  it('drops depth, normals and models when nothing uses them',()=>{
    let g=fixture();for(const id of ['fog','warmKey','nearMask','bgMask'])g=valid(removeNode(g,id));
    expect(g.inputs).toEqual({});expect(g.models).toEqual({});
    expect(g.fallback).toMatchObject({covers:['fargo'],omits:[]});
    expect(ids(g)).toEqual(['toLinear','toDisplay','fargo']);
  });
  it('filters fallback lists and moves output to the new chain end',()=>{
    const g=valid(removeNode(fixture(),'fargo'));
    expect(g.output).toBe('toDisplay');expect(g.fallback!.covers).toEqual([]);
  });
  it('hands a removed refine mask over to its upstream and removes masks that lose their source',()=>{
    const r=addNode(fixture(),'mask.refine@1','bgMask'),g=setMask(r.graph,'fog',r.id);
    const a=valid(removeNode(g,r.id));expect(byId(a,'fog').inputs.mask).toBeUndefined();
    const ref2=addNode(g,'mask.refine@1',r.id),b=valid(removeNode(ref2.graph,r.id));
    expect(byId(b,ref2.id).inputs.mask).toBe('bgMask');
    const c=valid(removeNode(g,'bgMask'));expect(c.nodes.some(n=>n.id===r.id)).toBe(false);expect(byId(c,'fog').inputs.mask).toBeUndefined();
  });
  it('throws a German error for unknown ids',()=>{expect(()=>removeNode(fixture(),'nix')).toThrow(/Knoten „nix“/);});
});

describe('moveNode',()=>{
  it('reorders with correct conversions and back again',()=>{
    const fx=fixture(),up=valid(moveNode(fx,'fargo',-1));
    expect(ids(up)).toEqual(['toLinear','warmKey','fog','auto-to-rec-1886-rec-709-display','fargo','auto-to-acescg','toDisplay']);
    const conv=(id:string)=>byId(up,id) as Extract<BuckNode,{type:'color.convert@1'}>;
    expect(conv('auto-to-rec-1886-rec-709-display').params).toEqual({from:'ACEScg',to:REC709});
    expect(conv('auto-to-acescg').params).toEqual({from:REC709,to:'ACEScg'});
    expect(moveNode(up,'fargo',1)).toEqual(fx);
  });
  it('moves linear nodes ahead of the linearization with new conversions',()=>{
    const g=valid(moveNode(fixture(),'warmKey',-1));
    expect(ids(g)).toEqual(['auto-to-acescg','warmKey','auto-to-rec-1886-rec-709-display','toLinear','fog','toDisplay','fargo']);
  });
  it('moves masks among masks and keeps group ends',()=>{
    const fx=fixture(),g=valid(moveNode(fx,'bgMask',-1));
    expect(maskNodes(g).map(n=>n.id)).toEqual(['bgMask','nearMask']);
    expect(moveNode(fx,'toLinear',-1)).toBe(fx);expect(moveNode(fx,'fargo',1)).toBe(fx);
  });
});

describe('setMask, ensureConversions edge cases, purity',()=>{
  it('connects and disconnects masks and rejects non-masks',()=>{
    const fx=fixture(),g=valid(setMask(fx,'fog','nearMask'));
    expect(byId(g,'fog').inputs.mask).toBe('nearMask');
    expect(byId(valid(setMask(g,'fog')),'fog').inputs).toEqual({image:'warmKey',depth:'$depth'});
    expect(()=>setMask(fx,'fog','toLinear')).toThrow(BuckError);
    expect(()=>setMask(fx,'nearMask','bgMask')).toThrow(BuckError);
    expect(()=>setMask(fx,'fog','$depth')).toThrow(BuckError);
  });
  it('treats disabled nodes as pass-through and reaches the output space',()=>{
    const fx=fixture(),off={...fx,nodes:fx.nodes.map(n=>n.id==='toDisplay'?{...n,enabled:false}:n)};
    const g=valid(ensureConversions(off));
    expect(ids(g)).toEqual(['toLinear','warmKey','fog','toDisplay','auto-to-rec-1886-rec-709-display','fargo']);
    const srgb=base();srgb.colorManagement.output='sRGB - Display';
    const s=valid(ensureConversions(srgb));expect(ids(s)).toEqual(['auto-to-srgb-display']);
    expect(valid(ensureConversions(base())).output).toBe('$source');
  });
  it('never mutates its input',()=>{
    const fx=deepFreeze(fixture()),before=JSON.stringify(fx);
    let g=addNode(fx,'lens.dof@1').graph;g=moveNode(g,'dof',-1);g=setMask(g,'dof','bgMask');g=removeNode(g,'warmKey');g=ensureInputs(ensureConversions(g));
    addNode(fx,'mask.combine@1');removeNode(fx,'nearMask');moveNode(fx,'fargo',-1);setMask(fx,'fog','nearMask');
    valid(g);expect(JSON.stringify(fx)).toBe(before);
  });
  it('is deterministic',()=>{
    const run=()=>{let g=addNode(fixture(),'lens.dof@1').graph;g=moveNode(g,'dof',-1);return JSON.stringify(removeNode(g,'fog'));};
    expect(run()).toBe(run());
  });
});
