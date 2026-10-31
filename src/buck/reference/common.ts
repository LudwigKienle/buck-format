import { convertImage, kelvinToXYZ } from '../colorspace';
import { gaussianBlur } from '../field';
import type { ImageBuf, RGB, ScalarField } from '../types';
/**
 * Shared helpers of the reference analysis (editor feature, not part of the .buck format). Everything works on a
 * downscaled copy in linear Rec.709 display light ("Arbeitsbild"); no randomness, no network, same input → same output.
 */
export type DepthKind='model'|'upload'|'heuristic'|'none';
/** Downscaled analysis copy: linear Rec.709 RGB (3 channels), luminance and depth (0 = near … 1 = far, +Infinity = invalid/sky). */
export interface Work {w:number;h:number;rgb:Float32Array;Y:Float32Array;depth:Float32Array;depthKind:DepthKind;}
export const WORK_SIDE=512;
export const LUMA709:RGB=[.2126,.7152,.0722];
export const clamp=(x:number,lo=0,hi=1)=>x<lo?lo:x>hi?hi:x;
export const r3=(x:number)=>Math.round(x*1e3)/1e3;
export const r4=(x:number)=>Math.round(x*1e4)/1e4;
export const smooth=(a:number,b:number,x:number)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
/** German number with fixed decimals ("1,25"). */
export const de=(x:number,digits=1)=>x.toFixed(digits).replace('.',',').replace(/^-/,'−');
export const deSigned=(x:number,digits=1)=>(x>0?'+':'')+de(x,digits);
/** Integer hash (murmur3 finalizer) → [0, 1): deterministic subsampling. */
export function hash01(i:number,seed=0){
  let h=Math.imul(i|0,0x27d4eb2d)^Math.imul(seed|0,0x9e3779b1);
  h=Math.imul(h^(h>>>15),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);h^=h>>>16;
  return (h>>>0)/4294967296;
}
/** Percentile (0…1) of the values passing `keep`, linear interpolation between ranks; NaN when nothing passes. */
export function quantile(values:ArrayLike<number>,p:number,keep?:(i:number)=>boolean){
  const a:number[]=[];for(let i=0;i<values.length;i++){const v=values[i];if(Number.isFinite(v)&&(!keep||keep(i)))a.push(v);}
  if(!a.length)return NaN;
  a.sort((x,y)=>x-y);const x=(a.length-1)*clamp(p),k=Math.floor(x);return a[k]+(a[Math.min(k+1,a.length-1)]-a[k])*(x-k);
}
/** Per-channel median of the RGB pixels passing `keep` (robust against stars, moon, single lamps). */
export function medianRGB(rgb:Float32Array,n:number,keep:(i:number)=>boolean):RGB|undefined{
  const out:number[]=[];
  for(let c=0;c<3;c++)out.push(quantile(channel(rgb,n,c),.5,keep));
  return out.every(Number.isFinite)?out as RGB:undefined;
}
const channelCache=new WeakMap<Float32Array,Float32Array[]>();
function channel(rgb:Float32Array,n:number,c:number){
  let planes=channelCache.get(rgb);
  if(!planes){planes=[0,1,2].map(k=>{const p=new Float32Array(n);for(let i=0;i<n;i++)p[i]=rgb[i*3+k];return p;});channelCache.set(rgb,planes);}
  return planes[c];
}
export const lumaOf=(c:RGB)=>LUMA709[0]*c[0]+LUMA709[1]*c[1]+LUMA709[2]*c[2];
/** Scales an RGB triple to luminance 1 (Rec.709 weights). */
export const normY=(c:RGB):RGB=>{const y=Math.max(1e-9,lumaOf(c));return [c[0]/y,c[1]/y,c[2]/y];};

/** Work size for an image: long side ≤ side, aspect kept. */
export function workSize(width:number,height:number,side=WORK_SIDE){
  const s=Math.min(1,side/Math.max(width,height));return {w:Math.max(1,Math.round(width*s)),h:Math.max(1,Math.round(height*s))};
}
/** Area-average downscale of an interleaved buffer with `ch` channels (stride `stride`), first `ch` channels kept. */
function areaDown(src:Float32Array,W:number,H:number,stride:number,ch:number,w:number,h:number){
  const out=new Float32Array(w*h*ch);
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*H/h),y1=Math.max(y0+1,Math.floor((y+1)*H/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*W/w),x1=Math.max(x0+1,Math.floor((x+1)*W/w)),n=(y1-y0)*(x1-x0);
      for(let c=0;c<ch;c++){let s=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++)s+=src[(yy*W+xx)*stride+c];out[(y*w+x)*ch+c]=s/n;}
    }
  }
  return out;
}
/** Depth downscale that keeps invalid depth: a pixel is invalid when less than half of its source area is valid. */
export function downDepth(depth:ScalarField,w:number,h:number){
  const W=depth.width,H=depth.height,src=depth.data,out=new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*H/h),y1=Math.max(y0+1,Math.floor((y+1)*H/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*W/w),x1=Math.max(x0+1,Math.floor((x+1)*W/w));let s=0,k=0,n=0;
      for(let yy=Math.min(y0,H-1);yy<Math.min(y1,H);yy++)for(let xx=Math.min(x0,W-1);xx<Math.min(x1,W);xx++){n++;const v=src[yy*W+xx];if(Number.isFinite(v)){s+=v;k++;}}
      out[y*w+x]=k*2>=n&&k>0?s/k:Infinity;
    }
  }
  return out;
}
/** Linear Rec.709 analysis copy of `img` (any declared space) plus its depth at the same size. */
export function prepareWork(img:ImageBuf,depth:ScalarField|undefined,depthKind:DepthKind,side=WORK_SIDE):Work{
  const {w,h}=workSize(img.width,img.height,side),lin=convertImage(img,'lin_rec709_srgb').data;
  const rgb=areaDown(lin,img.width,img.height,4,3,w,h),n=w*h,Y=new Float32Array(n);
  for(let i=0;i<n;i++){for(let c=0;c<3;c++)if(!(rgb[i*3+c]>0))rgb[i*3+c]=0;Y[i]=LUMA709[0]*rgb[i*3]+LUMA709[1]*rgb[i*3+1]+LUMA709[2]*rgb[i*3+2];}
  const d=depth?downDepth(depth,w,h):new Float32Array(n).fill(.5);
  return {w,h,rgb,Y,depth:d,depthKind:depth?depthKind:'none'};
}
export const blur1=(a:Float32Array,w:number,h:number,sigma:number)=>sigma>0?gaussianBlur(a,w,h,1,sigma):new Float32Array(a);

