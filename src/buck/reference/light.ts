import type { RGB } from '../types';
import { blur1, clamp, normY, quantile, rgbToKelvin, smooth } from './common';
import type { Work } from './common';
/**
 * Light color vs. material color (heuristic, no intrinsic-image decomposition). Three classic color-constancy estimates
 * on the non-sky, unclipped pixels, combined as a geometric mean:
 *  - Gray-Edge, 1st order, Minkowski p = 6, σ = 1 px (van de Weijer, Gevers, Gijsenij, „Edge-Based Color Constancy“,
 *    IEEE TIP 16(9), 2007): the average edge (derivative) color is achromatic under neutral light;
 *  - White-Patch on bright, low-saturation surfaces (top 5 % luminance among pixels whose color is close to the current
 *    light estimate; clipped pixels excluded);
 *  - Shades-of-Gray (p = 4, Finlayson & Trezzi 2004) of the large-scale image (Gaussian σ = 8 % image width), i.e. the
 *    illumination component in the Retinex sense (Land & McCann 1971; Jobson et al. 1997).
 * Large saturated material areas (a red wall) are detected relative to the current light estimate (saturation after
 * dividing by it, Gaussian area share at σ = 4 % width) and down-weighted; two iterations. The resulting per-pixel weight
 * is also used to subsample the pixels that src/color/analysis.ts sees for the color match.
 */
