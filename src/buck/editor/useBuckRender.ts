import { useEffect, useRef, useState } from 'react';
import { imageBuf } from '../field';
import { PORTS } from '../types';
import type { BuckGraph, ImageBuf, NodeType, PortKind } from '../types';
import type { RenderJob, RenderReply } from '../render.worker';
import type { BakeDone, BakeJob, BakeReply } from '../bake.worker';
import type { EditorState, RenderResult, ViewMode } from './types';
export { bakedLutPath } from '../bake.worker';

export const RENDER_DEBOUNCE_MS=120;
/** Interactive preview (spec §10): reduced resolution first, full resolution once the inputs rest for SETTLE_MS. */
export const PREVIEW_SCALE=.5,SETTLE_MS=250;
/** Drafts only pay off for slow renders: last full render ≥ DRAFT_MIN_MS, or (unknown yet) an image of ≥ DRAFT_MIN_PIXELS. */
export const DRAFT_MIN_MS=150,DRAFT_MIN_PIXELS=1<<18;
const outputKind=(type:string):PortKind|undefined=>(PORTS as Partial<Record<string,{output:PortKind}>>)[type as NodeType]?.output;

/** What the worker should show for a view: a graph target, a prepared aux channel, or nothing (with a reason). */
export function viewTarget(graph:BuckGraph,view:ViewMode,selected?:string):{target?:string;channel?:'depth'|'normals';error?:string} {
  if(view==='depth'||view==='normals')return {channel:view};
  if(view!=='mask')return {};
  const node=graph.nodes.find(n=>n.id===selected);
  if(!node)return {error:'Für die Maskenansicht bitte einen Maskenknoten auswählen.'};
  if(outputKind(node.type)==='scalar')return {target:node.id};
  // An image node shows the mask connected to it.
  const mask=node.inputs.mask;
  return mask?{target:mask}:{error:`„${node.label??node.id}“ ist kein Maskenknoten und hat keine Maske.`};
}

/** Only files the renderer can read (lut3d cubes, image masks) go to the worker; baked fallbacks and thumbnails stay here. */
export function renderFiles(graph:BuckGraph,files:Map<string,Uint8Array>):[string,Uint8Array][] {
  const used=new Set<string>();
  for(const n of graph.nodes)if(n.type==='color.lut3d@1'||n.type==='mask.image@1')used.add(n.params.file);
  return [...files].filter(([path])=>used.has(path));
}

/** Longest side ≤ max (spec §3.2 thumbnails), aspect kept, at least 1 px. */
export function thumbSize(width:number,height:number,max=1024):[number,number] {
  const s=Math.min(1,max/Math.max(width,height));
  return [Math.max(1,Math.round(width*s)),Math.max(1,Math.round(height*s))];
}

/** Size of the reduced preview: ceil(size · scale) for scale = 1/f, as produced by downscaleImage. */
export function previewSize(width:number,height:number,scale:number):[number,number] {
  if(!(scale>0&&scale<1))return [width,height];
  const f=Math.round(1/scale);return [Math.ceil(width/f),Math.ceil(height/f)];
}
/** Box average over f×f blocks (edge blocks average the pixels they have); f = round(1/scale). Deterministic. */
export function downscaleImage(img:ImageBuf,scale:number):ImageBuf {
  const [w,h]=previewSize(img.width,img.height,scale);
  if(w===img.width&&h===img.height)return img;
  const f=Math.round(1/scale),W=img.width,H=img.height,src=img.data,out=imageBuf(w,h,img.space),o=out.data;
  for(let y=0;y<h;y++){
    const y0=y*f,y1=Math.min(H,y0+f);
    for(let x=0;x<w;x++){
      const x0=x*f,x1=Math.min(W,x0+f),n=(x1-x0)*(y1-y0),d=(y*w+x)*4;let r=0,g=0,b=0,a=0;
      for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++){const s=(yy*W+xx)*4;r+=src[s];g+=src[s+1];b+=src[s+2];a+=src[s+3];}
      o[d]=r/n;o[d+1]=g/n;o[d+2]=b/n;o[d+3]=a/n;
    }
  }
  return out;
}
const halves=new WeakMap<ImageBuf,ImageBuf>();
const halfOf=(img:ImageBuf)=>{let h=halves.get(img);if(!h){h=downscaleImage(img,PREVIEW_SCALE);halves.set(img,h);}return h;};
/** Whether a reduced draft should precede the full render. */
export const wantDraft=(width:number,height:number,lastFullMs?:number)=>(lastFullMs===undefined?width*height>=DRAFT_MIN_PIXELS:lastFullMs>=DRAFT_MIN_MS)&&Math.min(width,height)>=16;

