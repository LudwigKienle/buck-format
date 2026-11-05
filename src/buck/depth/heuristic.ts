import { convertImage } from '../colorspace';
import { normalsFromDepth } from '../aux/normals';
import { clamp01, gaussianBlur, gaussianBlurWide, resample, scalarField, vectorField } from '../field';
import { extremeFilter } from '../nodes/masks';
import { BuckError } from '../types';
import type { ImageBuf, ScalarField, VectorField } from '../types';
import { skyRegion } from '../reference/timeofday';
/**
 * BEHELF, keine Tiefenmessung: a deterministic monocular guess for when no model or depth upload is available.
 * Cues: vertical position (top = far), haze via the dark channel prior (He, Sun, Tang, CVPR 2009: t = 1 - ω·dark,
 * depth ∝ -ln t), low local contrast and low saturation (aerial perspective). Cue weights and filter radii are
 * hand-chosen assumptions, not fitted values. Output 0 = near … 1 = far, always finite.
 */
export const HEURISTIC_LABEL='Behelf: Bildheuristik';
const WORK_SIDE=256;
const WEIGHTS={position:.45,haze:.25,contrast:.15,saturation:.15};
const OMEGA=.95,T_MIN=.1; // He et al. 2009 defaults

/** Robust 2 %…98 % percentile stretch to 0…1; a (nearly) constant field becomes 0. */
function stretch(v:Float32Array){
  const sorted=Float32Array.from(v).sort(),q=(p:number)=>sorted[Math.floor(p*(sorted.length-1))],lo=q(.02),hi=q(.98),out=new Float32Array(v.length);
  if(!(hi-lo>1e-6))return out;
  for(let i=0;i<v.length;i++)out[i]=clamp01((v[i]-lo)/(hi-lo));
  return out;
}
/** Square min filter (separable, clamped edges). */
function minFilter(v:Float32Array,w:number,h:number,r:number){
  const tmp=new Float32Array(v.length),out=new Float32Array(v.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=Infinity;for(let i=Math.max(0,x-r);i<=Math.min(w-1,x+r);i++)m=Math.min(m,v[y*w+i]);tmp[y*w+x]=m;}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=Infinity;for(let j=Math.max(0,y-r);j<=Math.min(h-1,y+r);j++)m=Math.min(m,tmp[j*w+x]);out[y*w+x]=m;}
  return out;
}
/** Area-average downscale of sRGB code values (RGBA, clipped to 0…1) into three planes. */
function downscale(src:Float32Array,W:number,H:number,w:number,h:number){
  const planes=[0,1,2].map(()=>new Float32Array(w*h));
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*H/h),y1=Math.max(y0+1,Math.floor((y+1)*H/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*W/w),x1=Math.max(x0+1,Math.floor((x+1)*W/w)),n=(y1-y0)*(x1-x0);
      for(let c=0;c<3;c++){let s=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++){const v=src[(yy*W+xx)*4+c];s+=v>0?(v<1?v:1):0;}planes[c][y*w+x]=s/n;}
    }
  }
  return planes;
}
export function heuristicDepth(image:ImageBuf):ScalarField {
  const W=image.width,H=image.height;
  if(!(Number.isInteger(W)&&Number.isInteger(H)&&W>0&&H>0)||image.data.length<W*H*4)throw new BuckError('Das Bild für die Behelfstiefe ist leer oder unvollständig.');
  const s=Math.min(1,WORK_SIDE/Math.max(W,H)),w=Math.max(1,Math.round(W*s)),h=Math.max(1,Math.round(H*s)),n=w*h,side=Math.max(w,h);
  const srgb=convertImage(image,'sRGB - Display').data,[r,g,b]=downscale(srgb,W,H,w,h),patch=Math.max(1,Math.round(.012*side)),sigma=Math.max(1,.02*side);
  const position=new Float32Array(n),minRgb=new Float32Array(n),luma=new Float32Array(n),luma2=new Float32Array(n),sat=new Float32Array(n);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,mx=Math.max(r[i],g[i],b[i]),mn=Math.min(r[i],g[i],b[i]),l=.2126*r[i]+.7152*g[i]+.0722*b[i];
    position[i]=h>1?1-y/(h-1):.5;minRgb[i]=mn;luma[i]=l;luma2[i]=l*l;sat[i]=mx>1e-4?(mx-mn)/mx:0;
  }
  // Airlight: brightest pixel among the top 0.1 % of the dark channel, first in scan order on ties.
  const dark0=minFilter(minRgb,w,h,patch),k=Math.max(1,Math.floor(n*.001)),threshold=Float32Array.from(dark0).sort()[n-k];
  let best=-1,A=[1,1,1];
  for(let i=0;i<n;i++)if(dark0[i]>=threshold&&r[i]+g[i]+b[i]>best){best=r[i]+g[i]+b[i];A=[r[i],g[i],b[i]];}
  A=A.map(v=>Math.max(1e-3,v));
  const norm=new Float32Array(n);for(let i=0;i<n;i++)norm[i]=Math.min(r[i]/A[0],g[i]/A[1],b[i]/A[2]);
  const dark=minFilter(norm,w,h,patch),haze=new Float32Array(n);
  for(let i=0;i<n;i++)haze[i]=-Math.log(Math.max(T_MIN,1-OMEGA*dark[i]));
  const mean=gaussianBlur(luma,w,h,1,sigma),mean2=gaussianBlur(luma2,w,h,1,sigma),contrast=new Float32Array(n);
  for(let i=0;i<n;i++)contrast[i]=Math.sqrt(Math.max(0,mean2[i]-mean[i]*mean[i]));
  const hz=stretch(haze),ct=stretch(contrast),st=stretch(gaussianBlur(sat,w,h,1,sigma)),mix=new Float32Array(n);
  for(let i=0;i<n;i++)mix[i]=WEIGHTS.position*position[i]+WEIGHTS.haze*hz[i]+WEIGHTS.contrast*(1-ct[i])+WEIGHTS.saturation*(1-st[i]);
  const depth=stretch(gaussianBlur(mix,w,h,1,Math.max(1,.015*side))),out=resample(depth,w,h,1,W,H);
  for(let i=0;i<out.length;i++)out[i]=clamp01(out[i]);
  markSky(srgb,W,H,[r,g,b],depth,w,h,out);
  return scalarField(W,H,out);
}
/**
 * Marks the sky as invalid depth (+Infinity), as a depth model does, so sky-dependent nodes (sky.replace) also work on
 * the stand-in depth. Uses the image-based sky region of the reference analysis (grown from the top border over smooth,
 * far pixels), refined at a higher resolution by refineSky; no sky found leaves the depth unchanged.
 */
