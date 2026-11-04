import { boxMean, scalarField } from '../field';
import type { ScalarField } from '../types';
/**
 * Depth inside an inpainted hole when the depth model cannot run again right away: the depth there still shows the removed
 * subject. Every hole pixel takes the mean of the valid pixels outside the hole in the smallest window (radius 2, 4, 8, … px)
 * that contains any; it becomes +Infinity (sky) when most of those pixels are invalid. A stand-in until depth is estimated
 * again on the plate, not an estimate of the hidden scene.
 */
export function fillDepthHole(depth:ScalarField,hole:ScalarField):ScalarField{
  const {width:W,height:H}=depth,n=W*H,known=new Float32Array(n),finite=new Float32Array(n),value=new Float32Array(n),out=new Float32Array(depth.data);
  let open=0;
  for(let i=0;i<n;i++){
    if(hole.data[i]>0){open++;continue;}
    known[i]=1;
    if(Number.isFinite(depth.data[i])){finite[i]=1;value[i]=depth.data[i];}
  }
  const done=new Uint8Array(n);
  for(let r=2;open>0&&r<2*Math.max(W,H);r*=2){
    const mk=boxMean(known,W,H,r),mf=boxMean(finite,W,H,r),mv=boxMean(value,W,H,r);
    for(let i=0;i<n;i++){
      if(hole.data[i]<=0||done[i]||mk[i]<=1e-6)continue;
      out[i]=mf[i]<.5*mk[i]?Infinity:mv[i]/mf[i];
      done[i]=1;open--;
    }
  }
  return scalarField(W,H,out);
}
