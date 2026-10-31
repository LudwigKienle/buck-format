import type { ImageBuf, ScalarField, SpaceName, VectorField } from './types';
/** Shared deterministic buffer helpers for .buck nodes. Fixed iteration order, no randomness, no tile dependence. */
export const imageBuf=(width:number,height:number,space:SpaceName,data=new Float32Array(width*height*4)):ImageBuf=>({kind:'image',width,height,data,space});
export const scalarField=(width:number,height:number,data=new Float32Array(width*height)):ScalarField=>({kind:'scalar',width,height,data});
export const vectorField=(width:number,height:number,data=new Float32Array(width*height*3)):VectorField=>({kind:'vector3',width,height,data});
export const clamp01=(x:number)=>x<0?0:x>1?1:x;
/** Hermite smoothstep, identical to smooth() in src/color/spaces.ts; edge0 === edge1 is a hard step. */
export function smoothstep(edge0:number,edge1:number,x:number){if(edge0===edge1)return x<edge0?0:1;const t=clamp01((x-edge0)/(edge1-edge0));return t*t*(3-2*t);}
/** Bilinear sample with clamped edges, pixel centers at integer + 0.5. */
export function sampleBilinear(data:Float32Array,width:number,height:number,channels:number,x:number,y:number,channel:number){
  const fx=Math.min(width-1,Math.max(0,x-.5)),fy=Math.min(height-1,Math.max(0,y-.5)),x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),tx=fx-x0,ty=fy-y0;
  const r0=y0*width,r1=y1*width;
  return (data[(r0+x0)*channels+channel]*(1-tx)+data[(r0+x1)*channels+channel]*tx)*(1-ty)+(data[(r1+x0)*channels+channel]*(1-tx)+data[(r1+x1)*channels+channel]*tx)*ty;
}
/** Resample any interleaved buffer to a new size (bilinear). Used to bind aux channels of another resolution. */
export function resample(data:Float32Array,width:number,height:number,channels:number,toWidth:number,toHeight:number){
  if(width===toWidth&&height===toHeight)return new Float32Array(data);
  const out=new Float32Array(toWidth*toHeight*channels),sx=width/toWidth,sy=height/toHeight;
  for(let y=0;y<toHeight;y++)for(let x=0;x<toWidth;x++)for(let c=0;c<channels;c++)out[(y*toWidth+x)*channels+c]=sampleBilinear(data,width,height,channels,(x+.5)*sx,(y+.5)*sy,c);
  return out;
}
/** Normalized, symmetric Gaussian kernel; sigma in pixels. Radius = ceil(3 sigma). */
export function gaussianKernel(sigma:number){
  const r=Math.max(0,Math.ceil(sigma*3)),k=new Float32Array(2*r+1);if(r===0){k[0]=1;return k;}
  let sum=0;for(let i=-r;i<=r;i++){const v=Math.exp(-(i*i)/(2*sigma*sigma));k[i+r]=v;sum+=v;}
  for(let i=0;i<k.length;i++)k[i]/=sum;return k;
}
/**
 * Separable Gaussian blur of an interleaved buffer with clamped edges. sigma in pixels; sigma <= 0 copies.
 * Non-finite samples (e.g. +Infinity sky depth) are excluded and the remaining weights renormalized; a pixel whose
 * whole footprint is non-finite keeps its original value.
 *
 * Per output sample the taps are summed in float64 in the fixed order i = −r…r and divided by the float64 sum of the
 * used weights in the same order, so the result does not depend on how the loops below are arranged. They run tap by
 * tap over whole rows (contiguous, edges clamped per range instead of per tap) and skip the finiteness test on rows
 * without non-finite samples, where the weight sum is the full kernel sum.
 */
export function gaussianBlur(data:Float32Array,width:number,height:number,channels:number,sigma:number){
  if(!(sigma>0))return new Float32Array(data);
  const k=gaussianKernel(sigma),tmp=new Float32Array(data.length),out=new Float32Array(data.length);
  blurRows(data,tmp,width,height,channels,k);blurColumns(tmp,out,width,height,channels,k);return out;
}
/** Sum of all kernel weights, accumulated in the tap order of the blur passes. */
function kernelSum(k:Float32Array){let w=0;for(let t=0;t<k.length;t++)w+=k[t];return w;}
function rowFinite(src:Float32Array,start:number,len:number){for(let j=start,e=start+len;j<e;j++)if(!Number.isFinite(src[j]))return false;return true;}
/**
 * acc[j] += a[sa + j]·k0, then b·k1, c·k2, d·k3 for j < n: four taps per load/store of acc, the same float64 operation
 * sequence as four single-tap loops.
 */