function markSky(srgb:Float32Array,W:number,H:number,[r,g,b]:Float32Array[],depth:Float32Array,w:number,h:number,out:Float32Array){
  if(w<8||h<8)return;
  // The sky search expects linear light: decode the sRGB code values of the downscaled planes.
  const lin=(v:number)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4,n=w*h,rgb=new Float32Array(n*3),Y=new Float32Array(n);
  for(let i=0;i<n;i++){const R=lin(r[i]),G=lin(g[i]),B=lin(b[i]);rgb[i*3]=R;rgb[i*3+1]=G;rgb[i*3+2]=B;Y[i]=.2126*R+.7152*G+.0722*B;}
  const sky=skyRegion({w,h,rgb,Y,depth:Float32Array.from(depth),depthKind:'heuristic'},true);
  if(sky.kind!=='image')return;
  const s=Math.min(1,REFINE_SIDE/Math.max(W,H)),rw=Math.max(1,Math.round(W*s)),rh=Math.max(1,Math.round(H*s));
  const mask=new Float32Array(n);for(let i=0;i<n;i++)mask[i]=sky.mask[i];
  const fine=refineSky(downscale(srgb,W,H,rw,rh),resample(mask,w,h,1,rw,rh),rw,rh),up=resample(fine,rw,rh,1,W,H);
  // refineSky stops a pixel or two short of a silhouette. Those pixels of old sky would count as ground and catch added light
  // (a bright line along every edge), so the mask reaches over them; the color matte of sky.replace then finds the exact edge.
  const hard=new Float32Array(out.length);for(let i=0;i<out.length;i++)hard[i]=up[i]>=.5?1:0;
  const reach=extremeFilter(hard,W,H,Math.max(1,Math.round(SKY_REACH*W)),true);
  for(let i=0;i<out.length;i++)if(reach[i]>0)out[i]=Infinity;
}
const SKY_REACH=.0015,REFINE_SIDE=1024,REFINE_BAND=.035,CLOUD_RUN=.15,CLOUD_LUMA=.8,CLOUD_STEP=.02,CLOUD_SD=.03;
/**
 * The coarse sky search accepts only smooth pixels, so it stops short of every silhouette by roughly its blur radius. Inside a
 * band of REFINE_BAND image widths around the coarse sky, a pixel joins the sky when (1) its color lies within half the
 * distance |S−F| of the local sky color S (mean of the coarse sky nearby), F being the local foreground color (mean outside
 * the band nearby), (2) it is as smooth as the sky: 3×3 standard deviation of log luminance at most twice the 95th percentile
 * inside the coarse sky (floor 0.02), which keeps hazy, sky-colored but textured distant ridges out, and (3) it is 4-connected
 * to the coarse sky through such pixels. Where S and F are hardly distinguishable the pixel stays foreground; the remaining
 * one or two pixels at a silhouette are left to the color matte of sky.replace. Bright clouds that touch a ridge are added
 * afterwards (see below). Input: sRGB planes and the upsampled coarse
 * mask; output 0/1 at the same size.
 */
