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
/** Mean over the (2r+1)² window clamped to the image (divides by the number of pixels inside). Single channel, O(N). */
export function boxMean(src:Float32Array,w:number,h:number,r:number){
  const tmp=new Float32Array(w*h),out=new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const o=y*w;let s=0;for(let x=0;x<=Math.min(w-1,r);x++)s+=src[o+x];
    for(let x=0;x<w;x++){
      const lo=x-r-1,hi=x+r;if(x>0){if(hi<w)s+=src[o+hi];if(lo>=0)s-=src[o+lo];}
      tmp[o+x]=s/(Math.min(w-1,hi)-Math.max(0,x-r)+1);
    }
  }
  for(let x=0;x<w;x++){
    let s=0;for(let y=0;y<=Math.min(h-1,r);y++)s+=tmp[y*w+x];
    for(let y=0;y<h;y++){
      const lo=y-r-1,hi=y+r;if(y>0){if(hi<h)s+=tmp[hi*w+x];if(lo>=0)s-=tmp[lo*w+x];}
      out[y*w+x]=s/(Math.min(h-1,hi)-Math.max(0,y-r)+1);
    }
  }
  return out;
}
/**
 * Color-guided filter (He, Sun, Tang, "Guided Image Filtering", TPAMI 2013, Alg. 2), fast variant with subsampling
 * (He & Sun 2015, arXiv:1505.00996): the linear coefficients are fitted on a grid subsampled by `s` and upsampled
 * bilinearly; q = ā·I + b̄ is evaluated with the full-resolution guide. `guide` holds three planes, `p` the filtered field,
 * r the window radius and eps the regularization, both in full-resolution units. Output follows the edges of the guide.
 */
export function guidedFilter(guide:Float32Array[],p:Float32Array,w:number,h:number,r:number,eps:number,s=1){
  s=Math.max(1,Math.floor(s));
  const sw=Math.max(1,Math.ceil(w/s)),sh=Math.max(1,Math.ceil(h/s)),sr=Math.max(1,Math.round(r/s)),n=sw*sh;
  const down=(v:Float32Array)=>{
    if(s===1)return v;
    const o=new Float32Array(n);
    for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){const x1=Math.min(w,(x+1)*s),y1=Math.min(h,(y+1)*s);let t=0;for(let yy=y*s;yy<y1;yy++)for(let xx=x*s;xx<x1;xx++)t+=v[yy*w+xx];o[y*sw+x]=t/((x1-x*s)*(y1-y*s));}
    return o;
  };
  const I=guide.map(down),P=down(p),box=(v:Float32Array)=>boxMean(v,sw,sh,sr),prod=(a:Float32Array,b:Float32Array)=>{const o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=a[i]*b[i];return o;};
  const mI=I.map(box),mP=box(P),mIP=I.map(c=>box(prod(c,P)));
  const vRR=box(prod(I[0],I[0])),vRG=box(prod(I[0],I[1])),vRB=box(prod(I[0],I[2])),vGG=box(prod(I[1],I[1])),vGB=box(prod(I[1],I[2])),vBB=box(prod(I[2],I[2]));
  const A=[0,1,2].map(()=>new Float32Array(n)),B=new Float32Array(n);
  for(let i=0;i<n;i++){
    const r0=mI[0][i],g0=mI[1][i],b0=mI[2][i],m=mP[i];
    const cr=mIP[0][i]-r0*m,cg=mIP[1][i]-g0*m,cb=mIP[2][i]-b0*m;
    const rr=vRR[i]-r0*r0+eps,rg=vRG[i]-r0*g0,rb=vRB[i]-r0*b0,gg=vGG[i]-g0*g0+eps,gb=vGB[i]-g0*b0,bb=vBB[i]-b0*b0+eps;
    // Inverse of the symmetric 3×3 covariance (+eps·U) via cofactors.
    const c00=gg*bb-gb*gb,c01=rb*gb-rg*bb,c02=rg*gb-rb*gg,c11=rr*bb-rb*rb,c12=rb*rg-rr*gb,c22=rr*gg-rg*rg,det=rr*c00+rg*c01+rb*c02;
    const a0=(c00*cr+c01*cg+c02*cb)/det,a1=(c01*cr+c11*cg+c12*cb)/det,a2=(c02*cr+c12*cg+c22*cb)/det;
    A[0][i]=a0;A[1][i]=a1;A[2][i]=a2;B[i]=m-a0*r0-a1*g0-a2*b0;
  }
  const mA=A.map(box),mB=box(B),q=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,fx=(x+.5)/s,fy=(y+.5)/s;
    q[i]=sampleBilinear(mA[0],sw,sh,1,fx,fy,0)*guide[0][i]+sampleBilinear(mA[1],sw,sh,1,fx,fy,0)*guide[1][i]+sampleBilinear(mA[2],sw,sh,1,fx,fy,0)*guide[2][i]+sampleBilinear(mB,sw,sh,1,fx,fy,0);
  }
  return q;
}
