import { createHash } from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { checkPin,estimateDepth,preprocess,runDepthModel,targetSize } from '../src/buck/depth/estimate';
import type { DepthWorkerMessage,DepthWorkerRequest } from '../src/buck/depth/estimate';
import { heuristicDepth,heuristicNormals,HEURISTIC_LABEL } from '../src/buck/depth/heuristic';
import { normalsFromDepth } from '../src/buck/aux/normals';
import { DEFAULT_DEPTH_MODEL,isPinned,KNOWN_MODELS,MODEL_INFO } from '../src/buck/depth/models';
import { imageBuf,scalarField } from '../src/buck/field';
import { BuckError } from '../src/buck/types';
import type { ImageBuf,ModelPin,SpaceName } from '../src/buck/types';
// Fake colorspace (only sRGB encode of lin_rec709_srgb) so these tests do not depend on another agent's math.
vi.mock('../src/buck/colorspace',()=>({
  convertImage:(img:ImageBuf,to:SpaceName)=>{
    const out=new Float32Array(img.data);
    if(img.space!==to){
      if(!(img.space==='lin_rec709_srgb'&&to==='sRGB - Display'))throw new Error('fake: unsupported conversion');
      for(let i=0;i<out.length;i++)if(i%4!==3){const v=out[i];out[i]=v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;}
    }
    return {kind:'image',width:img.width,height:img.height,data:out,space:to};
  },
}));
// Fake ONNX Runtime: records sessions, echoes a column-index depth map of the model input size.
const ort=vi.hoisted(()=>({eps:[] as string[][],feeds:[] as {name:string;dims:number[];length:number}[],released:0,failWebgpu:false,output:'ok' as 'ok'|'nan'|'f16'}));
vi.mock('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url',()=>({default:'/assets/ort-wasm.wasm'}));
vi.mock('onnxruntime-web/webgpu',()=>{
  class Tensor {constructor(public type:string,public data:Float32Array,public dims:number[]){}}
  return {
    env:{wasm:{} as Record<string,unknown>,webgpu:{}},Tensor,
    InferenceSession:{create:async(_w:Uint8Array,o:{executionProviders:string[]})=>{
      ort.eps.push(o.executionProviders);
      if(ort.failWebgpu&&o.executionProviders.includes('webgpu'))throw new Error('no webgpu');
      return {inputNames:['pixel_values'],outputNames:['predicted_depth'],release:async()=>{ort.released++;},
        run:async(feeds:Record<string,Tensor>)=>{
          const [name]=Object.keys(feeds),t=feeds[name],h=t.dims[2],w=t.dims[3];ort.feeds.push({name,dims:t.dims,length:t.data.length});
          const data=new Float32Array(w*h);for(let i=0;i<data.length;i++)data[i]=i%w;if(ort.output==='nan')data[0]=NaN;
          return {predicted_depth:new Tensor(ort.output==='f16'?'float16':'float32',data,[1,h,w])};
        }};
    }},
  };
});
afterEach(()=>{vi.unstubAllGlobals();Object.assign(ort,{eps:[],feeds:[],released:0,failWebgpu:false,output:'ok'});});

const pin=KNOWN_MODELS['da2-small-rel@1'];
const solid=(w:number,h:number,rgb:number[],space:SpaceName='sRGB - Display')=>{const img=imageBuf(w,h,space);for(let i=0;i<w*h;i++)img.data.set([...rgb,1],i*4);return img;};
const weights=()=>new TextEncoder().encode('buckswood-fake-weights').buffer as ArrayBuffer;
const shaOf=(b:ArrayBuffer)=>createHash('sha256').update(new Uint8Array(b)).digest('hex');
const pinnedTo=(b:ArrayBuffer):ModelPin=>({...pin,weightsSha256:shaOf(b)});

