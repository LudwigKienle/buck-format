import type { RGB } from '../types';
import { clamp, lumaOf, quantile } from './common';
import type { Work } from './common';
/**
 * Haze over depth with the dark channel prior (He, Sun, Tang, „Single Image Haze Removal Using Dark Channel Prior“,
 * CVPR 2009 / TPAMI 33(12) 2011): in haze-free outdoor images the local minimum over the color channels is ≈ 0, so in a
 * hazy image the normalized dark channel min_c(min_Ω I_c/A_c) ≈ 1 − t with the transmission t = e^(−β·d) (Koschmieder).
 * A (airlight) follows He et al.: among the 0.1 % pixels with the brightest dark channel, the brightest input pixel.
 * Per depth bin the median normalized dark channel is the haze opacity of that depth. Reference minus source (both
 * measured, the source may already be hazy) gives the extra opacity a fog node has to add; it is fitted with the model of
 * atmos.fog@1: opacity(d) = maxOpacity·(1 − e^(−density·max(0, d − start))).
 */
export const HAZE_BINS=8;
export interface HazeProfile {A:RGB;bins:{d:number;h:number;n:number}[];}
function minFilter(v:Float32Array,w:number,h:number,r:number){
  const tmp=new Float32Array(v.length),out=new Float32Array(v.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=Infinity;for(let i=Math.max(0,x-r);i<=Math.min(w-1,x+r);i++)m=Math.min(m,v[y*w+i]);tmp[y*w+x]=m;}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=Infinity;for(let j=Math.max(0,y-r);j<=Math.min(h-1,y+r);j++)m=Math.min(m,tmp[j*w+x]);out[y*w+x]=m;}
  return out;
}
export function hazeProfile(work:Work,sky:Uint8Array):HazeProfile{
  const {w,h,rgb,depth}=work,n=w*h,r=Math.max(1,Math.round(.012*Math.max(w,h)));
  const minRgb=new Float32Array(n);for(let i=0;i<n;i++)minRgb[i]=Math.min(rgb[i*3],rgb[i*3+1],rgb[i*3+2]);
  // Airlight candidates: sky and the farthest 10 % of the finite depth (He et al. search the whole image; near bright
  // surfaces such as a sunlit wall then win, which a depth restriction avoids).
  const farD=work.depthKind==='none'?-Infinity:quantile(depth,.9,i=>Number.isFinite(depth[i])&&!sky[i]);
  const cand=(i:number)=>sky[i]===1||!Number.isFinite(depth[i])||depth[i]>=farD;
  const dark0=minFilter(minRgb,w,h,r),pool=Float32Array.from(dark0.filter((_,i)=>cand(i))).sort(),k=Math.max(1,Math.floor(pool.length*.001)),thr=pool.length?pool[pool.length-k]:Infinity;
  let best=-1,A:RGB=[1,1,1];
  for(let i=0;i<n;i++)if(cand(i)&&dark0[i]>=thr){const s=rgb[i*3]+rgb[i*3+1]+rgb[i*3+2];if(s>best){best=s;A=[rgb[i*3],rgb[i*3+1],rgb[i*3+2]];}}
  A=A.map(v=>Math.max(1e-3,v)) as RGB;
  const norm=new Float32Array(n);for(let i=0;i<n;i++)norm[i]=Math.min(rgb[i*3]/A[0],rgb[i*3+1]/A[1],rgb[i*3+2]/A[2]);
  const dark=minFilter(norm,w,h,r),bins:HazeProfile['bins']=[];
  for(let b=0;b<HAZE_BINS;b++){
    const lo=b/HAZE_BINS,hi=(b+1)/HAZE_BINS,keep=(i:number)=>!sky[i]&&Number.isFinite(depth[i])&&depth[i]>=lo&&(depth[i]<hi||(b===HAZE_BINS-1&&depth[i]<=1));
    let cnt=0;for(let i=0;i<n;i++)if(keep(i))cnt++;
    if(cnt>=n*.01)bins.push({d:(lo+hi)/2,h:clamp(quantile(dark,.5,keep)),n:cnt});
  }
  return {A,bins};
}
export interface FogFit {start:number;density:number;maxOpacity:number;sse:number;r2:number;amount:number;delta:{d:number;v:number;n:number}[];}
/** Extra opacity per bin (reference over source) fitted by grid search over start/density with the closed-form best maxOpacity. */
/**
 * Near-field baseline: the lowest opacity among the bins nearer than 0.3. The prior fails on surfaces that resemble the
 * airlight (bright sand, white walls: He et al. §6); that level is the same at every depth and is removed, so only haze that
 * grows with depth remains. Near-field haze (a sandstorm right in front of the camera) is underestimated by this; the color
 * match (lifted blacks) carries that part.
 */
