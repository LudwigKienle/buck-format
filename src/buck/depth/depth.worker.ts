/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { provideOrt, runDepthModel } from './estimate';
import type { DepthWorkerMessage, DepthWorkerRequest } from './estimate';
/** One-shot depth worker: estimateDepth posts a single request and terminates the worker after the answer. */
provideOrt(ort,wasmUrl);
const post=(message:DepthWorkerMessage,transfer:Transferable[]=[])=>self.postMessage(message,{transfer});
self.onmessage=async({data}:MessageEvent<DepthWorkerRequest>)=>{
  const {id,image,pin,weights,allowUnpinned}=data;
  try{
    const result=await runDepthModel(image,pin,weights,{allowUnpinned,onProgress:progress=>post({id,type:'progress',progress})});
    post({id,type:'done',...result},[result.raw.data.buffer]);
  }catch(error){post({id,type:'error',message:error instanceof Error?error.message:String(error)});}
};
