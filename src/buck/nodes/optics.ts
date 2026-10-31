import { colorValueToRGB, convertPixel, isLinearSpace, lumaWeights } from '../colorspace';
import { gaussianBlur, gaussianBlurWide, imageBuf, smoothstep } from '../field';
import { hash3 } from './sky';
import { BuckError } from '../types';
import type { Buf, GrainParams, ImageBuf, NodeImpl, Resolved, RGB, VignetteParams } from '../types';
/**
 * Optics level (spec §5.3.6–§5.3.8): lens.vignette@1, film.grain@1, film.halation@1. All three work in the linear working
 * space, take lengths in image widths (§4.4) and contain no random numbers: grain is an integer hash of a lattice fixed in
 * image-width units plus the frame number, so the same frame always gets the same grain and a proxy render shows the same
 * pattern at a smaller scale. `mask` and `amount` are mixed by render.ts.
 */
const linearImage=(inputs:Record<string,Buf|undefined>,what:string):ImageBuf=>{
  const image=inputs.image;
  if(!image||image.kind!=='image')throw new BuckError(`${what}: Bildeingang fehlt.`);
  if(!isLinearSpace(image.space))throw new BuckError(`${what} braucht einen linearen Farbraum, Eingang ist „${image.space}“. Davor einen Konvertierungsknoten setzen.`);
  return image;
};

// ---------------------------------------------------------------- lens.vignette@1
type VP=Resolved<VignetteParams>;
/**
 * Falloff f ∈ [0, 1] at normalized (u, v) (image widths): elliptical distance d = hypot(u − cx, (v − cy)·k) with
 * k = 1 + (W/H − 1)·(1 − roundness), so roundness 0 follows the frame and 1 is a circle; f = smoothstep(radius, radius + softness, d).
 */
export function vignetteFalloff(u:number,v:number,p:Pick<VP,'radius'|'softness'|'roundness'>,cx:number,cy:number,aspect:number){
  const r=Math.min(1,Math.max(0,p.roundness)),k=1+(aspect-1)*(1-r),d=Math.hypot(u-cx,(v-cy)*k),r0=Math.max(0,p.radius);
  return smoothstep(r0,r0+Math.max(0,p.softness),d);
}
/** Gain at falloff f: 1 − strength·f, or 2^(exposure·f) when the falloff is given in EV. Never negative. */
export const vignetteGain=(f:number,p:Pick<VP,'strength'|'exposure'>)=>p.exposure!==undefined?2**(p.exposure*f):Math.max(0,1-(p.strength??0)*f);

export const vignetteNode:NodeImpl<'lens.vignette@1'>={
  type:'lens.vignette@1',
  evaluate(inputs,p,_ctx){
    void _ctx;
    const image=linearImage(inputs,'Vignette'),{width:W,height:H}=image,src=image.data;
    if((p.strength===undefined)===(p.exposure===undefined))throw new BuckError('Vignette: genau einer der Parameter „strength“ oder „exposure“ muss gesetzt sein.');
    const cx=p.center?.[0]??.5,cy=p.center?.[1]??H/W/2,aspect=W/H,out=imageBuf(W,H,image.space,new Float32Array(src)),o=out.data;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const g=vignetteGain(vignetteFalloff((x+.5)/W,(y+.5)/W,p,cx,cy,aspect),p);
      if(g===1)continue;
      const j=(y*W+x)*4;o[j]=src[j]*g;o[j+1]=src[j+1]*g;o[j+2]=src[j+2]*g;
    }
    return out;
  },
};

// ---------------------------------------------------------------- film.grain@1
type GP=Resolved<GrainParams>;
/**
 * Fixed constants of @1. The grain field is white noise on square cells of `size` image widths, filtered with a Gaussian of
 * σ = blur·size (Newson et al. 2017 filter their Boolean model with one Gaussian, too). `norm` = 1/0.48606 makes the continuous
 * field unit RMS: for σ = 0.5 cell the mean over a cell of Σᵢ(Φ((i+1−x)/σ) − Φ((i−x)/σ))² is 0.48606 per axis.
 * `toneGamma` shifts the Boolean-model variance peak u(1 − u) to t ≈ 0.37 (shadows/mid-tones).
 */