describe('model registry',()=>{
  it('pins Depth Anything V2 Small as default and marks Video Depth Anything as unavailable',()=>{
    expect(DEFAULT_DEPTH_MODEL).toBe('da2-small-rel@1');
    expect(isPinned(KNOWN_MODELS[DEFAULT_DEPTH_MODEL])).toBe(true);
    expect(KNOWN_MODELS[DEFAULT_DEPTH_MODEL]).toMatchObject({license:'Apache-2.0',format:'onnx',output:'relative-inverse',preprocess:{longSide:518,multipleOf:14,mean:[.485,.456,.406],std:[.229,.224,.225]}});
    expect(isPinned(KNOWN_MODELS['vda-small-rel@1'])).toBe(false);
    expect(MODEL_INFO['vda-small-rel@1'].available).toBe(false);
    expect(MODEL_INFO[DEFAULT_DEPTH_MODEL].available).toBe(true);
  });
  it('accepts only 64 lowercase hex characters as a pin',()=>{
    expect(isPinned({...pin,weightsSha256:'PLATZHALTER-sha256-der-onnx-datei'})).toBe(false);
    expect(isPinned({...pin,weightsSha256:pin.weightsSha256.toUpperCase()})).toBe(false);
    expect(isPinned({...pin,weightsSha256:pin.weightsSha256.slice(1)})).toBe(false);
  });
});

describe('checkPin',()=>{
  const sha='ab'.repeat(32);
  it('accepts the exact hash (case-insensitive input) and rejects any other',()=>{
    expect(()=>checkPin(sha.toUpperCase(),{...pin,weightsSha256:sha},false)).not.toThrow();
    expect(()=>checkPin('cd'.repeat(32),{...pin,weightsSha256:sha},true)).toThrow(BuckError);
    expect(()=>checkPin('cd'.repeat(32),{...pin,weightsSha256:sha},true)).toThrow(/passen nicht/);
  });
  it('refuses unpinned models unless explicitly allowed',()=>{
    const unpinned=KNOWN_MODELS['vda-small-rel@1'];
    expect(()=>checkPin(sha,unpinned,false)).toThrow(/nicht gepinnt/);
    expect(()=>checkPin(sha,unpinned,true)).not.toThrow();
  });
  it('rejects malformed hashes and non-ONNX formats',()=>{
    expect(()=>checkPin('xyz',pin,true)).toThrow(/kein gültiger SHA-256/);
    expect(()=>checkPin(pin.weightsSha256,{...pin,format:'tflite' as 'onnx'},true)).toThrow(/ONNX/);
  });
});

describe('preprocess',()=>{
  it('fits the long side to 518 and rounds both sides to multiples of 14',()=>{
    expect(targetSize(1920,1080,pin)).toEqual({width:518,height:294});
    expect(targetSize(100,300,pin)).toEqual({width:168,height:518});
    expect(targetSize(1,1000,pin)).toEqual({width:14,height:518});
    expect(targetSize(64,64,pin)).toEqual({width:518,height:518});
    const {tensor,width,height}=preprocess(solid(192,108,[.5,.5,.5]),pin);
    expect([width,height]).toEqual([518,294]);expect(tensor.length).toBe(3*518*294);
    expect(()=>targetSize(0,10,pin)).toThrow(BuckError);
  });
  it('normalizes with ImageNet mean/std into planar NCHW order',()=>{
    const rgb=[.5,.25,1],{tensor,width,height}=preprocess(solid(37,21,rgb),pin),hw=width*height;
    for(let c=0;c<3;c++){const e=(rgb[c]-pin.preprocess.mean[c])/pin.preprocess.std[c];for(const i of [0,hw>>1,hw-1])expect(tensor[c*hw+i]).toBeCloseTo(e,5);}
  });
  it('encodes linear input to sRGB code values and clips out-of-range values',()=>{
    const lin=preprocess(solid(10,10,[.214041140,0,2],'lin_rec709_srgb'),pin),hw=lin.width*lin.height;
    expect(lin.tensor[0]).toBeCloseTo((.5-.485)/.229,4);
    expect(lin.tensor[hw]).toBeCloseTo((0-.456)/.224,6);
    expect(lin.tensor[2*hw]).toBeCloseTo((1-.406)/.225,5);
    const nan=preprocess(solid(10,10,[NaN,NaN,NaN]),pin);expect(nan.tensor[0]).toBeCloseTo(-.485/.229,6);
  });
  it('keeps the x order inside a row and antialiases a downscaled checkerboard like PIL',()=>{
    const ramp=imageBuf(1036,20,'sRGB - Display');for(let y=0;y<20;y++)for(let x=0;x<1036;x++)ramp.data.set([x/1035,0,0,1],(y*1036+x)*4);
    const r=preprocess(ramp,pin),row=Array.from(r.tensor.subarray(5*r.width,6*r.width));
    for(let x=1;x<row.length;x++)expect(row[x]).toBeGreaterThanOrEqual(row[x-1]);
    const checker=imageBuf(1036,1036,'sRGB - Display');for(let y=0;y<1036;y++)for(let x=0;x<1036;x++){const v=(x+y)%2;checker.data.set([v,v,v,1],(y*1036+x)*4);}
    const c=preprocess(checker,pin),e=(.5-.485)/.229;
    for(let y=4;y<c.height-4;y+=37)for(let x=4;x<c.width-4;x+=29)expect(c.tensor[y*c.width+x]).toBeCloseTo(e,4);
  });
  it('supports the bilinear pin, is deterministic and validates the pin',()=>{
    const img=heuristicInput(40,30),a=preprocess(img,pin),b=preprocess(img,pin);
    expect(Array.from(a.tensor)).toEqual(Array.from(b.tensor));
    const bl=preprocess(img,{...pin,preprocess:{...pin.preprocess,resize:'bilinear'}});
    expect(bl.tensor.length).toBe(a.tensor.length);expect(bl.tensor.every(Number.isFinite)).toBe(true);
    expect(()=>preprocess(img,{...pin,preprocess:{...pin.preprocess,std:[.2,0,.2]}})).toThrow(BuckError);
    expect(()=>preprocess(img,{...pin,preprocess:{...pin.preprocess,resize:'lanczos' as 'bicubic'}})).toThrow(BuckError);
    expect(()=>preprocess(img,{...pin,preprocess:{...pin.preprocess,multipleOf:0}})).toThrow(BuckError);
  });
});

