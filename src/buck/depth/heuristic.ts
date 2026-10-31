import { convertImage } from '../colorspace';
import { clamp01, gaussianBlur, resample, scalarField } from '../field';
import { BuckError } from '../types';
import type { ImageBuf, ScalarField } from '../types';
import { skyRegion } from '../reference/timeofday';
/**
 * BEHELF, keine Tiefenmessung: a deterministic monocular guess for when no model or depth upload is available.
 * Cues: vertical position (top = far), haze via the dark channel prior (He, Sun, Tang, CVPR 2009: t = 1 - ω·dark,
 * depth ∝ -ln t), low local contrast and low saturation (aerial perspective). Cue weights and filter radii are
 * hand-chosen assumptions, not fitted values. Output 0 = near … 1 = far, always finite.
 */
export const HEURISTIC_LABEL='Behelf: Bildheuristik';
const WORK_SIDE=256;
const WEIGHTS={position:.45,haze:.25,contrast:.15,saturation:.15};
const OMEGA=.95,T_MIN=.1; // He et al. 2009 defaults

/** Robust 2 %…98 % percentile stretch to 0…1; a (nearly) constant field becomes 0. */
function stretch(v:Float32Array){
  const sorted=Float32Array.from(v).sort(),q=(p:number)=>sorted[Math.floor(p*(sorted.length-1))],lo=q(.02),hi=q(.98),out=new Float32Array(v.length);
  if(!(hi-lo>1e-6))return out;
  for(let i=0;i<v.length;i++)out[i]=clamp01((v[i]-lo)/(hi-lo));
  return out;
}
/** Square min filter (separable, clamped edges). */
function minFilter(v:Float32Array,w:number,h:number,r:number){
  const tmp=new Float32Array(v.length),out=new Float32Array(v.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=Infinity;for(let i=Math.max(0,x-r);i<=Math.min(w-1,x+r);i++)m=Math.min(m,v[y*w+i]);tmp[y*w+x]=m;}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=Infinity;for(let j=Math.max(0,y-r);j<=Math.min(h-1,y+r);j++)m=Math.min(m,tmp[j*w+x]);out[y*w+x]=m;}
  return out;
}
/** Area-average downscale of the sRGB code values (clipped to 0…1) into three planes. */
function downscale(img:ImageBuf,w:number,h:number){
  const src=convertImage(img,'sRGB - Display').data,W=img.width,H=img.height,planes=[0,1,2].map(()=>new Float32Array(w*h));
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*H/h),y1=Math.max(y0+1,Math.floor((y+1)*H/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*W/w),x1=Math.max(x0+1,Math.floor((x+1)*W/w)),n=(y1-y0)*(x1-x0);
      for(let c=0;c<3;c++){let s=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++){const v=src[(yy*W+xx)*4+c];s+=v>0?(v<1?v:1):0;}planes[c][y*w+x]=s/n;}
    }
  }
  return planes;
}
export function heuristicDepth(image:ImageBuf):ScalarField {
  const W=image.width,H=image.height;
  if(!(Number.isInteger(W)&&Number.isInteger(H)&&W>0&&H>0)||image.data.length<W*H*4)throw new BuckError('Das Bild für die Behelfstiefe ist leer oder unvollständig.');
  const s=Math.min(1,WORK_SIDE/Math.max(W,H)),w=Math.max(1,Math.round(W*s)),h=Math.max(1,Math.round(H*s)),n=w*h,side=Math.max(w,h);
  const [r,g,b]=downscale(image,w,h),patch=Math.max(1,Math.round(.012*side)),sigma=Math.max(1,.02*side);
  const position=new Float32Array(n),minRgb=new Float32Array(n),luma=new Float32Array(n),luma2=new Float32Array(n),sat=new Float32Array(n);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,mx=Math.max(r[i],g[i],b[i]),mn=Math.min(r[i],g[i],b[i]),l=.2126*r[i]+.7152*g[i]+.0722*b[i];
    position[i]=h>1?1-y/(h-1):.5;minRgb[i]=mn;luma[i]=l;luma2[i]=l*l;sat[i]=mx>1e-4?(mx-mn)/mx:0;
  }
  // Airlight: brightest pixel among the top 0.1 % of the dark channel, first in scan order on ties.
  const dark0=minFilter(minRgb,w,h,patch),k=Math.max(1,Math.floor(n*.001)),threshold=Float32Array.from(dark0).sort()[n-k];
  let best=-1,A=[1,1,1];
  for(let i=0;i<n;i++)if(dark0[i]>=threshold&&r[i]+g[i]+b[i]>best){best=r[i]+g[i]+b[i];A=[r[i],g[i],b[i]];}
  A=A.map(v=>Math.max(1e-3,v));
  const norm=new Float32Array(n);for(let i=0;i<n;i++)norm[i]=Math.min(r[i]/A[0],g[i]/A[1],b[i]/A[2]);
  const dark=minFilter(norm,w,h,patch),haze=new Float32Array(n);
  for(let i=0;i<n;i++)haze[i]=-Math.log(Math.max(T_MIN,1-OMEGA*dark[i]));
  const mean=gaussianBlur(luma,w,h,1,sigma),mean2=gaussianBlur(luma2,w,h,1,sigma),contrast=new Float32Array(n);
  for(let i=0;i<n;i++)contrast[i]=Math.sqrt(Math.max(0,mean2[i]-mean[i]*mean[i]));
  const hz=stretch(haze),ct=stretch(contrast),st=stretch(gaussianBlur(sat,w,h,1,sigma)),mix=new Float32Array(n);
  for(let i=0;i<n;i++)mix[i]=WEIGHTS.position*position[i]+WEIGHTS.haze*hz[i]+WEIGHTS.contrast*(1-ct[i])+WEIGHTS.saturation*(1-st[i]);
  const depth=stretch(gaussianBlur(mix,w,h,1,Math.max(1,.015*side))),out=resample(depth,w,h,1,W,H);
  for(let i=0;i<out.length;i++)out[i]=clamp01(out[i]);
  markSky([r,g,b],depth,w,h,out,W,H);
  return scalarField(W,H,out);
}
/**
 * Marks the sky as invalid depth (+Infinity), as a depth model does, so sky-dependent nodes (sky.replace) also work on
 * the stand-in depth. Uses the image-based sky region of the reference analysis (grown from the top border over smooth,
 * far pixels); no sky found leaves the depth unchanged.
 */
function markSky([r,g,b]:Float32Array[],depth:Float32Array,w:number,h:number,out:Float32Array,W:number,H:number){
  if(w<8||h<8)return;
  // The sky search expects linear light: decode the sRGB code values of the downscaled planes.
  const lin=(v:number)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4,n=w*h,rgb=new Float32Array(n*3),Y=new Float32Array(n);
  for(let i=0;i<n;i++){const R=lin(r[i]),G=lin(g[i]),B=lin(b[i]);rgb[i*3]=R;rgb[i*3+1]=G;rgb[i*3+2]=B;Y[i]=.2126*R+.7152*G+.0722*B;}
  const sky=skyRegion({w,h,rgb,Y,depth:Float32Array.from(depth),depthKind:'heuristic'},true);
  if(sky.kind!=='image')return;
  const mask=new Float32Array(n);for(let i=0;i<n;i++)mask[i]=sky.mask[i];
  const up=resample(mask,w,h,1,W,H);
  for(let i=0;i<out.length;i++)if(up[i]>=.5)out[i]=Infinity;
}
