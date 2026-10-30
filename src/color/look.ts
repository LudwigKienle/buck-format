import { clamp, luma, mix, smooth } from './spaces';
import type { RGB } from './spaces';
/** A described look: zone tints are zero-luma Rec.709 offsets, all other values are bounded -1…1 / 0…1. */
export interface LookSpec {
  shadows:RGB; midtones:RGB; highlights:RGB;
  whiteClean:number; skinProtect:number; skinHue:number;
  key:number; contrast:number; saturation:number;
}
export const NEUTRAL_LOOK:LookSpec={shadows:[0,0,0],midtones:[0,0,0],highlights:[0,0,0],whiteClean:0,skinProtect:0,skinHue:0,key:0,contrast:0,saturation:0};
/** Zero-luma chroma direction of a display color, normalized to unit chroma. */
export function tintDirection(rgb:RGB):RGB {
  const y=luma(rgb),d=rgb.map(v=>v-y) as RGB,n=Math.hypot(...d)||1;
  return d.map(v=>v/n) as RGB;
}
/** A soft color-only skin candidate, never a claim of face/skin segmentation. */
export function skinKey(rgb:RGB){
  const y=luma(rgb),sat=Math.max(...rgb)-Math.min(...rgb);
  return smooth(0,.06,rgb[0]-rgb[1])*(1-smooth(.24,.45,rgb[0]-rgb[1]))*smooth(0,.04,rgb[1]-rgb[2])*(1-smooth(.6,.85,sat))*smooth(.04,.18,y)*(1-smooth(.82,.98,y));
}
/** Endpoint-preserving power contrast around a mid-grey pivot; monotonic for every amount. */
export function contrastCurve(x:number,amount:number,pivot=.46){
  if(amount===0)return x;
  const g=2**(amount*1.1),v=clamp(x);
  const out=v<pivot?pivot*(v/pivot)**g:1-(1-pivot)*((1-v)/(1-pivot))**g;
  return out+(x-v);
}
/** Endpoint-preserving gamma brightness; positive values lift mid-tones without clipping white. */
export function brightnessCurve(x:number,amount:number){
  if(amount===0)return x;
  const v=clamp(x);return v**(2**(-amount*.8))+(x-v);
}
export function applyLook(rgb:RGB,look:LookSpec,skinProtection:number):RGB {
  const y=luma(rgb),chroma=Math.hypot(...rgb.map(v=>v-y)),skin=skinKey(rgb);
  const shadow=(1-smooth(.06,.55,y))*(.45+.55*smooth(0,.1,y)),high=smooth(.42,.95,y),mid=clamp(1-shadow-high)*smooth(.08,.4,y);
  // Clean whites: tints never reach near-neutral highlights, so only chromatic light (practicals, reflections) is colored.
  const neutralHigh=look.whiteClean*high*(1-smooth(.025,.11,chroma));
  const protect=1-clamp(Math.max(skinProtection,look.skinProtect))*skin*.85;
  let c=rgb.map((v,i)=>v+(look.shadows[i]*shadow+look.midtones[i]*mid*(1-neutralHigh)+look.highlights[i]*high*(1-neutralHigh))*protect) as RGB;
  c=c.map(v=>mix(v,luma(c),neutralHigh*.85)) as RGB;
  // Skin hue: positive leans toward magenta (away from green), negative toward yellow-green.
  const magenta=tintDirection([1,0,1]);
  c=c.map((v,i)=>v+magenta[i]*look.skinHue*.03*skin) as RGB;
  const yy=luma(c);c=c.map(v=>yy+(v-yy)*(1+look.saturation*(look.saturation<0?1:.6))) as RGB;
  // High key: lifted mid-tones, gently raised blacks and softer contrast; low key the opposite.
  c=c.map(v=>contrastCurve(brightnessCurve(v,look.key*.75),look.contrast-look.key*.25)) as RGB;
  if(look.key>0)c=c.map(v=>v*(1-.035*look.key)+.035*look.key) as RGB;
  return c;
}