describe('runDepthModel (fake ONNX Runtime)',()=>{
  it('refuses mismatching weights before any session is created',async()=>{
    await expect(runDepthModel(solid(8,8,[.5,.5,.5]),pin,weights())).rejects.toThrow(/passen nicht/);
    await expect(runDepthModel(solid(8,8,[.5,.5,.5]),KNOWN_MODELS['vda-small-rel@1'],weights())).rejects.toThrow(/nicht gepinnt/);
    expect(ort.eps).toEqual([]);
  });
  it('runs on wasm without a GPU, feeds pixel_values and resizes predicted_depth to the source',async()=>{
    vi.stubGlobal('navigator',{});
    const w=weights(),progress:number[]=[];
    const r=await runDepthModel(solid(28,14,[.5,.5,.5]),pinnedTo(w),w,{onProgress:p=>progress.push(p)});
    expect(r.backend).toBe('wasm');expect(r.weightsSha256).toBe(shaOf(w));expect(ort.eps).toEqual([['wasm']]);
    expect(ort.feeds).toEqual([{name:'pixel_values',dims:[1,3,266,518],length:3*266*518}]);
    expect([r.raw.kind,r.raw.width,r.raw.height]).toEqual(['scalar',28,14]);
    // Column index of a 518-wide map sampled at the 28 pixel centers.
    expect(r.raw.data[0]).toBeCloseTo((.5*518/28)-.5,4);expect(r.raw.data[27]).toBeCloseTo((27.5*518/28)-.5,4);
    expect(progress[0]).toBe(0);expect(progress.at(-1)).toBe(1);
    for(let i=1;i<progress.length;i++)expect(progress[i]).toBeGreaterThan(progress[i-1]);
    expect(ort.released).toBe(1);
    const {env}=await import('onnxruntime-web/webgpu');
    expect(env.wasm).toMatchObject({wasmPaths:{wasm:'/assets/ort-wasm.wasm'},numThreads:1});
  });
  it('uses webgpu + wasm when an adapter exists and falls back to wasm when that fails',async()=>{
    vi.stubGlobal('navigator',{gpu:{requestAdapter:async()=>({})}});
    const w=weights(),p=pinnedTo(w);
    expect((await runDepthModel(solid(4,4,[.2,.2,.2]),p,w)).backend).toBe('webgpu');
    expect(ort.eps).toEqual([['webgpu','wasm']]);
    ort.failWebgpu=true;ort.eps=[];
    expect((await runDepthModel(solid(4,4,[.2,.2,.2]),p,w)).backend).toBe('wasm');
    expect(ort.eps).toEqual([['webgpu','wasm'],['wasm']]);
  });
  it('allows unpinned weights with consent and rejects invalid outputs',async()=>{
    vi.stubGlobal('navigator',{});
    const w=weights();
    await expect(runDepthModel(solid(4,4,[.2,.2,.2]),KNOWN_MODELS['vda-small-rel@1'],w,{allowUnpinned:true})).resolves.toMatchObject({weightsSha256:shaOf(w)});
    ort.output='nan';await expect(runDepthModel(solid(4,4,[.2,.2,.2]),pinnedTo(w),w)).rejects.toThrow(/NaN/);
    ort.output='f16';await expect(runDepthModel(solid(4,4,[.2,.2,.2]),pinnedTo(w),w)).rejects.toThrow(/Modellausgabe/);
    expect(ort.released).toBe(3);
  });
});

