import { BuckError } from './types';
import type { Animatable, Keyframes, Resolved } from './types';
/**
 * Spec §9.3 keyframe evaluation. Outside the first/last key the value is held constant. `smooth` is the monotone cubic
 * Hermite scheme of Fritsch & Carlson, "Monotone Piecewise Cubic Interpolation", SIAM J. Numer. Anal. 17(2), 1980:
 * three-point (arithmetic mean) interior tangents, one-sided end tangents, zero tangents at extrema and flat segments,
 * then the α²+β² ≤ 9 limiter. Unlike makeCurve in src/color/engine.ts (harmonic-mean tangents) these are the 1980 tangents.
 */
interface Prepared {f:number[];v:number[];m?:number[];interp:Keyframes['interp'];}

export const isKeyframes=(v:unknown):v is Keyframes=>typeof v==='object'&&v!==null&&!Array.isArray(v)&&Array.isArray((v as Keyframes).keys)&&typeof (v as Keyframes).interp==='string';

/** Fritsch–Carlson tangents for strictly increasing frames f. */
function tangents(f:number[],v:number[]){
  const n=f.length,d:number[]=[];for(let i=0;i<n-1;i++)d.push((v[i+1]-v[i])/(f[i+1]-f[i]));
  const m=[d[0]];for(let i=1;i<n-1;i++)m.push(d[i-1]*d[i]<=0?0:(d[i-1]+d[i])/2);m.push(d[n-2]);
  // Flat segments first for every interval, so the limiter below never re-raises a zeroed tangent.
  for(let i=0;i<n-1;i++)if(d[i]===0){m[i]=0;m[i+1]=0;}
  for(let i=0;i<n-1;i++){
    if(d[i]===0)continue;
    const a=m[i]/d[i],b=m[i+1]/d[i],s=a*a+b*b;
    if(s>9){const t=3/Math.sqrt(s);m[i]=t*a*d[i];m[i+1]=t*b*d[i];}
  }
  return m;
}

function prepare(k:Keyframes):Prepared {
  if(k.interp!=='linear'&&k.interp!=='hold'&&k.interp!=='smooth')throw new BuckError(`Unbekannte Keyframe-Interpolation „${String(k.interp)}“.`);
  if(!k.keys.length)throw new BuckError('Keyframes ohne Schlüssel.');
  for(const key of k.keys)if(!Array.isArray(key)||key.length!==2||!Number.isFinite(key[0])||!Number.isFinite(key[1]))throw new BuckError('Jeder Keyframe muss ein Paar [Frame, Wert] aus endlichen Zahlen sein.');
  // Stable sort by frame; of several keys on one frame the last one in the file wins.
  const sorted=k.keys.map((key,i)=>[key[0],key[1],i]).sort((a,b)=>a[0]-b[0]||a[2]-b[2]),f:number[]=[],v:number[]=[];
  for(const [frame,value] of sorted){if(f.length&&f[f.length-1]===frame)v[v.length-1]=value;else{f.push(frame);v.push(value);}}
  return {f,v,interp:k.interp,m:k.interp==='smooth'&&f.length>1?tangents(f,v):undefined};
}

export function evalAnimatable(value:Animatable,frame:number):number {
  if(typeof value==='number')return value;
  if(!isKeyframes(value))throw new BuckError('Animierbarer Wert muss eine Zahl oder ein Keyframe-Objekt sein.');
  if(Number.isNaN(frame))throw new BuckError('Frame ist keine Zahl.');
  const {f,v,m,interp}=prepare(value),n=f.length;
  if(frame<=f[0])return v[0];
  if(frame>=f[n-1])return v[n-1];
  let i=0;while(frame>=f[i+1])i++;
  if(interp==='hold')return v[i];
  const h=f[i+1]-f[i],t=(frame-f[i])/h;
  if(interp==='linear')return v[i]+(v[i+1]-v[i])*t;
  const t2=t*t,t3=t2*t,mm=m as number[];
  return (2*t3-3*t2+1)*v[i]+(t3-2*t2+t)*h*mm[i]+(-2*t3+3*t2)*v[i+1]+(t3-t2)*h*mm[i+1];
}

/** Replaces every Keyframes object (at any depth, also inside arrays) by its value at `frame`; the input is not modified. */
export function resolveParams<T>(params:T,frame:number):Resolved<T> {
  const walk=(x:unknown):unknown=>{
    if(isKeyframes(x))return evalAnimatable(x,frame);
    if(Array.isArray(x))return x.map(walk);
    if(typeof x==='object'&&x!==null){const out:Record<string,unknown>={};for(const key of Object.keys(x))out[key]=walk((x as Record<string,unknown>)[key]);return out;}
    return x;
  };
  return walk(params) as Resolved<T>;
}