export interface LightEstimate {
  /** Light color, linear Rec.709, luminance 1. */
  rgb:RGB;kelvin:number;duv:number;confidence:number;
  estimates:{grayEdge:RGB;whitePatch:RGB;largeScale:RGB};
  /** Max angle between the three estimates in degrees (agreement). */
  spreadDeg:number;
  /** Per work pixel: 1 = full weight, down to 0.15 for large saturated material areas; 0 for sky/clipped/black. */
  weights:Float32Array;
  /** Share of valid pixels classified as large saturated material. */
  materialShare:number;
}
const P_EDGE=6,P_LOW=4,SIGMA_EDGE=1,LOW_SIGMA=.08,AREA_SIGMA=.04,MIN_WEIGHT=.15;
const angle=(a:RGB,b:RGB)=>{const d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2],l=Math.hypot(...a)*Math.hypot(...b);return l>0?Math.acos(clamp(d/l,-1,1))*180/Math.PI:90;};
function geoMean(list:RGB[]):RGB{
  const s=[0,0,0];for(const c of list){const n=normY(c);for(let k=0;k<3;k++)s[k]+=Math.log(Math.max(1e-6,n[k]));}
  return normY(s.map(v=>Math.exp(v/list.length)) as RGB);
}
function minkowski(planes:Float32Array[],wt:Float32Array,p:number):RGB{
  const s=[0,0,0];let ws=0;
  for(let i=0;i<wt.length;i++){const w=wt[i];if(!(w>0))continue;ws+=w;for(let c=0;c<3;c++)s[c]+=w*Math.abs(planes[c][i])**p;}
  return ws>0?normY(s.map(v=>(v/ws)**(1/p)) as RGB):[1,1,1];
}
export function estimateLight(work:Work,sky:Uint8Array):LightEstimate{
  const {w,h,rgb,Y}=work,n=w*h;
  const valid=new Uint8Array(n);let validCount=0;
  for(let i=0;i<n;i++){const mx=Math.max(rgb[i*3],rgb[i*3+1],rgb[i*3+2]);if(!sky[i]&&mx<.98&&Y[i]>.003){valid[i]=1;validCount++;}}
  // Masked blurs (blur(v·m)/blur(m)): sky and clipped pixels must not bleed into the edges and the large-scale estimate.
  const vm=new Float32Array(n);for(let i=0;i<n;i++)vm[i]=valid[i];
  const masked=(p:Float32Array,sigma:number)=>{const a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=p[i]*vm[i];const b=blur1(a,w,h,sigma),m=blur1(vm,w,h,sigma);for(let i=0;i<n;i++)b[i]=m[i]>1e-3?b[i]/m[i]:0;return b;};
  const planes=[0,1,2].map(c=>{const p=new Float32Array(n);for(let i=0;i<n;i++)p[i]=rgb[i*3+c];return p;});
  const fine=planes.map(p=>masked(p,SIGMA_EDGE)),low=planes.map(p=>masked(p,LOW_SIGMA*w));
  // Edge pixels next to the sky or a clipped area mix two regions; they are left out of Gray-Edge.
  const core=blur1(vm,w,h,1.5);
  const grad=fine.map(p=>{const g=new Float32Array(n);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;
    const gx=(p[y*w+Math.min(w-1,x+1)]-p[y*w+Math.max(0,x-1)])/2,gy=(p[Math.min(h-1,y+1)*w+x]-p[Math.max(0,y-1)*w+x])/2;g[i]=Math.hypot(gx,gy);}return g;});
  let weights=new Float32Array(n);for(let i=0;i<n;i++)weights[i]=valid[i];
  let e:RGB=[1,1,1],est={grayEdge:[1,1,1] as RGB,whitePatch:[1,1,1] as RGB,largeScale:[1,1,1] as RGB},material=new Float32Array(n);
  for(let iter=0;iter<3;iter++){
    // Saturation after removing the current light estimate: what stays colorful is (probably) material color.
    const sat=new Float32Array(n);
    for(let i=0;i<n;i++){if(!valid[i])continue;const r=rgb[i*3]/e[0],g=rgb[i*3+1]/e[1],b=rgb[i*3+2]/e[2],mx=Math.max(r,g,b),mn=Math.min(r,g,b);sat[i]=mx>1e-5?(mx-mn)/mx:0;}
    if(iter>0){
      const strong=new Float32Array(n);for(let i=0;i<n;i++)strong[i]=valid[i]?smooth(.35,.6,sat[i]):0;
      const area=blur1(strong,w,h,AREA_SIGMA*w);
      material=new Float32Array(n);weights=new Float32Array(n);
      for(let i=0;i<n;i++){if(!valid[i])continue;material[i]=strong[i]*smooth(.25,.55,area[i]);weights[i]=1-(1-MIN_WEIGHT)*material[i];}
    }
    const edgeW=new Float32Array(n);for(let i=0;i<n;i++)edgeW[i]=core[i]>.97?weights[i]:0;
    const grayEdge=minkowski(grad,edgeW,P_EDGE),largeScale=minkowski(low,weights,P_LOW);
    // White patch: bright pixels whose color is close to the current estimate (low corrected saturation).
    const yThr=quantile(Y,.95,i=>weights[i]>.5&&sat[i]<.25);
    let wr=0,wg=0,wb=0,wn=0;
    if(Number.isFinite(yThr))for(let i=0;i<n;i++)if(weights[i]>.5&&sat[i]<.25&&Y[i]>=yThr){wr+=rgb[i*3];wg+=rgb[i*3+1];wb+=rgb[i*3+2];wn++;}
    const whitePatch:RGB=wn>0?normY([wr,wg,wb]):grayEdge;
    est={grayEdge,whitePatch,largeScale};e=geoMean([grayEdge,whitePatch,largeScale]);
  }
  const spreadDeg=Math.max(angle(est.grayEdge,est.whitePatch),angle(est.grayEdge,est.largeScale),angle(est.whitePatch,est.largeScale));
  let mat=0,wsum=0;for(let i=0;i<n;i++){if(valid[i]){wsum++;if(material[i]>.5)mat++;}}
  const coverage=validCount/n,{kelvin,duv}=rgbToKelvin(e);
  const confidence=clamp(1-spreadDeg/14)*clamp(coverage/.25)*(Math.abs(duv)>.03?.6:1);
  return {rgb:e,kelvin,duv,confidence,estimates:est,spreadDeg,weights,materialShare:wsum?mat/wsum:0};
}
/** Plain gray world (mean RGB of the valid pixels) – only for tests/documentation: shows the material bias that estimateLight avoids. */
export function grayWorld(work:Work,sky:Uint8Array):RGB{
  const s=[0,0,0];let k=0;for(let i=0;i<work.w*work.h;i++){if(sky[i]||work.Y[i]<=.003)continue;for(let c=0;c<3;c++)s[c]+=work.rgb[i*3+c];k++;}
  return k?normY(s as RGB):[1,1,1];
}