export const GRAIN={blur:.5,norm:1/.48606,toneGamma:.7,displayGamma:1/2.4};
/** Seed of one field: user seed, frame (when animated) and channel (0–2 per channel, 3 = monochrome) mixed by multiplication. */
export function grainSeed(seed:number,frame:number,channel:number){
  return (Math.imul((seed|0)^0x5bd1e995,0x27d4eb2d)^Math.imul(Math.floor(frame)|0,0x165667b1)^Math.imul(channel+1,0x9e3779b1))|0;
}
/** Approximately Gaussian cell value with unit variance: sum of three hashes (Irwin–Hall, n = 3), centered and scaled by 2. */
export const latticeNoise=(i:number,j:number,s:number)=>(hash3(i,j,s)+hash3(i,j,s+1)+hash3(i,j,s+2)-1.5)*2;
/**
 * Boolean-model tone weight (Newson et al. 2017: the coverage variance of a Boolean grain model is u(1 − u)): t is the
 * display-like tone clamp(Y)^(1/2.4), u = t^0.7, weight 2·√(u(1 − u)) (1 at u = 0.5, 0 for black and white), blended with 1 by `response`.
 */
export function grainWeight(y:number,response:number){
  const t=Math.min(1,Math.max(0,y))**GRAIN.displayGamma,u=t**GRAIN.toneGamma,w=2*Math.sqrt(Math.max(0,u*(1-u))),r=Math.min(1,Math.max(0,response));
  return 1+r*(w-1);
}
/** Exact overlap weights of pixel k (covering [k, k+1)/px cells) with the cells it touches, normalized to sum 1. */
function axisWeights(pixels:number,cellPx:number){
  const first=new Int32Array(pixels),w:Float64Array[]=[];
  for(let k=0;k<pixels;k++){
    const a=k/cellPx,b=(k+1)/cellPx,i0=Math.floor(a),i1=Math.ceil(b)-1,row=new Float64Array(i1-i0+1);
    for(let i=i0;i<=i1;i++)row[i-i0]=(Math.min(b,i+1)-Math.max(a,i))/(b-a);
    first[k]=i0;w.push(row);
  }
  return {first,w};
}
/**
 * Grain field at every pixel (n·channels, channels 1 or 3): the area average of the cell noise over each pixel (exact for
 * piecewise-constant cells, so cells smaller than a pixel average out like in a downscaled scan), then a Gaussian of
 * σ = 0.5·size·W px, times `norm`. Cell (i, j) covers [i, i+1)·size × [j, j+1)·size in image widths.
 */
export function grainField(W:number,H:number,p:Pick<GP,'size'|'chroma'|'seed'|'animate'>,frame:number):{data:Float32Array;channels:1|3}{
  const size=Math.max(1e-5,p.size),cellPx=size*W,fr=p.animate?frame:0,c=Math.min(1,Math.max(0,p.chroma));
  const wx=axisWeights(W,cellPx),wy=axisWeights(H,cellPx),nx=Math.ceil(W/cellPx)+1,ny=Math.ceil(H/cellPx)+1;
  const field=(seed:number)=>{
    // Rows of cells reduced to pixel columns, then cell rows reduced to pixel rows (separable area average).
    const rows=new Float32Array(ny*W),cell=new Float32Array(nx),out=new Float32Array(W*H);
    for(let j=0;j<ny;j++){
      for(let i=0;i<nx;i++)cell[i]=latticeNoise(i,j,seed);
      for(let x=0;x<W;x++){const r=wx.w[x],i0=wx.first[x];let v=0;for(let k=0;k<r.length;k++)v+=r[k]*cell[i0+k];rows[j*W+x]=v;}
    }
    for(let y=0;y<H;y++){const r=wy.w[y],j0=wy.first[y];for(let x=0;x<W;x++){let v=0;for(let k=0;k<r.length;k++)v+=r[k]*rows[(j0+k)*W+x];out[y*W+x]=v;}}
    return out;
  };
  const mono=field(grainSeed(p.seed,fr,3)),per=c>0?[0,1,2].map(ch=>field(grainSeed(p.seed,fr,ch))):undefined;
  let data:Float32Array,channels:1|3;
  if(per){
    const k=1/Math.hypot(1-c,c);data=new Float32Array(W*H*3);channels=3;
    for(let i=0;i<W*H;i++)for(let ch=0;ch<3;ch++)data[i*3+ch]=((1-c)*mono[i]+c*per[ch][i])*k;
  }else{data=mono;channels=1;}
  const blurred=gaussianBlur(data,W,H,channels,GRAIN.blur*cellPx);
  for(let i=0;i<blurred.length;i++)blurred[i]*=GRAIN.norm;
  return {data:blurred,channels};
}
export const grainNode:NodeImpl<'film.grain@1'>={
  type:'film.grain@1',
  evaluate(inputs,p,ctx){
    const image=linearImage(inputs,'Filmkorn'),{width:W,height:H}=image,src=image.data,out=imageBuf(W,H,image.space,new Float32Array(src)),o=out.data;
    if(!(p.intensity>0))return out;
    if(!Number.isFinite(ctx.frame))throw new BuckError('Filmkorn: Die Frame-Nummer ist keine endliche Zahl.');
    const field=grainField(W,H,p,ctx.frame),wt=lumaWeights(image.space),f=field.data;
    for(let i=0,n=W*H;i<n;i++){
      const j=i*4,a=p.intensity*grainWeight(wt[0]*src[j]+wt[1]*src[j+1]+wt[2]*src[j+2],p.response);
      if(a===0)continue;
      if(field.channels===1){const k=2**(a*f[i]);o[j]=src[j]*k;o[j+1]=src[j+1]*k;o[j+2]=src[j+2]*k;}
      else for(let c=0;c<3;c++)o[j+c]=src[j+c]*2**(a*f[i*3+c]);
    }
    return out;
  },
};

