/// <reference lib="webworker" />
import { bakeColorCube, bakeLookCube, serializeBuckCube } from './bake';
import { BuckError } from './types';
import type { BuckGraph, BuckNode } from './types';
/**
 * Bake worker of the .buck editor: the 64³ look cubes and the fallback cube of a save (spec §3.4, §5.5) run here instead
 * of on the main thread. One job in, progress messages and one reply out; no state between jobs. The bytes are those of
 * the former inline implementation in BuckEditor.saveBuck (tests/buck-perf-bake.test.ts).
 */
export interface BakeJob {
  jobId:number;
  /** Normalized graph as it will be saved, before `bakedLut` and `fallback` are set. */
  graph:BuckGraph;
  /** Files the color part reads (lut3d cubes); see renderFiles in editor/useBuckRender. */
  files:[string,Uint8Array][];
  /** Archive paths already taken, so baked cube names do not collide. */
  taken:string[];
  size:number;fallbackPath:string;
}
export interface BakeDone {jobId:number;graph:BuckGraph;entries:[string,Uint8Array][];covers:string[];omits:string[];ms:number;}
export interface BakeFailed {jobId:number;error:string;}
export interface BakeProgress {jobId:number;progress:number;label:string;}
export type BakeReply=BakeDone|BakeFailed|BakeProgress;

/** Archive path for a look's baked 64³ cube; ids are lowercased to the container's [a-z0-9._-] path alphabet (spec §3.1). */
export function bakedLutPath(id:string,taken:Set<string>):string {
  const slug=id.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-.]+|-+$/g,'')||'look';
  let path=`luts/${slug}_rec709_64.cube`;
  for(let i=2;taken.has(path);i++)path=`luts/${slug}-${i}_rec709_64.cube`;
  taken.add(path);return path;
}

/**
 * Bakes every color.look@1 node (bakedLut) and the fallback cube; returns the graph with both set and the new archive
 * entries. `progress(done, total, label)` is called before each cube.
 */
export function bakeForSave(job:Omit<BakeJob,'jobId'>,progress:(done:number,total:number,label:string)=>void=()=>{}):Omit<BakeDone,'jobId'|'ms'> {
  const {size}=job,taken=new Set(job.taken),files=new Map(job.files),enc=new TextEncoder(),entries:[string,Uint8Array][]=[];
  let g=job.graph;
  const looks=g.nodes.filter(n=>n.type==='color.look@1').length,total=looks+1;let done=0;
  const nodes:BuckNode[]=g.nodes.map(n=>{
    if(n.type!=='color.look@1')return n;
    progress(done++,total,`Look-Cube ${done}/${looks}`);
    const path=bakedLutPath(n.id,taken),bytes=enc.encode(serializeBuckCube(bakeLookCube(n.params,size),size,`${g.meta.name} · ${n.label??n.id}`,n.params.space,n.params.space));
    files.set(path,bytes);entries.push([path,bytes]);
    return {...n,params:{...n.params,bakedLut:path}};
  });
  g={...g,nodes};
  progress(done,total,'Fallback-Cube');
  const cm=g.colorManagement,fb=bakeColorCube(g,files,size),bytes=enc.encode(serializeBuckCube(fb.data,size,`${g.meta.name} · nur Farbe`,cm.input,cm.output));
  entries.push([job.fallbackPath,bytes]);
  g={...g,fallback:{cube:job.fallbackPath,inputSpace:cm.input,outputSpace:cm.output,covers:fb.covers,omits:fb.omits}};
  return {graph:g,entries,covers:fb.covers,omits:fb.omits};
}

/** Pure job handler; `post` receives progress and the final reply with its transfer list. */
export function handleBakeJob(job:BakeJob,post:(reply:BakeReply,transfer?:ArrayBuffer[])=>void,now:()=>number=()=>performance.now()){
  const t0=now();
  try{
    const r=bakeForSave(job,(done,total,label)=>post({jobId:job.jobId,progress:done/total,label}));
    post({jobId:job.jobId,...r,ms:Math.max(0,now()-t0)},r.entries.map(([,b])=>b.buffer as ArrayBuffer));
  }catch(e){
    const msg=e instanceof Error?e.message:String(e);
    post({jobId:job.jobId,error:e instanceof BuckError?msg:`Interner Fehler beim Backen: ${msg}`});
  }
}

if(typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope){
  const scope=self as unknown as DedicatedWorkerGlobalScope;
  scope.onmessage=({data}:MessageEvent<BakeJob>)=>handleBakeJob(data,(reply,transfer)=>scope.postMessage(reply,transfer??[]));
}
