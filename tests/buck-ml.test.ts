import { describe, expect, it } from 'vitest';
import { convertPixel } from '../src/buck/colorspace';
import { readBuck, writeBuck } from '../src/buck/container';
import { targetSize } from '../src/buck/depth/estimate';
import { INPAINT_MODEL, KNOWN_MODELS, SKY_MODEL, SUBJECT_MODEL, depthSemantics } from '../src/buck/depth/models';
import { levelOf } from '../src/buck/editor/chain';
import { fillDepthHole } from '../src/buck/ml/fill';
import { PLATE_INPUT, SKY_INPUT, SUBJECT_INPUT, analysisImage, inpaintNodeOf, withInpaint, withSkyMask, withSubjectMask, withoutInpaint } from '../src/buck/editor/ml';
import { imageBuf, scalarField } from '../src/buck/field';
import { holeFromMask } from '../src/buck/ml/run';
import { skyNode, skyPresetParams } from '../src/buck/nodes/sky';
import { applyTimeOfDay, promptToGraph } from '../src/buck/prompt';
import { renderGraph } from '../src/buck/render';
import { checkGraph } from '../src/buck/validate';
import type { BuckGraph, ImageBuf, RenderContext, Resolved, SkyParams } from '../src/buck/types';

const ctx=(w:number,h:number):RenderContext=>({width:w,height:h,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}});
const night=(g:BuckGraph)=>g.nodes.find(n=>n.type==='sky.replace@1');
const base=()=>promptToGraph('Nacht').graph;