// ---------------------------------------------------------------- film.halation@1
/** Fixed constants of @1: three Gaussians (σ = radius·{0.5, 1, 2}) with weights {0.25, 0.5, 0.25} approximate a heavy-tailed halo. */
export const HALATION={scales:[.5,1,2],weights:[.25,.5,.25]};
/** Highlight weight: smoothstep over log2(Y/threshold) from −knee/2 to +knee/2 EV (0.5 at the threshold, 0 for Y ≤ 0). */
export function highlightWeight(y:number,threshold:number,knee:number){
  if(!(y>0))return 0;
  const k=Math.max(0,knee)/2;return smoothstep(-k,k,Math.log2(y/Math.max(1e-6,threshold)));
}
function multiBlur(data:Float32Array,W:number,H:number,ch:number,radius:number){
  const acc=new Float32Array(data.length);
  HALATION.scales.forEach((f,k)=>{const b=gaussianBlurWide(data,W,H,ch,radius*f*W),w=HALATION.weights[k];for(let i=0;i<acc.length;i++)acc[i]+=b[i]*w;});
  return acc;
}
export const halationNode:NodeImpl<'film.halation@1'>={
  type:'film.halation@1',
  evaluate(inputs,p,ctx){
    const image=linearImage(inputs,'Halation'),{width:W,height:H}=image,n=W*H,src=image.data,out=imageBuf(W,H,image.space,new Float32Array(src)),o=out.data;
    const wt=lumaWeights(image.space),radius=Math.max(0,p.radius),bloomRadius=Math.max(0,p.bloomRadius??p.radius);
    const halo=p.intensity>0&&radius>0,bloom=p.bloom>0&&bloomRadius>0;
    if(!halo&&!bloom)return out;
    const k=new Float32Array(n),Y=new Float32Array(n);let any=false;
    for(let i=0;i<n;i++){const j=i*4;Y[i]=wt[0]*src[j]+wt[1]*src[j+1]+wt[2]*src[j+2];k[i]=highlightWeight(Y[i],p.threshold,p.knee);if(k[i]>0)any=true;}
    if(!any)return out;
    if(halo){
      // Halo color normalized to luminance 1, so intensity scales the energy of the highlight luminance.
      let c:RGB=colorValueToRGB(p.color,ctx.workingLinear);if(image.space!==ctx.workingLinear)c=convertPixel(c,ctx.workingLinear,image.space);
      const cy=Math.max(1e-6,wt[0]*c[0]+wt[1]*c[1]+wt[2]*c[2]),cr=c[0]/cy*p.intensity,cg=c[1]/cy*p.intensity,cb=c[2]/cy*p.intensity;
      // Only light that spreads beyond its source counts: max(0, B(E) − E). Inside a uniform highlight B(E) ≈ E, so large bright
      // areas (clouds, white walls) get no pink veil and the halo sits around and between highlights.
      const e=new Float32Array(n);for(let i=0;i<n;i++)e[i]=Y[i]*k[i];
      const b=multiBlur(e,W,H,1,radius);
      for(let i=0;i<n;i++){const v=b[i]-e[i];if(!(v>0))continue;const j=i*4;o[j]+=v*cr;o[j+1]+=v*cg;o[j+2]+=v*cb;}
    }
    if(bloom){
      const e=new Float32Array(n*3);for(let i=0;i<n;i++)for(let c=0;c<3;c++)e[i*3+c]=src[i*4+c]*k[i];
      const b=multiBlur(e,W,H,3,bloomRadius);
      for(let i=0;i<n;i++)for(let c=0;c<3;c++)o[i*4+c]+=b[i*3+c]*p.bloom;
    }
    return out;
  },
};
