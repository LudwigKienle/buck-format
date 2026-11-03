/// <reference types="vite/client" />
import { convertImage } from '../colorspace';
import { openModel, preprocess } from '../depth/estimate';
import type { DepthBackend } from '../depth/estimate';
import { resample, scalarField } from '../field';
import { extremeFilter } from '../nodes/masks';
import { BuckError } from '../types';
import type { ImageBuf, ModelPin, ScalarField } from '../types';
/**
 * Segmentation and inpainting models (spec §6.5) with the same pin check and runtime as depth (depth/estimate.ts). Both are
 * shot data: the result is a declared input (mask or image) that the editor caches like depth; render.ts never runs a model.
 * `runMlJob` executes everything in src/buck/ml/ml.worker.ts.
 */
export interface MlOptions {allowUnpinned?:boolean;onProgress?:(p:number)=>void;}
export interface MaskResult {mask:ScalarField;weightsSha256:string;backend:DepthBackend;}
export interface PlateResult {plate:ImageBuf;hole:ScalarField;weightsSha256:string;backend:DepthBackend;}
export type MlJob=
  |{task:'mask';image:ImageBuf;pin:ModelPin;weights:ArrayBuffer;allowUnpinned:boolean}
  |{task:'inpaint';image:ImageBuf;pin:ModelPin;weights:ArrayBuffer;allowUnpinned:boolean;mask:ScalarField;grow:number};
export type MlWorkerRequest=MlJob&{id:number};
export type MlWorkerMessage=
  |{id:number;type:'progress';progress:number}
  |{id:number;type:'mask';result:MaskResult}
  |{id:number;type:'inpaint';result:PlateResult}
  |{id:number;type:'error';message:string};