export function withoutBaseline(p:HazeProfile):HazeProfile{
  const near=p.bins.filter(b=>b.d<.3),base=near.length?Math.min(...near.map(b=>b.h)):0;
  return {A:p.A,bins:p.bins.map(b=>({...b,h:clamp(b.h-base)}))};
}
export function fitFog(refRaw:HazeProfile,srcRaw:HazeProfile|undefined):FogFit|undefined{
  const ref=withoutBaseline(refRaw),src=srcRaw&&withoutBaseline(srcRaw);
  const delta=ref.bins.map(b=>{
    const s=src?.bins.reduce((best,x)=>Math.abs(x.d-b.d)<Math.abs(best.d-b.d)?x:best,src.bins[0]);
    const hs=s&&Math.abs(s.d-b.d)<.2?s.h:0;
    return {d:b.d,v:clamp((b.h-hs)/Math.max(.05,1-hs)),n:b.n};
  });
  if(delta.length<3)return undefined;
  const wsum=delta.reduce((a,b)=>a+b.n,0),mean=delta.reduce((a,b)=>a+b.v*b.n,0)/wsum,sst=delta.reduce((a,b)=>a+b.n*(b.v-mean)**2,0);
  let best:FogFit|undefined;
  for(let s=0;s<=.7001;s+=.05)for(let e=-1.5;e<=1.81;e+=.1){
    const beta=Math.exp(e),phi=delta.map(b=>1-Math.exp(-beta*Math.max(0,b.d-s)));
    let num=0,den=0;delta.forEach((b,i)=>{num+=b.n*b.v*phi[i];den+=b.n*phi[i]*phi[i];});
    if(!(den>0))continue;
    const m=clamp(num/den,0,.95),sse=delta.reduce((a,b,i)=>a+b.n*(b.v-m*phi[i])**2,0);
    if(!best||sse<best.sse-1e-12)best={start:Math.round(s*100)/100,density:Math.round(beta*100)/100,maxOpacity:Math.round(m*100)/100,sse,r2:0,amount:0,delta};
  }
  if(!best)return undefined;
  best.r2=sst>1e-9?clamp(1-best.sse/sst):best.sse<1e-4*wsum?1:0;
  // Haze has to grow with depth: a level shift that is the same near and far (lifted blacks, another airlight) is no haze.
  const avg=(f:(d:number)=>boolean)=>{const a=delta.filter(b=>f(b.d));const n=a.reduce((x,b)=>x+b.n,0);return n?a.reduce((x,b)=>x+b.v*b.n,0)/n:0;};
  best.amount=best.maxOpacity<.05?0:clamp(avg(d=>d>=.6)-avg(d=>d<.3));
  return best;
}
/** Fog color/luminance of atmos.fog@1 from the airlight: L∞ = color·0.18·2^luminance with color normalized to luminance 1. */
export function fogColor(A:RGB):{color:RGB;luminance:number}{
  const y=Math.max(1e-4,lumaOf(A));return {color:A.map(v=>v/y) as RGB,luminance:Math.round(clamp(Math.log2(y/.18),-10,10)*100)/100};
}
