/// <reference types="vite/client" />
import { convertImage } from '../colorspace';
import { resample, scalarField } from '../field';
import { BuckError } from '../types';
import type { ImageBuf, ModelPin, ScalarField } from '../types';
import { isPinned } from './models';
/**
 * ML depth estimation (spec §6.3) with ONNX Runtime Web. The runtime is loaded lazily so it never enters the main
 * bundle; `estimateDepth` runs everything in src/buck/depth/depth.worker.ts. The raw output is the model's own
 * relative value (relative-inverse for Depth Anything); normalization to 0 = near … 1 = far is aux/normalize.ts.
 */
export type DepthBackend='webgpu'|'wasm';
export interface DepthOptions {allowUnpinned?:boolean;onProgress?:(p:number)=>void;}
export interface DepthResult {raw:ScalarField;weightsSha256:string;backend:DepthBackend;}
export interface DepthWorkerRequest {id:number;image:ImageBuf;pin:ModelPin;weights:ArrayBuffer;allowUnpinned:boolean;}
export type DepthWorkerMessage=
  |{id:number;type:'progress';progress:number}
  |{id:number;type:'done';raw:ScalarField;weightsSha256:string;backend:DepthBackend}
  |{id:number;type:'error';message:string};

/**
 * Model input size: long side = longSide, short side keeps the aspect ratio, both rounded to multipleOf (min. one step).
 * fit 'stretch' gives longSide × longSide, fit 'native' the source size.
 */
export function targetSize(width:number,height:number,pin:ModelPin){
  const {longSide,multipleOf}=pin.preprocess;
  if(!(Number.isInteger(longSide)&&Number.isInteger(multipleOf)&&multipleOf>0&&longSide>=multipleOf))throw new BuckError('Ungültige Vorverarbeitung im Modell-Pin (longSide/multipleOf).');
  if(!(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0))throw new BuckError('Das Bild für die Modellauswertung ist leer.');
  if(pin.preprocess.fit==='stretch')return {width:longSide,height:longSide};
  if(pin.preprocess.fit==='native')return {width,height};
  const scale=longSide/Math.max(width,height),fit=(v:number)=>Math.max(multipleOf,Math.round(v*scale/multipleOf)*multipleOf);
  return {width:fit(width),height:fit(height)};
}
// PIL filters (libImaging/Resample.c): bicubic with a = -0.5 and support 2, bilinear = triangle with support 1.
// resample = 3 (PIL BICUBIC) is what preprocessor_config.json of the ONNX export names.
const bicubic=(x:number)=>{const a=-.5;x=Math.abs(x);return x<1?((a+2)*x-(a+3))*x*x+1:x<2?(((x-5)*x+8)*x-4)*a:0;};
const triangle=(x:number)=>{x=Math.abs(x);return x<1?1-x:0;};
/** Antialiased convolution coefficients like PIL precompute_coeffs: the kernel widens by the downscale factor. */
function coefficients(inSize:number,outSize:number,filter:(x:number)=>number,support:number){
  const scale=inSize/outSize,fs=Math.max(1,scale),sup=support*fs,bounds=new Int32Array(outSize*2),weights:Float64Array[]=[];
  for(let i=0;i<outSize;i++){
    const center=(i+.5)*scale,min=Math.max(0,Math.trunc(center-sup+.5)),max=Math.min(inSize,Math.trunc(center+sup+.5)),w=new Float64Array(max-min);
    let sum=0;for(let j=0;j<w.length;j++){w[j]=filter((j+min-center+.5)/fs);sum+=w[j];}
    if(sum!==0)for(let j=0;j<w.length;j++)w[j]/=sum;
    bounds[i*2]=min;weights.push(w);
  }
  return {bounds,weights};
}
const clamp01=(v:number)=>v<0?0:v>1?1:v;
/** Separable resize of planar channels, horizontal pass first as in PIL; values clipped to 0…1 after each pass like PIL's 8-bit path. */
function resizePlanes(planes:Float32Array[],w:number,h:number,ow:number,oh:number,mode:'bicubic'|'bilinear'){
  const [filter,support]=mode==='bicubic'?[bicubic,2]:[triangle,1],cx=coefficients(w,ow,filter,support),cy=coefficients(h,oh,filter,support);
  return planes.map(src=>{
    const tmp=new Float32Array(ow*h),out=new Float32Array(ow*oh);
    for(let y=0;y<h;y++)for(let x=0;x<ow;x++){const k=cx.weights[x],b=cx.bounds[x*2];let s=0;for(let j=0;j<k.length;j++)s+=src[y*w+b+j]*k[j];tmp[y*ow+x]=clamp01(s);}
    for(let y=0;y<oh;y++){const k=cy.weights[y],b=cy.bounds[y*2];for(let x=0;x<ow;x++){let s=0;for(let j=0;j<k.length;j++)s+=tmp[(b+j)*ow+x]*k[j];out[y*ow+x]=clamp01(s);}}
    return out;
  });
}
/**
 * Image → NCHW float32 tensor [1,3,H,W]. Pixels become sRGB code values ('sRGB - Texture' of the pin has the same
 * encoding as 'sRGB - Display' in the ACES studio config), clipped to 0…1 like an 8-bit image, resized and normalized
 * with (v - mean) / std. Alpha is ignored.
 */
