import { normalizeDepth } from '../aux/normalize';
import { estimateDepth } from '../depth/estimate';
import { HEURISTIC_LABEL, heuristicDepth } from '../depth/heuristic';
import { KNOWN_MODELS, isPinned } from '../depth/models';
import type { ImageBuf, ScalarField } from '../types';
import type { DepthKind } from './common';
/**
 * Depth of the reference image. With the pinned model the user already ran in the aux panel (AuxPanel): the ONNX file the
 * user picked there is remembered as a File handle for this session (BuckEditor listens to that file input) and read again
 * here; nothing is downloaded, and the worker checks the SHA-256 against the local registry pin as for the source. Without
 * it, the image heuristic (Behelf, no real depth estimation) – the UI marks that.
 */
let modelFile:File|undefined;
/** Called by BuckEditor when the user picks an ONNX file in the aux panel. Session only, never persisted. */
export function rememberModelFile(file:File){modelFile=file;}
export const rememberedModelFile=()=>modelFile;
export function forgetModelFile(){modelFile=undefined;}
export interface ReferenceDepth {depth:ScalarField;kind:DepthKind;label:string;note?:string;}
const own=<T,>(o:Record<string,T>,id:string)=>Object.prototype.hasOwnProperty.call(o,id)?o[id]:undefined;
export async function referenceDepth(image:ImageBuf,opts:{useModel:boolean;modelId?:string;signal?:AbortSignal;onProgress?:(p:number)=>void}):Promise<ReferenceDepth>{
  const pin=opts.modelId?own(KNOWN_MODELS,opts.modelId):undefined,file=modelFile;
  let note:string|undefined;
  if(opts.useModel&&pin&&file&&isPinned(pin)){
    try{
      const r=await estimateDepth(image,pin,await file.arrayBuffer(),{signal:opts.signal,onProgress:opts.onProgress});
      const depth=normalizeDepth([r.raw],pin.output,'shot-percentile',2,98).frames[0];
      return {depth,kind:'model',label:`${pin.name} · sha256 ${r.weightsSha256.slice(0,8)}… (Gewichte aus den Hilfskanälen)`};
    }catch(e){
      if(opts.signal?.aborted)throw e;
      note=`Modell nicht nutzbar (${e instanceof Error?e.message:String(e)}); Behelfstiefe verwendet.`;
    }
  }else if(opts.useModel)note='Die Modellgewichte der Hilfskanäle liegen in dieser Sitzung nicht vor; Behelfstiefe verwendet.';
  return {depth:heuristicDepth(image),kind:'heuristic',label:`${HEURISTIC_LABEL} – keine echte Tiefenschätzung`,note};
}