// new URL must sit directly inside new Worker for Vite to bundle the worker (vite.dev/guide/features#web-workers).
const spawnWorker=()=>new Worker(new URL('../render.worker.ts',import.meta.url),{type:'module'});
const spawnBakeWorker=()=>new Worker(new URL('../bake.worker.ts',import.meta.url),{type:'module'});
const WORKER_CRASH='Der Render-Worker ist abgestürzt. Die nächste Änderung startet ihn neu.';

function jobFor(state:Pick<EditorState,'graph'|'source'|'files'|'frame'>&{channels:EditorState['aux']['channels']},jobId:number,view:{target?:string;channel?:'depth'|'normals'},scale=1):RenderJob|undefined {
  const s=state.source;if(!s)return undefined;
  const {width,height,data,space}=scale<1?halfOf(s.image):s.image;
  return {jobId,graph:state.graph,source:{width,height,data,space},aux:state.channels,files:renderFiles(state.graph,state.files),frame:state.frame,...view,...(scale<1?{scale}:{})};
}

/** One-off render in a fresh worker (used for the "after" thumbnail on save). */
export function renderOnce(state:EditorState):Promise<RenderResult> {
  const job=jobFor({...state,channels:state.aux.channels},1,{});
  if(!job)return Promise.reject(new Error('Kein Bild geladen.'));
  return new Promise((resolve,reject)=>{
    const w=spawnWorker();
    w.onmessage=({data}:MessageEvent<RenderReply>)=>{w.terminate();if('error' in data)reject(new Error(data.error));else resolve(data);};
    w.onerror=e=>{e.preventDefault();w.terminate();reject(new Error(WORKER_CRASH));};
    w.postMessage(job);
  });
}

/** Cancelled bake (a newer save started); callers drop it silently. */
export class BakeCancelled extends Error {constructor(){super('Backen abgebrochen.');}}
/**
 * Runs the save bakes (bake.worker.ts) off the main thread. `cancel` terminates the worker and rejects with BakeCancelled.
 */
export function bakeInWorker(job:BakeJob,onProgress:(progress:number,label:string)=>void):{done:Promise<BakeDone>;cancel:()=>void} {
  const w=spawnBakeWorker();let settle:((e?:Error)=>void)|undefined;
  const done=new Promise<BakeDone>((resolve,reject)=>{
    settle=e=>{w.terminate();settle=undefined;if(e)reject(e);};
    w.onmessage=({data}:MessageEvent<BakeReply>)=>{
      if(data.jobId!==job.jobId)return;
      if('progress' in data){onProgress(data.progress,data.label);return;}
      if('error' in data){settle?.(new Error(data.error));return;}
      settle?.();resolve(data);
    };
    w.onerror=e=>{e.preventDefault();settle?.(new Error('Der Back-Worker ist abgestürzt.'));};
    w.postMessage(job);
  });
  return {done,cancel:()=>settle?.(new BakeCancelled())};
}

/** Minimal worker surface the queue needs (a DOM Worker satisfies it; tests pass fakes). */
export interface WorkerLike {
  postMessage(job:RenderJob):void;terminate():void;
  onmessage:((e:MessageEvent<RenderReply>)=>void)|null;onerror:((e:ErrorEvent)=>void)|null;
}
/** A queued render: the job plus the input generation it belongs to. */
export interface QueuedJob {job:RenderJob;gen:number;scale:number;}
/**
 * One reused worker, at most one job in flight. While one runs only the newest job is kept. A running full-resolution
 * job of an older generation is stale: its worker is terminated and the new job starts at once (a draft in flight is
 * short and allowed to finish). Every reply is handed to `onReply` with its job; the caller drops stale generations.
 */
export class RenderQueue {
  private worker:WorkerLike|null=null;private inFlight:QueuedJob|null=null;private pending:QueuedJob|null=null;
  constructor(private spawn:()=>WorkerLike,private onReply:(reply:RenderReply,item:QueuedJob)=>void,private onCrash:()=>void){}
  send(item:QueuedJob){
    const running=this.inFlight;
    if(running){
      if(running.gen!==item.gen&&running.scale===1)this.kill();
      else{this.pending=item;return;}
    }
    this.post(item);
  }
  get busy(){return this.inFlight!==null;}
  private post(item:QueuedJob){
    let w=this.worker;
    if(!w){
      w=this.worker=this.spawn();
      const self=w;
      w.onmessage=({data})=>{
        if(this.worker!==self)return;
        const done=this.inFlight;this.inFlight=null;
        const next=this.pending;this.pending=null;if(next)this.post(next);
        if(done&&done.job.jobId===data.jobId)this.onReply(data,done);
      };
      w.onerror=e=>{e.preventDefault();if(this.worker!==self)return;this.dispose();this.onCrash();};
    }
    this.inFlight=item;w.postMessage(item.job);
  }
  private kill(){this.worker?.terminate();this.worker=null;this.inFlight=null;}
  dispose(){this.kill();this.pending=null;}
}