export function preprocess(image:ImageBuf,pin:ModelPin):{tensor:Float32Array;width:number;height:number}{
  const {width,height}=targetSize(image.width,image.height,pin),{mean,std,resize}=pin.preprocess;
  if(resize!=='bicubic'&&resize!=='bilinear')throw new BuckError(`Unbekannte Skalierung „${String(resize)}“ im Modell-Pin.`);
  if(![...mean,...std].every(Number.isFinite)||std.some(s=>s===0))throw new BuckError('Ungültige Normierung (mean/std) im Modell-Pin.');
  const srgb=convertImage(image,'sRGB - Display').data,n=image.width*image.height,planes=[0,1,2].map(()=>new Float32Array(n));
  for(let i=0;i<n;i++)for(let c=0;c<3;c++){const v=srgb[i*4+c];planes[c][i]=v>0?(v<1?v:1):0;} // NaN → 0
  const resized=resizePlanes(planes,image.width,image.height,width,height,resize),hw=width*height,tensor=new Float32Array(3*hw);
  for(let c=0;c<3;c++){const p=resized[c],m=mean[c],s=std[c];for(let i=0;i<hw;i++)tensor[c*hw+i]=(p[i]-m)/s;}
  return {tensor,width,height};
}
/** Throws unless the weights may run: a pinned model needs the exact hash, an unpinned one needs explicit consent. */
export function checkPin(weightsSha256:string,pin:ModelPin,allowUnpinned:boolean):void {
  if(pin.format!=='onnx')throw new BuckError(`Modellformat „${String(pin.format)}“ wird nicht unterstützt, erwartet wird ONNX.`);
  const sha=String(weightsSha256).toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(sha))throw new BuckError('Die Prüfsumme der Modellgewichte ist kein gültiger SHA-256-Wert.');
  if(isPinned(pin)){
    if(sha!==pin.weightsSha256)throw new BuckError(`Die Modellgewichte passen nicht zu „${pin.name}“: SHA-256 ${sha.slice(0,12)}… statt ${pin.weightsSha256.slice(0,12)}…. Ausführung verweigert.`);
    return;
  }
  if(!allowUnpinned)throw new BuckError(`„${pin.name}“ ist nicht gepinnt (kein SHA-256 der Gewichte). Ungepinnte Modelle laufen nur nach ausdrücklicher Freigabe.`);
}
export async function sha256(bytes:ArrayBuffer){
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}
export type Ort=typeof import('onnxruntime-web/webgpu');
let ortPromise:Promise<Ort>|undefined;
function configure(ort:Ort,wasmUrl:string){
  const base=typeof location!=='undefined'?location.href:undefined;
  ort.env.wasm.wasmPaths={wasm:base?new URL(wasmUrl,base).href:wasmUrl};
  // Threads need crossOriginIsolated (COOP/COEP); otherwise ORT would warn and fall back to one thread anyway.
  ort.env.wasm.numThreads=globalThis.crossOriginIsolated?0:1;
  // ORT logs constant-folding and EP-assignment notes as console errors; only real errors are worth showing.
  ort.env.logLevel='error';
  return ort;
}
/**
 * Hands a statically imported runtime to runDepthModel. depth.worker.ts does this because the project builds workers
 * as IIFE (Vite default), which forbids code splitting; the dynamic imports below then resolve inside the worker chunk.
 */
