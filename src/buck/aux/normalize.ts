import { scalarField } from '../field';
import { BuckError } from '../types';
import type { ScalarField } from '../types';
/**
 * Depth normalization of spec §6.2. Output is 0 = near … 1 = far, +Infinity = invalid/sky, and every finite output
 * satisfies out = clamp01(scale·x + shift). Percentiles: linear interpolation between closest ranks on the sorted
 * values (Hyndman–Fan type 7, NumPy's default "linear" method).
 */
export const PERCENTILE_SAMPLE_LIMIT=4_000_000;
type Semantics='relative-inverse'|'relative-depth'|'metric';
type Mode='shot-percentile'|'per-frame'|'none';

/** p in percent; `sorted` ascending, non-empty. */
export function percentile(sorted:Float32Array,p:number){
  const h=(sorted.length-1)*p/100,lo=Math.floor(h),hi=Math.min(sorted.length-1,lo+1);
  return sorted[lo]+(h-lo)*(sorted[hi]-sorted[lo]);
}
// Zero or negative disparity means infinitely far (or a failed estimate): it carries no position on the shot scale.
const validFor=(semantics:Semantics)=>semantics==='relative-inverse'?(x:number)=>Number.isFinite(x)&&x>0:Number.isFinite;

/** Valid values of all frames in fixed frame/pixel order; above the limit every k-th valid value (fixed stride). */
function collect(frames:ScalarField[],valid:(x:number)=>boolean){
  let count=0;for(const f of frames)for(let i=0;i<f.data.length;i++)if(valid(f.data[i]))count++;
  const stride=Math.max(1,Math.ceil(count/PERCENTILE_SAMPLE_LIMIT)),out=new Float32Array(Math.ceil(count/stride));
  let seen=0,n=0;
  for(const f of frames)for(let i=0;i<f.data.length;i++){const x=f.data[i];if(valid(x)){if(seen%stride===0)out[n++]=x;seen++;}}
  return out.sort();
}

function scaleShift(frames:ScalarField[],semantics:Semantics,low:number,high:number){
  const sorted=collect(frames,validFor(semantics));
  // No valid sample or a flat field: no measurable depth range, everything valid maps to 0 (near). Assumption of @1.
  if(!sorted.length)return{scale:0,shift:0};
  const pLow=percentile(sorted,low),pHigh=percentile(sorted,high),range=pHigh-pLow;
  if(!(range>0))return{scale:0,shift:0};
  // relative-inverse: 1 − (x − pLow)/range = −x/range + pHigh/range; relative-depth: (x − pLow)/range.
  return semantics==='relative-inverse'?{scale:-1/range,shift:pHigh/range}:{scale:1/range,shift:-pLow/range};
}

function apply(frame:ScalarField,semantics:Semantics,scale:number,shift:number){
  const valid=validFor(semantics),src=frame.data,out=new Float32Array(src.length);
  for(let i=0;i<src.length;i++){const x=src[i];if(!valid(x)){out[i]=Infinity;continue;}const y=scale*x+shift;out[i]=y<0?0:y>1?1:y;}
  return scalarField(frame.width,frame.height,out);
}

/**
 * shot-percentile: one shared pLow/pHigh over all frames. per-frame: own percentiles per frame; the returned
 * scale/shift are those of the last frame (each frame is still mapped with its own). metric or mode "none": values
 * unchanged (scale 1, shift 0), only non-finite values become +Infinity.
 */
export function normalizeDepth(frames:ScalarField[],semantics:Semantics,mode:Mode,low=2,high=98):{frames:ScalarField[];scale:number;shift:number}{
  if(!(Number.isFinite(low)&&Number.isFinite(high)&&low>=0&&high<=100&&low<high))fail(`Ungültige Perzentile ${low}/${high}: erwartet 0 ≤ unten < oben ≤ 100.`);
  for(const f of frames)if(f.data.length!==f.width*f.height)fail('Ein Tiefenbild hat eine falsche Datenlänge.');
  if(semantics==='metric'||mode==='none'){
    const out=frames.map(f=>scalarField(f.width,f.height,f.data.map(x=>Number.isFinite(x)?x:Infinity)));
    return{frames:out,scale:1,shift:0};
  }
  if(mode==='shot-percentile'){
    const {scale,shift}=scaleShift(frames,semantics,low,high);
    return{frames:frames.map(f=>apply(f,semantics,scale,shift)),scale,shift};
  }
  if(mode!=='per-frame')fail(`Unbekannter Normierungsmodus „${String(mode)}“.`);
  let last={scale:1,shift:0};const out:ScalarField[]=[];
  for(const f of frames){last=scaleShift([f],semantics,low,high);out.push(apply(f,semantics,last.scale,last.shift));}
  return{frames:out,...last};
}
function fail(message:string):never{throw new BuckError(message);}