const sigmoid=(x:number)=>1/(1+Math.exp(-x));
/** Probability map at the source size: model output (first output, [1,1,h,w]) → optional sigmoid → clamp 0…1 → bilinear. */
export async function runMaskModel(image:ImageBuf,pin:ModelPin,weights:ArrayBuffer,opts:MlOptions={}):Promise<MaskResult>{
  if(pin.output!=='probability')throw new BuckError(`„${pin.name}“ ist kein Segmentierungsmodell.`);
  const progress=opts.onProgress??(()=>{});progress(0);
  const {tensor,width,height}=preprocess(image,pin);progress(.1);
  const {ort,session,backend,weightsSha256}=await openModel(pin,weights,opts.allowUnpinned??false);
  try{
    progress(.4);
    let result;
    try{result=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',tensor,[1,3,height,width])});}
    catch(error){throw new BuckError(`Die Segmentierung ist fehlgeschlagen: ${error instanceof Error?error.message:String(error)}`);}
    progress(.9);
    const out=result[session.outputNames[0]],dims=out?.dims??[];
    if(!out||out.type!=='float32'||dims.length<2)throw new BuckError('Unerwartete Modellausgabe: erwartet wird float32 [1, 1, H, W].');
    const oh=dims[dims.length-2],ow=dims[dims.length-1],data=out.data as Float32Array;
    if(ow*oh!==data.length)throw new BuckError('Unerwartete Modellausgabe: mehr als ein Maskenkanal.');
    const act=pin.postprocess.activation==='sigmoid',p=new Float32Array(data.length);
    for(let i=0;i<data.length;i++){const v=act?sigmoid(data[i]):data[i];if(!Number.isFinite(v))throw new BuckError('Das Modell lieferte ungültige Werte (NaN/Inf).');p[i]=v<0?0:v>1?1:v;}
    progress(1);
    return {mask:scalarField(image.width,image.height,resample(p,ow,oh,1,image.width,image.height)),weightsSha256,backend};
  }finally{await session.release().catch(()=>{});}
}

/** Hole for the inpainting model: mask ≥ 0.5, grown by `grow` image widths (square max filter). 1 = fill. */
export function holeFromMask(mask:ScalarField,grow:number):ScalarField{
  const W=mask.width,H=mask.height,bin=Float32Array.from(mask.data,v=>v>=.5?1:0),r=Math.round(Math.max(0,grow)*W);
  return scalarField(W,H,r>0?extremeFilter(bin,W,H,r,true):bin);
}
/**
 * Inpainted plate in 'sRGB - Display': the source as uint8 sRGB code values plus the hole (255 = keep, 0 = fill) go through
 * the model pipeline at the source size; the output replaces only the hole region (the pipeline blends a narrow seam).
 */
export async function runInpaintModel(image:ImageBuf,mask:ScalarField,grow:number,pin:ModelPin,weights:ArrayBuffer,opts:MlOptions={}):Promise<PlateResult>{
  if(pin.output!=='image'||pin.preprocess.fit!=='native')throw new BuckError(`„${pin.name}“ ist kein Retuschemodell.`);
  const W=image.width,H=image.height,n=W*H;
  if(mask.width!==W||mask.height!==H)throw new BuckError(`Die Retuschemaske hat ${mask.width}×${mask.height} statt ${W}×${H} Pixel.`);
  const progress=opts.onProgress??(()=>{});progress(0);
  const hole=holeFromMask(mask,grow);
  let any=false;for(let i=0;i<n;i++)if(hole.data[i]>0){any=true;break;}
  if(!any)throw new BuckError('Die Retuschemaske ist leer; es gibt nichts zu füllen.');
  const srgb=convertImage(image,'sRGB - Display').data,img=new Uint8Array(3*n),holeU8=new Uint8Array(n);
  const u8=(v:number)=>Math.round(255*(v>0?(v<1?v:1):0));
  for(let i=0;i<n;i++){for(let c=0;c<3;c++)img[c*n+i]=u8(srgb[i*4+c]);holeU8[i]=hole.data[i]>0?0:255;}
  progress(.1);
  const {ort,session,backend,weightsSha256}=await openModel(pin,weights,opts.allowUnpinned??false);
  try{
    progress(.4);
    const [imgName,maskName]=session.inputNames.includes('image')&&session.inputNames.includes('mask')?['image','mask']:session.inputNames;
    let result;
    try{result=await session.run({[imgName]:new ort.Tensor('uint8',img,[1,3,H,W]),[maskName]:new ort.Tensor('uint8',holeU8,[1,1,H,W])});}
    catch(error){throw new BuckError(`Die Retusche ist fehlgeschlagen: ${error instanceof Error?error.message:String(error)}`);}
    progress(.9);
    const out=result[session.outputNames[0]];
    if(!out||out.type!=='uint8'||out.data.length!==3*n)throw new BuckError('Unerwartete Modellausgabe: erwartet wird uint8 [1, 3, H, W] in Bildgröße.');
    const d=out.data as Uint8Array,plate:ImageBuf={kind:'image',width:W,height:H,space:'sRGB - Display',data:new Float32Array(n*4)};
    for(let i=0;i<n;i++){for(let c=0;c<3;c++)plate.data[i*4+c]=d[c*n+i]/255;plate.data[i*4+3]=1;}
    progress(1);
    return {plate,hole,weightsSha256,backend};
  }finally{await session.release().catch(()=>{});}
}

/** Runs one job in a dedicated module worker; `signal` aborts by terminating the worker. */
export function runMlJob(job:MlJob,opts:{signal?:AbortSignal;onProgress?:(p:number)=>void}={}):Promise<MaskResult|PlateResult>{
  const signal=opts.signal;
  if(signal?.aborted)return Promise.reject(new BuckError('Modelllauf abgebrochen.'));
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./ml.worker.ts',import.meta.url),{type:'module'}),id=1;
    const finish=()=>{worker.terminate();signal?.removeEventListener('abort',abort);};
    const abort=()=>{finish();reject(new BuckError('Modelllauf abgebrochen.'));};
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=({data}:MessageEvent<MlWorkerMessage>)=>{
      if(data.id!==id)return;
      if(data.type==='progress'){opts.onProgress?.(data.progress);return;}
      finish();
      if(data.type==='error')reject(new BuckError(data.message));else resolve(data.result);
    };
    worker.onerror=(event:ErrorEvent)=>{finish();reject(new BuckError(`Der Modell-Worker ist abgestürzt: ${event.message||'unbekannter Fehler'}`));};
    worker.postMessage({...job,id} satisfies MlWorkerRequest);
  });
}