/** Minimal Worker stand-in: `script` decides how the fake worker answers a request. */
function fakeWorker(script:(req:DepthWorkerRequest,send:(m:DepthWorkerMessage)=>void,fail:(msg:string)=>void)=>void){
  const state={created:0,terminated:0,url:'',type:''};
  vi.stubGlobal('Worker',class {
    onmessage:((e:{data:DepthWorkerMessage})=>void)|null=null;onerror:((e:{message:string})=>void)|null=null;
    constructor(url:URL,opts:{type:string}){state.created++;state.url=url.href;state.type=opts.type;}
    postMessage(req:DepthWorkerRequest){queueMicrotask(()=>script(req,m=>this.onmessage?.({data:m}),message=>this.onerror?.({message})));}
    terminate(){state.terminated++;}
  });
  return state;
}
describe('estimateDepth (worker)',()=>{
  it('spawns a module worker, forwards progress and resolves with the result',async()=>{
    const raw=scalarField(2,1,Float32Array.from([1,2]));
    const state=fakeWorker((req,send)=>{send({id:req.id,type:'progress',progress:.5});send({id:req.id+1,type:'progress',progress:.9});send({id:req.id,type:'done',raw,weightsSha256:'ab'.repeat(32),backend:'wasm'});});
    const progress:number[]=[],r=await estimateDepth(solid(2,1,[0,0,0]),pin,weights(),{onProgress:p=>progress.push(p)});
    expect(r).toEqual({raw,weightsSha256:'ab'.repeat(32),backend:'wasm'});
    expect(progress).toEqual([.5]);expect(state.url).toMatch(/depth\.worker\.ts$/);expect(state.type).toBe('module');expect(state.terminated).toBe(1);
  });
  it('maps worker errors and crashes to BuckError',async()=>{
    fakeWorker((req,send)=>send({id:req.id,type:'error',message:'Ausführung verweigert.'}));
    await expect(estimateDepth(solid(2,1,[0,0,0]),pin,weights())).rejects.toThrow('Ausführung verweigert.');
    fakeWorker((_req,_send,fail)=>fail('boom'));
    await expect(estimateDepth(solid(2,1,[0,0,0]),pin,weights())).rejects.toThrow(/abgestürzt: boom/);
  });
  it('aborts by terminating the worker',async()=>{
    const state=fakeWorker(()=>{}),ctrl=new AbortController(),pending=estimateDepth(solid(2,1,[0,0,0]),pin,weights(),{signal:ctrl.signal});
    ctrl.abort();
    await expect(pending).rejects.toThrow(/abgebrochen/);expect(state.terminated).toBe(1);
    const before=state.created;
    await expect(estimateDepth(solid(2,1,[0,0,0]),pin,weights(),{signal:ctrl.signal})).rejects.toThrow(/abgebrochen/);
    expect(state.created).toBe(before);
  });
  it('depth.worker.ts runs the model and posts progress, then the transferable result',async()=>{
    vi.stubGlobal('navigator',{});
    const posted:{m:DepthWorkerMessage;transfer:Transferable[]}[]=[];
    const fakeSelf:{onmessage:((e:{data:DepthWorkerRequest})=>Promise<void>)|null;postMessage:(m:DepthWorkerMessage,o:{transfer:Transferable[]})=>void}={onmessage:null,postMessage:(m,o)=>{posted.push({m,transfer:o.transfer});}};
    vi.stubGlobal('self',fakeSelf);
    await import('../src/buck/depth/depth.worker');
    const w=weights();
    await fakeSelf.onmessage!({data:{id:7,image:solid(6,3,[.4,.4,.4]),pin:pinnedTo(w),weights:w,allowUnpinned:false}});
    const last=posted.at(-1)!;
    expect(last.m).toMatchObject({id:7,type:'done',backend:'wasm',weightsSha256:shaOf(w)});
    expect(last.m.type==='done'&&last.transfer[0]===last.m.raw.data.buffer).toBe(true);
    expect(posted.slice(0,-1).every(p=>p.m.type==='progress'&&p.m.id===7)).toBe(true);
    await fakeSelf.onmessage!({data:{id:8,image:solid(6,3,[.4,.4,.4]),pin,weights:w,allowUnpinned:false}});
    expect(posted.at(-1)!.m).toMatchObject({id:8,type:'error',message:expect.stringMatching(/passen nicht/)});
  });
});

