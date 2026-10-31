import { detectPracticals } from '../nodes/practicals';
import { extremeFilter } from '../nodes/masks';
import type { RGB } from '../types';
import { clamp, normY, quantile, rgbToKelvin } from './common';
import type { Work } from './common';
/**
 * Glowing practicals with the detection of light.practicals@1 (luminance threshold, local contrast against the surround,
 * size band from two openings), on the work image. The threshold follows the image: 80 % of the 99.7th luminance
 * percentile, between 0.25 and 0.9 (display light), so a graded night frame still shows its lamps. The light color comes
 * from a ring around the detected cores (the cores themselves are usually clipped to white), the strength from the ring
 * brightness against a wider surround.
 */
export const LAMP_DETECTION={softness:.3,contrast:2,minSize:.002,maxSize:.04};
export interface LampResult {share:number;threshold:number;color?:RGB;kelvin?:number;duv?:number;intensity?:number;center?:[number,number];}
export function lampThreshold(Y:Float32Array){const q=quantile(Y,.997);return clamp(Number.isFinite(q)?q*.8:.9,.25,.9);}
/** `sky`: detections inside the sky (moon, sun, bright clouds) are no practicals and are dropped. */
export function detectLamps(work:Work,threshold=lampThreshold(work.Y),sky?:Uint8Array):LampResult{
  const {w,h,Y,rgb}=work,n=w*h,m=detectPracticals(Y,w,h,{threshold,...LAMP_DETECTION});
  if(sky)for(let i=0;i<n;i++)if(sky[i])m[i]=0;
  let s=0,cx=0,cy=0;for(let i=0;i<n;i++){if(m[i]>.5){s++;cx+=i%w;cy+=Math.floor(i/w);}}
  const share=s/n;
  if(s<3)return {share,threshold};
  const core=new Float32Array(n);for(let i=0;i<n;i++)core[i]=m[i]>.5?1:0;
  const r1=Math.max(1,Math.round(.015*w)),r2=Math.max(r1+1,Math.round(.06*w));
  const ring=extremeFilter(core,w,h,r1,true),wide=extremeFilter(core,w,h,r2,true);
  const col=[0,0,0];let rn=0,ry=0,sy=0,sn=0;
  for(let i=0;i<n;i++){
    if(ring[i]>.5&&!core[i]){for(let c=0;c<3;c++)col[c]+=rgb[i*3+c];ry+=Y[i];rn++;}
    else if(wide[i]>.5&&ring[i]<.5){sy+=Y[i];sn++;}
  }
  if(!rn)return {share,threshold};
  const color=normY(col as RGB),{kelvin,duv}=rgbToKelvin(color),ratio=(ry/rn)/Math.max(1e-4,sn?sy/sn:1e-4);
  return {share,threshold,color,kelvin,duv,intensity:Math.round(clamp(.8+.6*Math.log2(Math.max(1,ratio)),.5,3)*100)/100,center:[(cx/s+.5)/w,(cy/s+.5)/w]};
}
