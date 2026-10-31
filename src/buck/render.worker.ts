/// <reference lib="webworker" />
import { convertImage, toSRGB8 } from './colorspace';
import { prepareAux, renderGraph } from './render';
import { BuckError } from './types';
import type { AuxChannels, Buf, BuckGraph, ImageBuf, ScalarField, SpaceName, VectorField } from './types';
/**
 * Render worker of the .buck editor. One job in, one reply out; the worker keeps no state between jobs, so a reply
 * depends only on its job (spec §7). `channel` shows a prepared aux channel (depth/normals) instead of a graph result.
 */
export interface RenderJob {
  jobId:number;graph:BuckGraph;source:{width:number;height:number;data:Float32Array;space:SpaceName};
  aux:AuxChannels;files:[string,Uint8Array][];frame:number;target?:string;channel?:'depth'|'normals';
  /**
   * Resolution of `source` relative to the editor image (spec §10 preview): 0.5 for the reduced interactive preview, whose
   * source the editor has already downscaled. Spatial parameters are in image widths (§4.4), so only the size changes;
   * aux channels are bound to the source size by prepareAux. Echoed in the reply.
   */
  scale?:number;
}
export interface RenderDone {jobId:number;width:number;height:number;preview:Uint8ClampedArray;warnings:string[];bypassed:string[];ms:number;scale?:number;}
export interface RenderFailed {jobId:number;error:string;}
export type RenderReply=RenderDone|RenderFailed;

const to8=(v:number)=>v>0?(v<1?Math.round(v*255):255):0;
/** Scalar field as 8-bit gray: values are data, shown linearly 0…1 (no display curve); +Infinity (sky) is white, NaN black. */
export function scalarToGray(f:ScalarField):Uint8ClampedArray {
  const src=f.data,out=new Uint8ClampedArray(src.length*4);
  for(let p=0;p<src.length;p++){const v=src[p],g=v===Infinity?255:to8(v),i=p*4;out[i]=out[i+1]=out[i+2]=g;out[i+3]=255;}
  return out;
}
/** Vector field (normals) as RGB = n·0.5 + 0.5; non-finite components become 0. */
export function vectorToRgb8(f:VectorField):Uint8ClampedArray {
  const src=f.data,n=f.width*f.height,out=new Uint8ClampedArray(n*4);
  for(let p=0;p<n;p++){for(let c=0;c<3;c++){const v=src[p*3+c];out[p*4+c]=Number.isFinite(v)?to8(v*.5+.5):0;}out[p*4+3]=255;}
  return out;
}
export const previewOf=(b:Buf)=>b.kind==='image'?toSRGB8(b):b.kind==='scalar'?scalarToGray(b):vectorToRgb8(b);

type Render=typeof renderGraph;
/** Pure job handler; `render` and `now` are injectable for tests. The preview buffer is listed for transfer. */
export function handleJob(job:RenderJob,render:Render=renderGraph,now:()=>number=()=>performance.now()):{reply:RenderReply;transfer:ArrayBuffer[]} {
  const t0=now();
  try{
    const {graph,frame}=job,{width,height}=job.source;
    let source:ImageBuf={kind:'image',width,height,data:job.source.data,space:job.source.space},output:Buf,warnings:string[]=[],bypassed:string[]=[];
    if(job.channel){
      const aux=prepareAux(graph,job.aux,width,height),buf=job.channel==='depth'?aux.depth:aux.normals;
      if(!buf)throw new BuckError(job.channel==='depth'?'Keine Tiefe vorhanden. Bitte im Hilfskanal-Bereich eine Tiefe schätzen oder laden.':'Keine Normalen vorhanden. Sie werden aus der Tiefe abgeleitet, sobald der Graph sie deklariert und eine Tiefe vorliegt.');
      output=buf;
    }else{
      // Spec §2: the host converts its image into colorManagement.input before the graph runs.
      const input=graph.colorManagement.input,note=source.space!==input?`Eingangskonvertierung des Hosts: „${source.space}“ → „${input}“ (laut colorManagement.input).`:undefined;
      if(note)source=convertImage(source,input);
      const r=render(graph,source,{frame,aux:job.aux,files:new Map(job.files),target:job.target});
      output=r.output;warnings=note?[note,...r.warnings]:r.warnings;bypassed=r.bypassed;
    }
    const preview=previewOf(output);
    const reply:RenderDone={jobId:job.jobId,width:output.width,height:output.height,preview,warnings,bypassed,ms:Math.max(0,now()-t0)};
    if(job.scale!==undefined&&job.scale!==1)reply.scale=job.scale;
    return {reply,transfer:[preview.buffer as ArrayBuffer]};
  }catch(e){
    const msg=e instanceof Error?e.message:String(e);
    return {reply:{jobId:job.jobId,error:e instanceof BuckError?msg:`Interner Renderfehler: ${msg}`},transfer:[]};
  }
}

// Only install the handler inside a worker; tests import the helpers above in Node.
if(typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope){
  const scope=self as unknown as DedicatedWorkerGlobalScope;
  scope.onmessage=({data}:MessageEvent<RenderJob>)=>{const {reply,transfer}=handleJob(data);scope.postMessage(reply,transfer);};
}