function refineSky(planes:Float32Array[],coarse:Float32Array,w:number,h:number){
  const n=w*h,band=Math.max(2,Math.round(REFINE_BAND*Math.max(w,h))),sky=new Float32Array(n);
  for(let i=0;i<n;i++)sky[i]=coarse[i]>=.5?1:0;
  const near=extremeFilter(sky,w,h,band,true),fgW=new Float32Array(n),sNum=new Float32Array(n*3),fNum=new Float32Array(n*3);
  for(let i=0;i<n;i++){fgW[i]=1-near[i];for(let c=0;c<3;c++){const v=planes[c][i];sNum[i*3+c]=v*sky[i];fNum[i*3+c]=v*fgW[i];}}
  const sigma=band,sB=gaussianBlurWide(sNum,w,h,3,sigma),sW=gaussianBlurWide(sky,w,h,1,sigma),fB=gaussianBlurWide(fNum,w,h,3,sigma),fW=gaussianBlurWide(fgW,w,h,1,sigma);
  const sd=localLogStd(planes,w,h),skySd:number[]=[];
  for(let i=0;i<n;i++)if(sky[i])skySd.push(sd[i]);
  skySd.sort((a,b)=>a-b);
  const smooth=Math.max(.02,2*(skySd[Math.floor(.95*(skySd.length-1))]??0)),accept=new Uint8Array(n);
  for(let i=0;i<n;i++){
    if(sky[i]||!near[i]||sd[i]>smooth||sW[i]<1e-4||fW[i]<1e-4)continue;
    let dd=0,cs=0,ss=0,ff=0;
    for(let c=0;c<3;c++){const S=sB[i*3+c]/sW[i],F=fB[i*3+c]/fW[i],d=S-F,e=planes[c][i]-S;dd+=d*d;cs+=e*e;ss+=S*S;ff+=F*F;}
    if(dd>.004*(ss+ff)&&cs<.25*dd)accept[i]=1;
  }
  const queue:number[]=[];
  for(let i=0;i<n;i++)if(sky[i])queue.push(i);
  for(let q=0;q<queue.length;q++){
    const i=queue[q],x=i%w,y=(i-x)/w;
    for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1])if(j>=0&&accept[j]&&!sky[j]){sky[j]=1;queue.push(j);}
  }
  // Clouds touching a ridge are not enclosed by sky, so the hole filling of the coarse search misses them. A vertical run of
  // non-sky pixels with sky directly above and below (at most CLOUD_RUN image heights long) floats in the sky; it joins when
  // its mean luminance is at least CLOUD_LUMA of the local sky's. Ridges, trees and figures have ground below them.
  const luma=(v:(c:number)=>number)=>.2126*v(0)+.7152*v(1)+.0722*v(2),maxRun=Math.max(1,Math.round(CLOUD_RUN*h));
  const cloud:number[]=[];
  for(let x=0;x<w;x++){
    let y=1;
    while(y<h-1){
      if(sky[y*w+x]||!sky[(y-1)*w+x]){y++;continue;}
      let e=y;while(e<h&&!sky[e*w+x])e++;
      if(e<h&&e-y<=maxRun){
        let yc=0,ys=0,k=0;
        for(let t=y;t<e;t++){const i=t*w+x;yc+=luma(c=>planes[c][i]);if(sW[i]>1e-4){ys+=luma(c=>sB[i*3+c]/sW[i]);k++;}}
        if(k&&yc>=CLOUD_LUMA*ys)for(let t=y;t<e;t++){const i=t*w+x;sky[i]=1;cloud.push(i);}
      }
      y=e+1;
    }
  }
  // The columns that rest on the ridge have no sky below and would stay behind with a straight edge: the cloud grows sideways from
  // the runs found above into 4-connected pixels of nearly the same color (a darker ridge or a textured wall stops it).
  for(let q=0;q<cloud.length;q++){
    const i=cloud[q],x=i%w,y=(i-x)/w;
    for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1]){
      if(j<0||sky[j]||sd[j]>CLOUD_SD)continue;
      let far=false;for(let c=0;c<3;c++)if(Math.abs(planes[c][j]-planes[c][i])>CLOUD_STEP)far=true;
      if(!far){sky[j]=1;cloud.push(j);}
    }
  }
  return sky;
}
/** 3×3 standard deviation of log luminance (sRGB code values, Rec.709 weights; clamped edges). */
function localLogStd([r,g,b]:Float32Array[],w:number,h:number){
  const n=w*h,l=new Float32Array(n),out=new Float32Array(n);
  for(let i=0;i<n;i++)l[i]=Math.log(.2126*r[i]+.7152*g[i]+.0722*b[i]+1e-3);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let s=0,s2=0,k=0;
    for(let j=Math.max(0,y-1);j<=Math.min(h-1,y+1);j++)for(let i=Math.max(0,x-1);i<=Math.min(w-1,x+1);i++){const v=l[j*w+i];s+=v;s2+=v*v;k++;}
    const m=s/k;out[y*w+x]=Math.sqrt(Math.max(0,s2/k-m*m));
  }
  return out;
}
const NORMAL_SIGMA=.04,NORMAL_SCALE=.2,NORMAL_GRID=256;
/**
 * Normals for the stand-in depth. Its bumps are no surfaces: a "near" blob above something farther (a figure, the front of a
 * mesa) would give normals facing down, away from any light, and relight would leave dark smudges there. So only a ground
 * assumption is used: per column the depth may only grow toward the top of the image (running maximum from the bottom), then
 * a wide blur (NORMAL_SIGMA image widths) and a flatter scale (NORMAL_SCALE, the depth has no real scale). Normals thus face
 * upward with a gentle variation, invalid depth (sky) stays (0,0,0). Editor stand-in only; declared normals still derive from depth.
 */