export interface RenderState {result?:RenderResult;busy:boolean;error?:string;/** Resolution of the shown result relative to the image (0.5 = "Vorschau ½"). */scale:number;}
/**
 * Preview rendering in one reused worker (RenderQueue). For slow renders every change first sends a draft at
 * PREVIEW_SCALE (throttled: while one runs only the newest is kept), and the full resolution follows once the inputs
 * rested SETTLE_MS; fast renders keep the plain debounce. Replies of older input generations are dropped. Inputs are
 * cloned, never transferred: the editor keeps them. Depth and normals views are drawn by BuckViewer from the aux channels,
 * so they keep the graph output (no extra job). Results are kept per target, so a stale mask image never shows under the
 * result view and vice versa; switching back to a target whose inputs are unchanged reuses its full result without a job.
 */
export function useBuckRender(state:EditorState):RenderState {
  const {graph,source,frame,files,view,selected}=state,channels=state.aux.channels;
  const {target,error:viewError}=viewTarget(graph,view,selected),key=target??'';
  type Entry={inputs:unknown[];result:RenderResult;scale:number};
  const [results,setResults]=useState<Readonly<Record<string,Entry>>>({}),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
  const latest=useRef(0),jobSeq=useRef(0),lastFullMs=useRef<number|undefined>(undefined),queue=useRef<RenderQueue|null>(null);
  const meta=useRef(new Map<number,{key:string;inputs:unknown[]}>());
  const cache=useRef(results);cache.current=results;

  // Created on demand: StrictMode runs the unmount cleanup (dispose) between two mounts.
  const getQueue=()=>queue.current??=new RenderQueue(spawnWorker as unknown as ()=>WorkerLike,(data,item)=>{
    const m=meta.current.get(item.gen);
    if(item.gen!==latest.current||!m)return;
    if('error' in data){setError(data.error);if(item.scale===1)setBusy(false);return;}
    if(item.scale===1)lastFullMs.current=data.ms;
    const entry:Entry={inputs:m.inputs,result:data,scale:item.scale};
    setResults(r=>({...(r['']&&m.key!==''?{'':r['']}:{}),[m.key]:entry}));setError(undefined);
    if(item.scale===1)setBusy(false);
  },()=>{setError(WORKER_CRASH);setBusy(false);});
  useEffect(()=>()=>{queue.current?.dispose();queue.current=null;},[]);

  useEffect(()=>{
    const gen=++latest.current,inputs=[graph,source,channels,files,frame];
    meta.current.clear();meta.current.set(gen,{key,inputs});
    if(!source||viewError){setBusy(false);return;}
    const hit=cache.current[key];
    if(hit&&hit.scale===1&&hit.inputs.every((v,i)=>v===inputs[i])){setBusy(false);setError(undefined);return;}
    setBusy(true);
    const q=getQueue(),s={graph,source,files,frame,channels},img=source.image;
    const draft=wantDraft(img.width,img.height,lastFullMs.current);
    if(draft){const job=jobFor(s,++jobSeq.current,{target},PREVIEW_SCALE);if(job)q.send({job,gen,scale:PREVIEW_SCALE});}
    const timer=setTimeout(()=>{const job=jobFor(s,++jobSeq.current,{target});if(job)q.send({job,gen,scale:1});},draft?SETTLE_MS:RENDER_DEBOUNCE_MS);
    return ()=>clearTimeout(timer);
  },[graph,source,channels,files,frame,target,key,viewError]);

  // A result of another image size must not be painted over the current source.
  const entry=results[key],result=entry?.result;
  const [pw,ph]=source&&entry?previewSize(source.image.width,source.image.height,entry.scale):[0,0];
  const fits=!!result&&!!source&&result.width===pw&&result.height===ph;
  return {result:fits&&!viewError?result:undefined,busy,error:viewError??error,scale:fits?entry.scale:1};
}
