import { describe, expect, it } from 'vitest';
import { handleJob, previewOf, scalarToGray, vectorToRgb8 } from '../src/buck/render.worker';
import type { RenderDone, RenderFailed, RenderJob } from '../src/buck/render.worker';
import { bakedLutPath, renderFiles, thumbSize, viewTarget } from '../src/buck/editor/useBuckRender';
import { imageBuf, scalarField, vectorField } from '../src/buck/field';
import { BuckError } from '../src/buck/types';
import type { BuckGraph, BuckNode } from '../src/buck/types';

const CM={config:'ofx-native-v1.5_aces-v1.3_ocio-v2.3',input:'sRGB - Display' as const,output:'sRGB - Display' as const,working:{linear:'ACEScg' as const,display:'sRGB - Display' as const}};
function graph(nodes:BuckNode[],output:string):BuckGraph {
  return {format:'buck',formatVersion:'1.0',minReaderVersion:'1.0',meta:{name:'Test'},colorManagement:CM,inputs:{},models:{},nodes,output};
}
const identity=graph([{id:'id',type:'color.convert@1',inputs:{image:'$source'},params:{from:'sRGB - Display',to:'sRGB - Display'}}],'id');
const job=(over:Partial<RenderJob>={}):RenderJob=>({jobId:7,graph:identity,source:{width:2,height:1,data:new Float32Array([.5,0,1,1,.25,.75,0,1]),space:'sRGB - Display'},aux:{masks:{}},files:[],frame:0,...over});
const clock=(...t:number[])=>()=>t.shift() as number;

describe('render worker preview conversion', ()=>{
  it('shows scalar fields as linear gray, sky white, NaN black, alpha opaque', ()=>{
    const out=scalarToGray(scalarField(5,1,new Float32Array([0,.5,1.4,Infinity,NaN])));
    expect([...out]).toEqual([0,0,0,255,128,128,128,255,255,255,255,255,255,255,255,255,0,0,0,255]);
  });
  it('maps normals n·0.5+0.5 and zeroes non-finite components', ()=>{
    const out=vectorToRgb8(vectorField(2,1,new Float32Array([0,0,1,-1,NaN,.5])));
    expect([...out]).toEqual([128,128,255,255,0,0,191,255]);
  });
  it('encodes images through toSRGB8 and keeps alpha', ()=>{
    const out=previewOf(imageBuf(1,1,'sRGB - Display',new Float32Array([.5,0,1,.5])));
    expect([...out]).toEqual([128,0,255,128]);
  });
});

describe('render worker job handling', ()=>{
  it('renders the real graph, reports time and transfers the preview buffer', ()=>{
    const {reply,transfer}=handleJob(job(),undefined,clock(10,25.5));
    const r=reply as RenderDone;
    expect(r).toMatchObject({jobId:7,width:2,height:1,warnings:[],bypassed:[],ms:15.5});
    expect([...r.preview]).toEqual([128,0,255,255,64,191,0,255]);
    expect(transfer).toEqual([r.preview.buffer]);
  });
  it('applies the host input conversion when the image is tagged differently and says so', ()=>{
    const r=handleJob(job({source:{width:1,height:1,data:new Float32Array([.5,.5,.5,1]),space:'Rec.1886 Rec.709 - Display'}}),undefined,clock(0,1)).reply as RenderDone;
    expect(r.warnings[0]).toContain('Eingangskonvertierung');
    // 0.5^2.4 linear re-encoded with the sRGB curve.
    const lin=.5**2.4,srgb=1.055*lin**(1/2.4)-.055;
    expect(r.preview[0]).toBe(Math.round(srgb*255));
  });
  it('passes target, frame and files to the renderer', ()=>{
    let seen:unknown;
    const fake=((_g:BuckGraph,_s:unknown,opts:unknown)=>{seen=opts;return {output:scalarField(2,1,new Float32Array([0,1])),warnings:['w'],bypassed:['b']};}) as never;
    const r=handleJob(job({target:'mask',frame:12,files:[['luts/a.cube',new Uint8Array([1])]]}),fake,clock(0,0)).reply as RenderDone;
    expect(seen).toMatchObject({frame:12,target:'mask'});
    expect((seen as {files:Map<string,Uint8Array>}).files.get('luts/a.cube')).toEqual(new Uint8Array([1]));
    expect([...r.preview]).toEqual([0,0,0,255,255,255,255,255]);
    expect(r).toMatchObject({warnings:['w'],bypassed:['b']});
  });
  it('shows prepared aux channels without running the graph', ()=>{
    const fake=(()=>{throw new Error('must not render');}) as never;
    const r=handleJob(job({channel:'depth',aux:{depth:scalarField(1,1,new Float32Array([.5])),masks:{}}}),fake,clock(0,0)).reply as RenderDone;
    expect(r.width).toBe(2);expect([...r.preview.slice(0,4)]).toEqual([128,128,128,255]);
    const missing=handleJob(job({channel:'normals'}),fake,clock(0,0)).reply as RenderFailed;
    expect(missing.error).toContain('Keine Normalen');
  });
  it('returns German errors: BuckError verbatim, others prefixed', ()=>{
    const buck=handleJob(job(),(()=>{throw new BuckError('Knoten fehlt.');}) as never,clock(0,0)).reply as RenderFailed;
    expect(buck).toEqual({jobId:7,error:'Knoten fehlt.'});
    const other=handleJob(job(),(()=>{throw new RangeError('boom');}) as never,clock(0,0));
    expect((other.reply as RenderFailed).error).toBe('Interner Renderfehler: boom');expect(other.transfer).toEqual([]);
  });
});