function accumulate4(acc:Float64Array,n:number,a:Float32Array,sa:number,k0:number,sb:number,k1:number,sc:number,k2:number,sd:number,k3:number){
  for(let j=0;j<n;j++){let v=acc[j];v+=a[sa+j]*k0;v+=a[sb+j]*k1;v+=a[sc+j]*k2;v+=a[sd+j]*k3;acc[j]=v;}
}
function accumulate1(acc:Float64Array,n:number,a:Float32Array,sa:number,k0:number){for(let j=0;j<n;j++)acc[j]+=a[sa+j]*k0;}
/** Horizontal pass of gaussianBlur. */
function blurRows(src:Float32Array,dst:Float32Array,width:number,height:number,ch:number,k:Float32Array){
  const r=(k.length-1)/2,L=width*ch,acc=new Float64Array(L),wacc=new Float64Array(L),full=kernelSum(k),n=k.length;
  // Finite rows: copy into a row padded by r clamped pixels on both sides, so every tap is a plain shifted read.
  const pad=new Float32Array((width+2*r)*ch);
  for(let y=0;y<height;y++){
    const base=y*L,finite=rowFinite(src,base,L);acc.fill(0);
    if(finite){
      for(let x=-r;x<width+r;x++){const s=base+(x<0?0:x>=width?width-1:x)*ch,d=(x+r)*ch;for(let c=0;c<ch;c++)pad[d+c]=src[s+c];}
      // Tap t reads pixel x + t − r, i.e. pad[(x + t)·ch].
      let t=0;
      for(;t+3<n;t+=4)accumulate4(acc,L,pad,t*ch,k[t],(t+1)*ch,k[t+1],(t+2)*ch,k[t+2],(t+3)*ch,k[t+3]);
      for(;t<n;t++)accumulate1(acc,L,pad,t*ch,k[t]);
      for(let j=0;j<L;j++)dst[base+j]=acc[j]/full;
      continue;
    }
    wacc.fill(0);
    for(let t=0;t<n;t++){
      const i=t-r,kk=k[t],lo=Math.min(width,Math.max(0,-i)),hi=Math.max(lo,Math.min(width,width-i));
      // x < lo reads pixel 0, lo ≤ x < hi reads pixel x + i, x ≥ hi reads pixel width − 1 (clamped edges).
      const first=base,last=base+(width-1)*ch,shift=base+i*ch;
      for(let x=0;x<width;x++){
        const s=x<lo?first:x<hi?shift+x*ch:last;
        for(let c=0;c<ch;c++){const v=src[s+c];if(Number.isFinite(v)){acc[x*ch+c]+=v*kk;wacc[x*ch+c]+=kk;}}
      }
    }
    for(let j=0;j<L;j++){const w=wacc[j];dst[base+j]=w>0?acc[j]/w:src[base+j];}
  }
}
/** Vertical pass of gaussianBlur: every output row accumulates its 2r + 1 clamped source rows in tap order. */
function blurColumns(src:Float32Array,dst:Float32Array,width:number,height:number,ch:number,k:Float32Array){
  const r=(k.length-1)/2,L=width*ch,acc=new Float64Array(L),wacc=new Float64Array(L),full=kernelSum(k);
  // bad[y] = number of rows < y that contain a non-finite sample.
  const bad=new Int32Array(height+1);for(let y=0;y<height;y++)bad[y+1]=bad[y]+(rowFinite(src,y*L,L)?0:1);
  for(let y=0;y<height;y++){
    const y0=Math.max(0,y-r),y1=Math.min(height-1,y+r),finite=bad[y1+1]-bad[y0]===0;
    acc.fill(0);if(!finite)wacc.fill(0);
    const row=(t:number)=>Math.min(height-1,Math.max(0,y+t-r))*L;
    if(finite){
      let t=0;
      for(;t+3<k.length;t+=4)accumulate4(acc,L,src,row(t),k[t],row(t+1),k[t+1],row(t+2),k[t+2],row(t+3),k[t+3]);
      for(;t<k.length;t++)accumulate1(acc,L,src,row(t),k[t]);
    }else for(let t=0;t<k.length;t++){
      const s=row(t),kk=k[t];
      for(let j=0;j<L;j++){const v=src[s+j];if(Number.isFinite(v)){acc[j]+=v*kk;wacc[j]+=kk;}}
    }
    const base=y*L;
    if(finite)for(let j=0;j<L;j++)dst[base+j]=acc[j]/full;
    else for(let j=0;j<L;j++){const w=wacc[j];dst[base+j]=w>0?acc[j]/w:src[base+j];}
  }
}
/** Linear-light luminance with the weights of the given RGB primaries (Rec.709 or AP1/AP0 rows of RGB→XYZ). */
export const LUMA:Record<'rec709'|'ap1'|'ap0',[number,number,number]>={rec709:[.2126,.7152,.0722],ap1:[.2722287168,.6740817658,.0536895174],ap0:[.3439664498,.7281660966,-.0721325464]};
/**
 * Gaussian blur for large sigmas: box-downsample by f = floor(sigma/3) px, blur with sigma/f, bilinear upsample. For
 * sigma < 6 px it is gaussianBlur itself. Deterministic, but only an approximation of the full-resolution blur.
 * Non-finite samples are not supported here (callers pass finite data).
 */
export function gaussianBlurWide(data:Float32Array,width:number,height:number,channels:number,sigma:number){
  const f=Math.floor(sigma/3);
  if(f<2)return gaussianBlur(data,width,height,channels,sigma);
  const w=Math.ceil(width/f),h=Math.ceil(height/f),small=new Float32Array(w*h*channels);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const x1=Math.min(width,(x+1)*f),y1=Math.min(height,(y+1)*f),n=(x1-x*f)*(y1-y*f);
    for(let c=0;c<channels;c++){let s=0;for(let yy=y*f;yy<y1;yy++)for(let xx=x*f;xx<x1;xx++)s+=data[(yy*width+xx)*channels+c];small[(y*w+x)*channels+c]=s/n;}
  }
  const blurred=gaussianBlur(small,w,h,channels,sigma/f),out=new Float32Array(data.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<channels;c++)out[(y*width+x)*channels+c]=sampleBilinear(blurred,w,h,channels,(x+.5)/f,(y+.5)/f,c);
  return out;
}