/** Upper half: bright, flat, desaturated haze. Lower half: dark, saturated, high-contrast texture. */
function heuristicInput(w:number,h:number){
  const img=imageBuf(w,h,'sRGB - Display');
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const top=y<h/2,t=(x+y)%2;
    img.data.set(top?[.82,.84,.86,1]:[.05+.5*t,.3*t,.02,1],(y*w+x)*4);
  }
  return img;
}
describe('heuristicDepth',()=>{
  it('returns depth in 0…1 (+Infinity only for detected sky) at source size, labelled as a fallback',()=>{
    const d=heuristicDepth(heuristicInput(300,200));
    expect([d.kind,d.width,d.height]).toEqual(['scalar',300,200]);
    expect(d.data.every(v=>v===Infinity||(Number.isFinite(v)&&v>=0&&v<=1))).toBe(true);
    const finite=d.data.filter(Number.isFinite);
    expect(Math.min(...finite)).toBeLessThan(.05);expect(Math.max(...d.data)).toBeGreaterThan(.95);
    expect(HEURISTIC_LABEL).toMatch(/Behelf/);
  });
  it('marks a smooth sky at the top as invalid depth, like a depth model',()=>{
    const w=160,h=90,img=imageBuf(w,h,'lin_rec709_srgb');
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,top=y<h*.4;const n=((x*7+y*13)%11)/11;
      const c=top?[.45+.1*y/h,.62+.05*y/h,.9]:[.55+.3*n,.42+.25*n,.25+.2*n];img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=1;}
    const d=heuristicDepth(img);let sky=0,ground=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const v=d.data[y*w+x];if(y<h*.3&&v===Infinity)sky++;if(y>h*.6&&v===Infinity)ground++;}
    expect(sky).toBeGreaterThan(w*h*.3*.8);expect(ground).toBe(0);
  });
  it('lets the sky reach silhouettes but keeps textured, sky-colored distant ridges as ground',()=>{
    // Sky above y=100; a textured tower (x 120…200, top y=50) and a hazy ridge in nearly the sky color but textured (x≥240, y≥84).
    const w=320,h=180,img=imageBuf(w,h,'lin_rec709_srgb'),skyC=(y:number)=>[.45+.1*y/h,.62+.05*y/h,.9];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4,n=((x*7+y*13)%11)/11,tower=x>=120&&x<200&&y>=50,ridge=x>=240&&y>=84&&y<100;
      const c=y>=100||tower?[.55+.3*n,.42+.25*n,.25+.2*n]:ridge?skyC(y).map(v=>v*(.8+.4*n)):skyC(y);
      img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=1;
    }
    const d=heuristicDepth(img),inf=(x:number,y:number)=>d.data[y*w+x]===Infinity;
    for(const x of [130,160,190])expect(inf(x,47)).toBe(true);
    for(const y of [60,80,95])expect(inf(117,y)).toBe(true);
    for(const x of [130,160,190])expect(inf(x,53)).toBe(false);
    let ridge=0;for(let y=86;y<98;y++)for(let x=250;x<310;x++)if(inf(x,y))ridge++;
    expect(ridge).toBeLessThan(60*12*.1);
  });
  it('does not take a smooth brown ceiling at the top border for sky, but keeps a sky gap of the same color',()=>{
    // Blue sky left, a textured wall (x 180…239), a smooth brown ceiling behind it at the top right, a narrow sky gap inside the wall.
    const w=320,h=180,img=imageBuf(w,h,'lin_rec709_srgb');
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4,n=((x*7+y*13)%11)/11,gap=x>=200&&x<214&&y<40;
      const c=y>=100?[.55+.3*n,.42+.25*n,.25+.2*n]:gap||x<180?[.45+.1*y/h,.62+.05*y/h,.9]:x<240?[.3+.3*n,.28+.25*n,.25+.2*n]:[.3,.2,.1];
      img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=1;
    }
    const d=heuristicDepth(img),inf=(x:number,y:number)=>d.data[y*w+x]===Infinity;
    expect(inf(60,20)).toBe(true);expect(inf(207,15)).toBe(true);
    expect(inf(290,20)).toBe(false);expect(inf(290,60)).toBe(false);
  });
  it('gives the stand-in depth normals that never face away from the sky: no dark blobs from near patches',()=>{
    // A near blob in the upper half: its depth gradient flips, so normals derived from it would face down.
    const w=64,h=48,d=scalarField(w,h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const r=Math.hypot(x-32,y-16);d.data[y*w+x]=y<4?Infinity:Math.max(0,1-y/h-(r<8?.6:0));}
    const derived=normalsFromDepth(d,0),n=heuristicNormals(d);
    let down=0,zero=0,other=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const j=(y*w+x)*3,ok=Number.isFinite(d.data[y*w+x]);
      if(!ok){if(n.data[j]===0&&n.data[j+1]===0&&n.data[j+2]===0)zero++;else other++;continue;}
      expect(n.data[j+1]).toBeGreaterThanOrEqual(-1e-4);expect(Math.hypot(n.data[j],n.data[j+1],n.data[j+2])).toBeCloseTo(1,4);
      if(derived.data[j+1]<-.1)down++;
    }
    expect(down).toBeGreaterThan(0);expect(other).toBe(0);expect(zero).toBe(w*4);
  });
  it('counts a bright cloud that touches a ridge as sky',()=>{
    // Ground below y=100, a textured peak (x 150…170, top y=38) and a smooth white cloud (x 100…170, y 30…42) resting on it.
    const w=320,h=180,img=imageBuf(w,h,'lin_rec709_srgb');
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4,n=((x*7+y*13)%11)/11,ground=y>=100||x>=150&&x<170&&y>=38,cloud=x>=100&&x<170&&y>=30&&y<42&&!ground;
      const c=ground?[.55+.3*n,.42+.25*n,.25+.2*n]:cloud?[1.6,1.6,1.65]:[.45+.1*y/h,.62+.05*y/h,.9];
      img.data[i]=c[0];img.data[i+1]=c[1];img.data[i+2]=c[2];img.data[i+3]=1;
    }
    const d=heuristicDepth(img),inf=(x:number,y:number)=>d.data[y*w+x]===Infinity;
    for(const x of [110,130,145])expect(inf(x,36)).toBe(true);
    expect(inf(160,70)).toBe(false);
  });
  it('puts hazy, flat, upper regions farther than saturated textured foreground',()=>{
    const d=heuristicDepth(heuristicInput(120,80)),mean=(y0:number,y1:number)=>{let s=0;for(let y=y0;y<y1;y++)for(let x=0;x<120;x++)s+=d.data[y*120+x];return s/((y1-y0)*120);};
    expect(mean(0,30)).toBeGreaterThan(mean(50,80)+.3);
  });
  it('falls back to the vertical prior on a uniform image and is deterministic',()=>{
    const img=solid(64,48,[.4,.5,.6]),a=heuristicDepth(img),b=heuristicDepth(img);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(a.data[0]).toBeGreaterThan(a.data[47*64]);
    for(let y=1;y<48;y++)expect(a.data[y*64+10]).toBeLessThanOrEqual(a.data[(y-1)*64+10]+1e-6);
    const one=heuristicDepth(solid(1,1,[.3,.3,.3]));expect(one.data.length).toBe(1);expect(one.data[0]).toBe(0);
  });
  it('rejects empty images',()=>{
    expect(()=>heuristicDepth(imageBuf(0,0,'sRGB - Display'))).toThrow(BuckError);
  });
});