describe('editor render helpers', ()=>{
  const masked=graph([
    {id:'g',type:'mask.gradient@1',inputs:{},params:{shape:'linear',start:[0,0],end:[1,0],feather:0,invert:false}},
    {id:'cdl',type:'color.cdl@1',label:'Grade',inputs:{image:'$source',mask:'g'},params:{slope:[1,1,1],offset:[0,0,0],power:[1,1,1],saturation:1,style:'v1.2_Fwd',space:'sRGB - Display'}},
    {id:'lut',type:'color.lut3d@1',inputs:{image:'cdl'},params:{file:'luts/user.cube',inputSpace:'sRGB - Display',outputSpace:'sRGB - Display'}},
  ],'lut');
  it('picks the mask target for the mask view and channels for aux views', ()=>{
    expect(viewTarget(masked,'mask','g')).toEqual({target:'g'});
    expect(viewTarget(masked,'mask','cdl')).toEqual({target:'g'});
    expect(viewTarget(masked,'mask','lut').error).toContain('kein Maskenknoten');
    expect(viewTarget(masked,'mask').error).toContain('Maskenknoten auswählen');
    expect(viewTarget(masked,'depth','g')).toEqual({channel:'depth'});
    expect(viewTarget(masked,'normals')).toEqual({channel:'normals'});
    expect(viewTarget(masked,'result','g')).toEqual({});
  });
  it('sends only files the renderer reads', ()=>{
    const files=new Map([['luts/user.cube',new Uint8Array([1])],['luts/fallback_64.cube',new Uint8Array([2])],['thumbs/before.jpg',new Uint8Array([3])]]);
    expect(renderFiles(masked,files).map(([p])=>p)).toEqual(['luts/user.cube']);
  });
  it('limits thumbnails to 1024 px on the long side', ()=>{
    expect(thumbSize(1100,733)).toEqual([1024,682]);
    expect(thumbSize(600,2048)).toEqual([300,1024]);
    expect(thumbSize(800,600)).toEqual([800,600]);
    expect(thumbSize(5000,1)).toEqual([1024,1]);
  });
  it('builds unique lowercase cube paths from node ids', ()=>{
    const taken=new Set(['luts/fargolook_rec709_64.cube']);
    expect(bakedLutPath('fargoLook',taken)).toBe('luts/fargolook-2_rec709_64.cube');
    expect(bakedLutPath('Look Ä/1',taken)).toBe('luts/look-1_rec709_64.cube');
    expect(bakedLutPath('--',taken)).toBe('luts/look_rec709_64.cube');
    expect(/^luts\/[a-z0-9._-]+$/.test(bakedLutPath('X.Y_z',taken))).toBe(true);
  });
});
