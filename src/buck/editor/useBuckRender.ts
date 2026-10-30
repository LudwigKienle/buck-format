import { useEffect, useRef, useState } from 'react';
import { PORTS } from '../types';
import type { BuckGraph, NodeType, PortKind } from '../types';
import type { RenderJob, RenderReply } from '../render.worker';
import type { EditorState, RenderResult, ViewMode } from './types';

export const RENDER_DEBOUNCE_MS=120;
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

/** Archive path for a look's baked 64³ cube; ids are lowercased to the container's [a-z0-9._-] path alphabet (spec §3.1). */
export function bakedLutPath(id:string,taken:Set<string>):string {
  const slug=id.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-.]+|-+$/g,'')||'look';
  let path=`luts/${slug}_rec709_64.cube`;
  for(let i=2;taken.has(path);i++)path=`luts/${slug}-${i}_rec709_64.cube`;
  taken.add(path);return path;
}

// new URL must sit directly inside new Worker for Vite to bundle the worker (vite.dev/guide/features#web-workers).
const spawnWorker=()=>new Worker(new URL('../render.worker.ts',import.meta.url),{type:'module'});
const WORKER_CRASH='Der Render-Worker ist abgestürzt. Die nächste Änderung startet ihn neu.';

function jobFor(state:Pick<EditorState,'graph'|'source'|'files'|'frame'>&{channels:EditorState['aux']['channels']},jobId:number,view:{target?:string;channel?:'depth'|'normals'}):RenderJob|undefined {
  const s=state.source;if(!s)return undefined;
  const {width,height,data,space}=s.image;
  return {jobId,graph:state.graph,source:{width,height,data,space},aux:state.channels,files:renderFiles(state.graph,state.files),frame:state.frame,...view};
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

/**
 * Debounced preview rendering in one reused worker. At most one job is in flight; while it runs only the newest
 * request is kept, and replies to superseded jobs are dropped. Inputs are cloned, never transferred: the editor keeps them.
 * Depth and normals views are drawn by BuckViewer from the aux channels, so they keep the graph output (no extra job).
 * Results are kept per target, so a stale mask image never shows under the result view and vice versa; switching
 * back to a target whose inputs are unchanged reuses its result without a new job.
 */
export function useBuckRender(state:EditorState):{result?:RenderResult;busy:boolean;error?:string} {
  const {graph,source,frame,files,view,selected}=state,channels=state.aux.channels;
  const {target,error:viewError}=viewTarget(graph,view,selected),key=target??'';
  const [results,setResults]=useState<Readonly<Record<string,{inputs:unknown[];result:RenderResult}>>>({}),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
  const worker=useRef<Worker|null>(null),latest=useRef(0),latestKey=useRef(''),latestInputs=useRef<unknown[]>([]),inFlight=useRef(false),pending=useRef<RenderJob|null>(null);
  const cache=useRef(results);cache.current=results;

  useEffect(()=>()=>{worker.current?.terminate();worker.current=null;inFlight.current=false;pending.current=null;},[]);

  useEffect(()=>{
    const id=++latest.current,inputs=[graph,source,channels,files,frame];latestKey.current=key;latestInputs.current=inputs;
    if(!source||viewError){setBusy(false);return;}
    const hit=cache.current[key];
    if(hit&&hit.inputs.every((v,i)=>v===inputs[i])){setBusy(false);setError(undefined);return;}
    setBusy(true);
    const send=(job:RenderJob)=>{
      if(inFlight.current){pending.current=job;return;}
      let w=worker.current;
      if(!w){
        w=worker.current=spawnWorker();
        w.onmessage=({data}:MessageEvent<RenderReply>)=>{
          inFlight.current=false;
          const next=pending.current;pending.current=null;if(next)send(next);
          if(data.jobId!==latest.current)return;
          if('error' in data)setError(data.error);
          else{const k=latestKey.current,entry={inputs:latestInputs.current,result:data};setResults(r=>({...(r['']&&k!==''?{'':r['']}:{}),[k]:entry}));setError(undefined);}
          setBusy(false);
        };
        w.onerror=e=>{
          e.preventDefault();worker.current?.terminate();worker.current=null;inFlight.current=false;pending.current=null;
          setError(WORKER_CRASH);setBusy(false);
        };
      }
      inFlight.current=true;w.postMessage(job);
    };
    const job=jobFor({graph,source,files,frame,channels},id,{target});
    const timer=setTimeout(()=>{if(job)send(job);},RENDER_DEBOUNCE_MS);
    return ()=>clearTimeout(timer);
  },[graph,source,channels,files,frame,target,key,viewError]);

  // A result of another image size must not be painted over the current source.
  const result=results[key]?.result;
  const fits=!!result&&!!source&&result.width===source.image.width&&result.height===source.image.height;
  return {result:fits&&!viewError?result:undefined,busy,error:viewError??error};
}
