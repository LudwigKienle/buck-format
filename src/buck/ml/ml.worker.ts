/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { provideOrt } from '../depth/estimate';
import { runInpaintModel, runMaskModel } from './run';
import type { MlWorkerMessage, MlWorkerRequest } from './run';
/** One-shot worker for segmentation and inpainting: runMlJob posts a single request and terminates the worker afterwards. */
provideOrt(ort,wasmUrl);
const post=(message:MlWorkerMessage,transfer:Transferable[]=[])=>self.postMessage(message,{transfer});
self.onmessage=async({data}:MessageEvent<MlWorkerRequest>)=>{
  const {id}=data,onProgress=(progress:number)=>post({id,type:'progress',progress});
  try{
    if(data.task==='mask'){
      const result=await runMaskModel(data.image,data.pin,data.weights,{allowUnpinned:data.allowUnpinned,onProgress});
      post({id,type:'mask',result},[result.mask.data.buffer]);
    }else{
      const result=await runInpaintModel(data.image,data.mask,data.grow,data.pin,data.weights,{allowUnpinned:data.allowUnpinned,onProgress});
      post({id,type:'inpaint',result},[result.plate.data.buffer,result.hole.data.buffer]);
    }
  }catch(error){post({id,type:'error',message:error instanceof Error?error.message:String(error)});}
};
