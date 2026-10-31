import { gaussianBlur } from '../field';
import { fbm } from '../nodes/sky';
import { clamp, smooth } from './common';
import type { Work } from './common';
/**
 * Sharpness over depth. Per pixel the fine detail |Y′ − G₁Y′| and the medium detail |Y′ − G₄Y′| (Y′ = Y^(1/2.2), Gσ =
 * Gaussian in work pixels) are summed per depth bin; their ratio R falls when fine structure is missing and does not
 * depend on the contrast of the texture (a variant of the gradient/Laplacian energy measures compared by Pertuz et al.,
 * „Analysis of focus measure operators for shape-from-focus“, Pattern Recognition 46(5), 2013). R relative to the sharpest
 * bin is turned into an equivalent Gaussian blur with a calibration curve measured on 1/f noise (fbm), which stands in for
 * natural image statistics. The extra blur (reference over source, added in quadrature) becomes lens.dof@1 artistic.
 */
export const DOF_BINS=8;
const BLUR_STEPS=[0,.5,1,1.5,2,3,4,6,8];
let calibration:number[]|undefined;
/** R(σ)/R(0) on a deterministic 1/f texture for the Gaussian blurs in BLUR_STEPS (monotone by construction). */
export function blurCalibration(){
  if(calibration)return calibration;
  const S=192,tex=new Float32Array(S*S);
  for(let y=0;y<S;y++)for(let x=0;x<S;x++)tex[y*S+x]=fbm(x/12,y/12,6,7);
  const ratio=(img:Float32Array)=>{const g1=gaussianBlur(img,S,S,1,1),g4=gaussianBlur(img,S,S,1,4);let a=0,b=0;for(let y=12;y<S-12;y++)for(let x=12;x<S-12;x++){const i=y*S+x;a+=Math.abs(img[i]-g1[i]);b+=Math.abs(img[i]-g4[i]);}return a/Math.max(1e-9,b);};
  const r0=ratio(tex),out:number[]=[];
  for(const s of BLUR_STEPS){const r=s>0?ratio(gaussianBlur(tex,S,S,1,s)):r0;out.push(Math.min(out.length?out[out.length-1]:1,r/r0));}
  return calibration=out;
}
/** Equivalent Gaussian blur (work pixels) for a relative ratio. */
export function blurForRatio(rel:number){
  const c=blurCalibration();
  if(rel>=c[0])return 0;
  for(let k=1;k<c.length;k++)if(rel>=c[k]){const t=(c[k-1]-rel)/Math.max(1e-9,c[k-1]-c[k]);return BLUR_STEPS[k-1]+t*(BLUR_STEPS[k]-BLUR_STEPS[k-1]);}
  return BLUR_STEPS[BLUR_STEPS.length-1];
}
export interface SharpBin {d:number;ratio:number;texture:number;n:number;sigma:number;}
export function sharpnessProfile(work:Work,sky:Uint8Array):SharpBin[]{
  const {w,h,Y,depth}=work,n=w*h,p=new Float32Array(n);for(let i=0;i<n;i++)p[i]=Math.max(0,Y[i])**(1/2.2);
  const g1=gaussianBlur(p,w,h,1,1),g4=gaussianBlur(p,w,h,1,4),bins:SharpBin[]=[];
  for(let b=0;b<DOF_BINS;b++){
    const lo=b/DOF_BINS,hi=(b+1)/DOF_BINS;let a=0,c=0,k=0;
    for(let i=0;i<n;i++){
      const d=depth[i];if(sky[i]||!Number.isFinite(d)||d<lo||(d>=hi&&!(b===DOF_BINS-1&&d<=1)))continue;
      const x=i%w,y=(i-x)/w;if(x<4||y<4||x>=w-4||y>=h-4)continue;
      a+=Math.abs(p[i]-g1[i]);c+=Math.abs(p[i]-g4[i]);k++;
    }
    if(k>=n*.015)bins.push({d:(lo+hi)/2,ratio:c>0?a/c:0,texture:k?c/k:0,n:k,sigma:0});
  }
  const textured=bins.filter(b=>b.texture>.006),rmax=Math.max(0,...textured.map(b=>b.ratio));
  for(const b of bins)b.sigma=b.texture>.006&&rmax>0?blurForRatio(b.ratio/rmax):NaN;
  return bins;
}
export interface DofFit {focus:number;focusRange:number;blurNear:number;blurFar:number;maxBlur:number;evidence:number;textured:number;bins:{d:number;add:number}[];}
/**
 * lens.dof@1 artistic parameters from reference and source profiles. The extra blur per bin (quadrature difference) is
 * fitted with the node's own CoC shape: σ(d) = (blur·W/4)·smoothstep ramp outside [focus ± range/2] (CoC diameter ≈ 4σ),
 * by a grid over focus/range with closed-form least squares for blurNear/blurFar. evidence = fit quality × blur size.
 */
export function fitDof(ref:SharpBin[],src:SharpBin[],workWidth:number):DofFit|undefined{
  const valid=ref.filter(b=>Number.isFinite(b.sigma));
  if(valid.length<3)return undefined;
  const srcValid=src.filter(x=>Number.isFinite(x.sigma));
  const add=valid.map(b=>{
    const s=srcValid.reduce<SharpBin|undefined>((best,x)=>!best||Math.abs(x.d-b.d)<Math.abs(best.d-b.d)?x:best,undefined);
    const ss=s&&Math.abs(s.d-b.d)<.2?s.sigma:0;
    return {d:b.d,add:Math.sqrt(Math.max(0,b.sigma*b.sigma-ss*ss)),n:b.n};
  });
  const px=workWidth/4,wsum=add.reduce((a,b)=>a+b.n,0),mean=add.reduce((a,b)=>a+b.n*b.add,0)/wsum,sst=add.reduce((a,b)=>a+b.n*(b.add-mean)**2,0);
  let best:{focus:number;range:number;near:number;far:number;sse:number}|undefined;
  for(let f=0;f<=1.0001;f+=.025)for(let r=.05;r<=.8001;r+=.05){
    const lo=f-r/2,hi=f+r/2,rn=add.map(b=>b.d<lo?smooth(lo,0,b.d):0),rf=add.map(b=>b.d>hi?smooth(hi,1,b.d):0);
    const ls=(rr:number[])=>{let num=0,den=0;add.forEach((b,i)=>{num+=b.n*b.add*rr[i];den+=b.n*rr[i]*rr[i];});return den>0?clamp(num/den/px,0,.05):0;};
    // Small penalty on the blur size: among equally good fits (few blurred bins) the smallest blur wins.
    const near=ls(rn),far=ls(rf),sse=add.reduce((a,b,i)=>a+b.n*(b.add-px*(near*rn[i]+far*rf[i]))**2,0)+.05*wsum*(px*(near+far))**2;
    if(!best||sse<best.sse-1e-9)best={focus:f,range:r,near,far,sse};
  }
  if(!best)return undefined;
  const r2=sst>1e-9?clamp(1-best.sse/sst):0,maxAdd=Math.max(...add.map(b=>b.add));
  return {focus:Math.round(clamp(best.focus)*100)/100,focusRange:Math.round(best.range*100)/100,blurNear:Math.round(best.near*1e4)/1e4,blurFar:Math.round(best.far*1e4)/1e4,
    maxBlur:Math.round(Math.max(.02,best.near,best.far)*1e4)/1e4,evidence:smooth(.6,2,maxAdd)*Math.sqrt(r2),textured:valid.length/Math.max(1,ref.length),bins:add.map(b=>({d:b.d,add:Math.round(b.add*100)/100}))};
}