/** Linear Rec.709 → CIE XYZ (D65). */
export function rgbToXYZ(c:RGB):RGB{
  return [.4123907993*c[0]+.3575843394*c[1]+.1804807884*c[2],.2126390059*c[0]+.7151686788*c[1]+.0721923154*c[2],.0193308187*c[0]+.1191947798*c[1]+.9505321522*c[2]];
}
const uv1960=(X:number,Y:number,Z:number):[number,number]=>{const d=X+15*Y+3*Z;return d>0?[4*X/d,6*Y/d]:[0,0];};
/**
 * Correlated color temperature and Duv (Ohno 2014: signed distance from the Planckian locus in CIE 1960 uv, positive =
 * above the locus = greenish) of a linear Rec.709 color. The locus is the same Kim et al. spline the nodes use for
 * {"kelvin": K}, so a measured temperature reproduces its own chromaticity in a node. Search on the mired scale.
 */
export function rgbToKelvin(c:RGB):{kelvin:number;duv:number}{
  const [X,Y,Z]=rgbToXYZ(c),[u,v]=uv1960(X,Y,Z);
  const at=(mired:number)=>{const p=kelvinToXYZ(1e6/mired);return uv1960(p[0],p[1],p[2]);};
  const dist=(m:number)=>{const [a,b]=at(m);return (a-u)**2+(b-v)**2;};
  let lo=1e6/25000,hi=1e6/1667;
  // Coarse scan, then golden-section refinement around the best sample.
  let best=lo,bd=Infinity;for(let m=lo;m<=hi;m+=5){const d=dist(m);if(d<bd){bd=d;best=m;}}
  let a=Math.max(lo,best-5),b=Math.min(hi,best+5);const g=(Math.sqrt(5)-1)/2;
  for(let i=0;i<40;i++){const m1=b-g*(b-a),m2=a+g*(b-a);if(dist(m1)<dist(m2))b=m2;else a=m1;}
  const m=(a+b)/2,[pu,pv]=at(m),[qu,qv]=at(Math.min(hi,m+1)),tu=qu-pu,tv=qv-pv,tl=Math.hypot(tu,tv)||1;
  // Sign by the side of the locus tangent: Ohno's convention, positive toward green (larger v).
  const cross=(tu*(v-pv)-tv*(u-pu))/tl,duv=Math.sign(cross)*Math.sqrt(dist(m));
  return {kelvin:Math.round(1e6/m),duv:Math.round(duv*1e4)/1e4};
}
/** Mired difference: perceptually more even than Kelvin differences. */
export const miredDiff=(a:number,b:number)=>Math.abs(1e6/a-1e6/b);

export type ConfidenceLevel='hoch'|'mittel'|'niedrig';
export const confidenceLevel=(c:number):ConfidenceLevel=>c>=.67?'hoch':c>=.4?'mittel':'niedrig';
/** Reference sky region in work pixels: 1 = sky. `kind` says where it came from. */
export interface SkyRegion {mask:Uint8Array;kind:'depth'|'image'|'none';share:number;/** Horizon in image widths (bottom of the lowest sky row with ≥ 1/64 sky). */horizon:number;}
export interface DepthStats {finiteShare:number;iqr:number;nearShare:number;farShare:number;flat:boolean;}
/** Spread of the finite non-sky depth: relative depth is normalized per shot, so only the distribution can be judged. */
export function depthStats(work:Work,sky:Uint8Array):DepthStats{
  const n=work.w*work.h,keep=(i:number)=>!sky[i]&&Number.isFinite(work.depth[i]);
  let k=0,near=0,far=0;for(let i=0;i<n;i++)if(keep(i)){k++;if(work.depth[i]<.3)near++;else if(work.depth[i]>.6)far++;}
  const iqr=quantile(work.depth,.75,keep)-quantile(work.depth,.25,keep);
  const nearShare=k?near/k:0,farShare=k?far/k:0;
  return {finiteShare:k/n,iqr:Number.isFinite(iqr)?iqr:0,nearShare,farShare,flat:!(iqr>=.15&&farShare>=.06&&nearShare>=.06)||work.depthKind==='none'};
}