describe('model pins for segmentation and inpainting',()=>{
  it('are pinned, validate inside a graph and are no depth models',()=>{
    for(const id of [SKY_MODEL,SUBJECT_MODEL,INPAINT_MODEL]){
      const pin=KNOWN_MODELS[id];
      expect(pin.weightsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(()=>depthSemantics(pin)).toThrow();
    }
    const g=withInpaint(withSkyMask(base()));
    expect(checkGraph(g)).toEqual([]);
    expect(Object.keys(g.models).sort()).toEqual([...new Set([SKY_MODEL,SUBJECT_MODEL,INPAINT_MODEL,...Object.keys(g.models)])].sort());
  });
  it('size the model input by fit: stretch to a square, native keeps the source',()=>{
    expect(targetSize(1600,905,KNOWN_MODELS[SKY_MODEL])).toEqual({width:320,height:320});
    expect(targetSize(1600,905,KNOWN_MODELS[SUBJECT_MODEL])).toEqual({width:1024,height:1024});
    expect(targetSize(1600,905,KNOWN_MODELS['birefnet-lite@1'])).toEqual({width:1024,height:1024});
    expect(targetSize(1600,905,KNOWN_MODELS[INPAINT_MODEL])).toEqual({width:1600,height:905});
  });
});

describe('validator rules for mask and image inputs',()=>{
  it('rejects a depth model on a mask input, a plate without hole and a constant plate',()=>{
    const g=withInpaint(base());
    const wrong=structuredClone(g);wrong.inputs[SUBJECT_INPUT].sources=[{type:'estimate',model:SKY_MODEL},{type:'estimate',model:'da2-small-rel@1'}];
    wrong.models['da2-small-rel@1']=KNOWN_MODELS['da2-small-rel@1'];
    expect(checkGraph(wrong).join(' ')).toMatch(/passt nicht zu einer Eingabe der Art „mask“/);
    const noHole=structuredClone(g);noHole.inputs[PLATE_INPUT].sources=[{type:'estimate',model:INPAINT_MODEL}];
    expect(checkGraph(noHole).join(' ')).toMatch(/hole/);
    const constant=structuredClone(g);constant.inputs[PLATE_INPUT].onMissing='constant';
    expect(checkGraph(constant).join(' ')).toMatch(/keinen sinnvollen Ersatzwert/);
    const badHole=structuredClone(g);(badHole.inputs[PLATE_INPUT].sources[1] as {hole:{input:string}}).hole.input='depth';
    expect(checkGraph(badHole).join(' ')).toMatch(/Masken-Eingabe/);
  });
});

describe('sky.replace@1 with a sky segmentation',()=>{
  it('uses the sky port instead of depth (≥ 0.5 is sky) and needs one of the two',()=>{
    const w=32,h=16,img=imageBuf(w,h,'ACEScg');img.data.fill(.3);for(let i=3;i<img.data.length;i+=4)img.data[i]=1;
    const sky=scalarField(w,h),deep=scalarField(w,h);for(let i=0;i<w*h;i++){sky.data[i]=i<w*6?.9:.1;deep.data[i]=.3;}
    const p={...skyPresetParams('night','ACEScg'),spill:0} as Resolved<SkyParams>;
    const out=skyNode.evaluate({image:img,depth:deep,sky},p,ctx(w,h)) as ImageBuf;
    expect(out.data[2*w*4]).not.toBeCloseTo(.3,3);expect(out.data[(12*w)*4]).toBeCloseTo(.3,6);
    expect(()=>skyNode.evaluate({image:img},p,ctx(w,h))).toThrow(/Weder Tiefe noch Himmelsmaske/);
  });
});

describe('editor helpers (editor/ml.ts)',()=>{
  it('connect $sky to every sky node, also to ones added later',()=>{
    const g=withSkyMask(base());
    expect(night(g)?.inputs.sky).toBe(`$${SKY_INPUT}`);expect(checkGraph(g)).toEqual([]);
    expect(g.inputs[SKY_INPUT].sources.some(s=>s.type==='estimate'&&s.model===SKY_MODEL)).toBe(true);
  });
  it('declare the subject model that actually ran and keep it through the inpainting step',()=>{
    const model=(g:BuckGraph)=>g.inputs[SUBJECT_INPUT].sources.flatMap(s=>s.type==='estimate'?[s.model]:[]);
    expect(model(withSubjectMask(base()))).toEqual([SUBJECT_MODEL]);
    const bi=withSubjectMask(withSubjectMask(base()),'birefnet-lite@1');
    expect(model(bi)).toEqual(['birefnet-lite@1']);expect(checkGraph(bi)).toEqual([]);
    expect(bi.models[SUBJECT_MODEL]).toBeUndefined();expect(bi.models['birefnet-lite@1']).toBeDefined();
    expect(model(withInpaint(bi))).toEqual(['birefnet-lite@1']);
  });
  it('add and remove the inpainting step with matching grow',()=>{
    const g=withInpaint(base(),.01),node=inpaintNodeOf(g)!;
    expect(node.inputs.plate).toBe(`$${PLATE_INPUT}`);
    const refine=g.nodes.find(n=>n.id===node.inputs.mask);
    expect(refine?.type).toBe('mask.refine@1');expect(refine?.params).toMatchObject({grow:.01});
    expect(g.inputs[PLATE_INPUT].sources).toContainEqual({type:'estimate',model:INPAINT_MODEL,hole:{input:SUBJECT_INPUT,grow:.01}});
    expect(checkGraph(g)).toEqual([]);
    // Replacing keeps a single step; removing drops node, masks and plate but keeps $subject.
    expect(withInpaint(g).nodes.filter(n=>n.type==='fill.inpaint@1')).toHaveLength(1);
    const back=withoutInpaint(g);
    expect(inpaintNodeOf(back)).toBeUndefined();expect(back.inputs[PLATE_INPUT]).toBeUndefined();expect(back.inputs[SUBJECT_INPUT]).toBeDefined();
    expect(back.nodes.some(n=>n.type==='mask.refine@1'||n.type==='mask.input@1')).toBe(false);
    expect(checkGraph(back)).toEqual([]);
    expect(checkGraph(withSubjectMask(base()))).toEqual([]);
  });
});

describe('fill.inpaint@1 through renderGraph',()=>{
  it('shows the plate inside the subject mask and the source elsewhere; without plate it is bypassed',()=>{
    const w=24,h=12,g=withInpaint({...base(),nodes:[],output:'$source'},0);
    const src=imageBuf(w,h,g.colorManagement.input);src.data.fill(.2);for(let i=3;i<src.data.length;i+=4)src.data[i]=1;
    const plate=imageBuf(w,h,'sRGB - Display');plate.data.fill(.8);for(let i=3;i<plate.data.length;i+=4)plate.data[i]=1;
    const subject=scalarField(w,h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)subject.data[y*w+x]=x>=8&&x<16?1:0;
    const r=renderGraph(g,src,{frame:0,aux:{masks:{[SUBJECT_INPUT]:subject},images:{[PLATE_INPUT]:plate}},files:new Map()});
    const out=r.output as ImageBuf,px=(x:number)=>out.data[(6*w+x)*4];
    // The sRGB plate reaches the Rec.1886 output through the working space: compare against the same conversion.
    expect(px(12)).toBeCloseTo(convertPixel([.8,.8,.8],'sRGB - Display',g.colorManagement.output)[0],4);expect(px(2)).toBeCloseTo(.2,4);
    const missing=renderGraph(g,src,{frame:0,aux:{masks:{[SUBJECT_INPUT]:subject}},files:new Map()});
    expect(missing.bypassed).toContain(inpaintNodeOf(g)!.id);
  });
});

describe('retouching comes first',()=>{
  it('stays before the night exposure, in whichever order the steps are added',()=>{
    const firstImage=(g:BuckGraph)=>g.nodes.filter(n=>n.type==='fill.inpaint@1'||n.type==='color.cdl@1').map(n=>n.type);
    expect(firstImage(withInpaint(base()))[0]).toBe('fill.inpaint@1');
    const later=applyTimeOfDay(withInpaint(promptToGraph('Fargo-Look').graph),'night').graph;
    expect(firstImage(later)[0]).toBe('fill.inpaint@1');expect(checkGraph(later)).toEqual([]);
    expect(levelOf(inpaintNodeOf(later)!)).toBe('light');
  });
  it('analysis uses the plate when there is one',()=>{
    const src=imageBuf(2,2,'ACEScg'),plate=imageBuf(2,2,'sRGB - Display');
    expect(analysisImage({masks:{}},src)).toBe(src);expect(analysisImage({masks:{},images:{[PLATE_INPUT]:plate}},src)).toBe(plate);
  });
});

describe('fillDepthHole',()=>{
  it('fills from the surroundings, keeps everything else and marks sky surroundings as invalid',()=>{
    // Upper half sky (Inf), lower half depth 0.4; a figure (depth 0.1) in the middle column is the hole.
    const w=21,h=20,d=scalarField(w,h),hole=scalarField(w,h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,fig=x>=9&&x<12&&y>=2&&y<18;d.data[i]=fig?.1:y<10?Infinity:.4;hole.data[i]=fig?1:0;}
    const o=fillDepthHole(d,hole).data;
    expect(o[3*w+10]).toBe(Infinity);expect(o[16*w+10]).toBeCloseTo(.4,5);
    expect(o[16*w+2]).toBeCloseTo(.4,5);expect(o[3*w+2]).toBe(Infinity);
    for(let i=0;i<o.length;i++)expect(o[i]).not.toBeCloseTo(.1,5);
  });
});

describe('.buck with sky, subject and plate',()=>{
  it('survives writing and reading unchanged',async()=>{
    const g=withInpaint(withSkyMask(base()));
    const back=await readBuck(await writeBuck(g,new Map()));
    expect(back.graph.inputs).toEqual(g.inputs);expect(back.graph.models).toEqual(g.models);expect(back.graph.nodes).toEqual(g.nodes);
  });
});

describe('holeFromMask',()=>{
  it('thresholds at 0.5 and grows by the given image widths',()=>{
    const m=scalarField(20,5);m.data[2*20+10]=.6;m.data[2*20+3]=.4;
    const h=holeFromMask(m,.1);
    expect(h.data[2*20+10]).toBe(1);expect(h.data[2*20+8]).toBe(1);expect(h.data[2*20+12]).toBe(1);expect(h.data[2*20+7]).toBe(0);expect(h.data[2*20+3]).toBe(0);
  });
});