export function provideOrt(ort:Ort,wasmUrl:string){ortPromise=Promise.resolve(configure(ort,wasmUrl));}
/**
 * 'onnxruntime-web/webgpu' (1.31) embeds ort-wasm-simd-threaded.asyncify.mjs and loads the matching .wasm, which also
 * serves the 'wasm' EP. The .wasm URL comes from Vite (?url) so it works in dev and in the hashed build output.
 */
function loadOrt(){
  return ortPromise??=Promise.all([import('onnxruntime-web/webgpu'),import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')])
    .then(([ort,wasm])=>configure(ort,wasm.default)).catch(error=>{ortPromise=undefined;throw error;});
}
async function hasWebGpu(){
  const gpu=(globalThis.navigator as {gpu?:{requestAdapter():Promise<unknown>}}|undefined)?.gpu;
  if(!gpu)return false;
  try{return !!await gpu.requestAdapter();}catch{return false;}
}
/**
 * Session with ['webgpu','wasm'] when a GPU adapter exists (kernels WebGPU lacks run on the CPU EP), else plain wasm.
 * Caveat: if ORT's own WebGPU init fails despite an adapter it drops the EP with a console warning, and the label
 * 'webgpu' is then too optimistic; ORT does not expose the EPs it finally used.
 */
async function createSession(ort:Ort,weights:Uint8Array){
  if(await hasWebGpu()){
    try{return {session:await ort.InferenceSession.create(weights,{executionProviders:['webgpu','wasm']}),backend:'webgpu' as const};}
    catch{/* WebGPU init or a kernel failed: retry on the CPU */}
  }
  return {session:await ort.InferenceSession.create(weights,{executionProviders:['wasm']}),backend:'wasm' as const};
}
export type Session=Awaited<ReturnType<Ort['InferenceSession']['create']>>;
/**
 * Shared front of every model run (depth, segmentation, inpainting): SHA-256 of the weights, pin check, lazy ONNX Runtime and
 * a session (WebGPU with CPU fallback). The caller releases the session.
 */
export async function openModel(pin:ModelPin,weights:ArrayBuffer,allowUnpinned:boolean){
  const weightsSha256=await sha256(weights);
  checkPin(weightsSha256,pin,allowUnpinned);
  let ort:Ort;
  try{ort=await loadOrt();}catch(error){throw new BuckError(`ONNX Runtime konnte nicht geladen werden: ${error instanceof Error?error.message:String(error)}`);}
  let created:{session:Session;backend:DepthBackend};
  try{created=await createSession(ort,new Uint8Array(weights));}catch(error){throw new BuckError(`Das Modell ließ sich nicht laden: ${error instanceof Error?error.message:String(error)}`);}
  return {ort,weightsSha256,...created};
}
/** Hash, pin check, preprocessing, inference and bilinear resize of the output to the source size (raw values). */
export async function runDepthModel(image:ImageBuf,pin:ModelPin,weights:ArrayBuffer,opts?:DepthOptions):Promise<DepthResult>{
  const progress=opts?.onProgress??(()=>{});
  progress(0);
  const weightsSha256=await sha256(weights);
  checkPin(weightsSha256,pin,opts?.allowUnpinned??false);progress(.1);
  const {tensor,width,height}=preprocess(image,pin);progress(.15);
  let ort:Ort;
  try{ort=await loadOrt();}catch(error){throw new BuckError(`ONNX Runtime konnte nicht geladen werden: ${error instanceof Error?error.message:String(error)}`);}
  progress(.25);
  let created:{session:Awaited<ReturnType<Ort['InferenceSession']['create']>>;backend:DepthBackend};
  try{created=await createSession(ort,new Uint8Array(weights));}catch(error){throw new BuckError(`Das Modell ließ sich nicht laden: ${error instanceof Error?error.message:String(error)}`);}
  const {session,backend}=created;
  try{
    progress(.55);
    const input=session.inputNames.includes('pixel_values')?'pixel_values':session.inputNames[0],output=session.outputNames.includes('predicted_depth')?'predicted_depth':session.outputNames[0];
    let result;
    try{result=await session.run({[input]:new ort.Tensor('float32',tensor,[1,3,height,width])});}
    catch(error){throw new BuckError(`Die Tiefenschätzung ist fehlgeschlagen: ${error instanceof Error?error.message:String(error)}`);}
    progress(.9);
    const out=result[output],dims=out?.dims??[];
    if(!out||out.type!=='float32'||dims.length<2)throw new BuckError('Unerwartete Modellausgabe: erwartet wird float32 [1, H, W].');
    const oh=dims[dims.length-2],ow=dims[dims.length-1],data=out.data as Float32Array;
    if(ow*oh!==data.length)throw new BuckError('Unerwartete Modellausgabe: mehr als ein Tiefenkanal.');
    for(let i=0;i<data.length;i++)if(!Number.isFinite(data[i]))throw new BuckError('Das Modell lieferte ungültige Werte (NaN/Inf).');
    // Pixel-center bilinear (field.resample); upstream PyTorch uses align_corners=True, which differs by < half a model pixel.
    const raw=scalarField(image.width,image.height,resample(data,ow,oh,1,image.width,image.height));
    progress(1);
    return {raw,weightsSha256,backend};
  }finally{await session.release().catch(()=>{});}
}
/** runDepthModel in a dedicated module worker. `signal` aborts by terminating the worker (GPU memory is freed with it). */
export function estimateDepth(image:ImageBuf,pin:ModelPin,weights:ArrayBuffer,opts?:DepthOptions&{signal?:AbortSignal}):Promise<DepthResult>{
  const signal=opts?.signal;
  if(signal?.aborted)return Promise.reject(new BuckError('Tiefenschätzung abgebrochen.'));
  return new Promise<DepthResult>((resolve,reject)=>{
    const worker=new Worker(new URL('./depth.worker.ts',import.meta.url),{type:'module'}),id=1;
    const finish=()=>{worker.terminate();signal?.removeEventListener('abort',abort);};
    const abort=()=>{finish();reject(new BuckError('Tiefenschätzung abgebrochen.'));};
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=({data}:MessageEvent<DepthWorkerMessage>)=>{
      if(data.id!==id)return;
      if(data.type==='progress'){opts?.onProgress?.(data.progress);return;}
      finish();
      if(data.type==='done')resolve({raw:data.raw,weightsSha256:data.weightsSha256,backend:data.backend});
      else reject(new BuckError(data.message));
    };
    worker.onerror=(event:ErrorEvent)=>{finish();reject(new BuckError(`Der Tiefen-Worker ist abgestürzt: ${event.message||'unbekannter Fehler'}`));};
    const request:DepthWorkerRequest={id,image,pin,weights,allowUnpinned:opts?.allowUnpinned??false};
    worker.postMessage(request);
  });
}