export function heuristicNormals(depth:ScalarField):VectorField {
  const {width:W,height:H,data}=depth,mono=new Float32Array(W*H);
  for(let x=0;x<W;x++){
    let m=0;
    for(let y=H-1;y>=0;y--){const v=data[y*W+x];if(Number.isFinite(v)&&v>m)m=v;mono[y*W+x]=m;}
  }
  // On a small grid and interpolated afterwards: the fields are smooth anyway, and gradients of a blur upsampled at full size would show its grid.
  const s=Math.min(1,NORMAL_GRID/Math.max(W,H)),w=Math.max(1,Math.round(W*s)),h=Math.max(1,Math.round(H*s));
  const soft=gaussianBlur(boxDown(mono,W,H,w,h),w,h,1,NORMAL_SIGMA*w);
  for(let i=0;i<soft.length;i++)soft[i]*=NORMAL_SCALE;
  const up=resample(normalsFromDepth(scalarField(w,h,soft),0).data,w,h,3,W,H),out=vectorField(W,H),o=out.data;
  for(let i=0;i<W*H;i++){
    if(!Number.isFinite(data[i]))continue; // invalid depth keeps (0,0,0)
    const j=i*3,len=Math.hypot(up[j],up[j+1],up[j+2])||1;
    o[j]=up[j]/len;o[j+1]=up[j+1]/len;o[j+2]=up[j+2]/len;
  }
  return out;
}
/** Area-average downscale of one scalar plane. */
function boxDown(src:Float32Array,W:number,H:number,w:number,h:number){
  const out=new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*H/h),y1=Math.max(y0+1,Math.floor((y+1)*H/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*W/w),x1=Math.max(x0+1,Math.floor((x+1)*W/w));
      let t=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++)t+=src[yy*W+xx];
      out[y*w+x]=t/((y1-y0)*(x1-x0));
    }
  }
  return out;
}
