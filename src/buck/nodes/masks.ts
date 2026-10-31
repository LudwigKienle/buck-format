import { convertIndexedToRgb, decode as decodePng } from 'fast-png';
import { convertPixel, lumaWeights } from '../colorspace';
import { LUMA, clamp01, gaussianBlur, resample, sampleBilinear, scalarField, smoothstep } from '../field';
import { sanitizePng } from '../png';
import { BuckError } from '../types';
import type { Buf, ImageBuf, InputDecl, NodeImpl, RGB, RenderContext, ScalarField } from '../types';
/**
 * Spec §5.4 mask nodes. Every output is a ScalarField of ctx.width × ctx.height clamped to 0…1; every feather is a
 * smoothstep from ../field. Masks are computed at their input's native resolution and resampled to the context only
 * afterwards, so +Infinity depth never reaches bilinear interpolation.
 */

/** Safety caps for §11.5 (assumption, not from the spec): refine blur sigma and grow radius in image widths. */
export const REFINE_LIMITS={blur:.1,grow:.25};

/** Mask value sanitizer: NaN → 0, ±Infinity clamped like any other value. */
const unit=(v:number)=>v>=1?1:v>0?v:0;
/**
 * 1 inside [lo, hi], smoothstep falloff of width `soft` outside. Spec §5.4 fixes only "feather uses smoothstep", not its
 * placement; outward feathering is this implementation's choice (the §13 prose about the 0.55–0.6 overlap fits inward feathering).
 */
const band=(v:number,lo:number,hi:number,soft:number)=>smoothstep(lo-soft,lo,v)*(1-smoothstep(hi,hi+soft,v));
const toContext=(f:ScalarField,ctx:RenderContext)=>scalarField(ctx.width,ctx.height,resample(f.data,f.width,f.height,1,ctx.width,ctx.height));
/** Sanitize at native size (so bilinear never sees Inf/NaN), resample to the context, optionally invert. Never aliases `f`. */
const finish=(f:ScalarField,ctx:RenderContext,invert=false)=>{
  const clean=scalarField(f.width,f.height);for(let i=0;i<clean.data.length;i++)clean.data[i]=unit(f.data[i]);
  const out=toContext(clean,ctx),d=out.data;if(invert)for(let i=0;i<d.length;i++)d[i]=1-d[i];return out;
};
function scalarInput(inputs:Record<string,Buf|undefined>,port:string,node:string):ScalarField{
  const b=inputs[port];if(!b)throw new BuckError(`${node}: Eingang „${port}“ fehlt.`);
  if(b.kind!=='scalar')throw new BuckError(`${node}: Eingang „${port}“ muss ein Skalarfeld sein.`);return b;
}
function imageInput(inputs:Record<string,Buf|undefined>,node:string):ImageBuf{
  const b=inputs.image;if(!b)throw new BuckError(`${node}: Eingang „image“ fehlt.`);
  if(b.kind!=='image')throw new BuckError(`${node}: Eingang „image“ muss ein Bild sein.`);return b;
}

/**
 * RenderContext plus the semantics of the declared depth input feeding the node (render.ts sets it; the contract type has no
 * slot for it). Undefined means normalized relative depth.
 */
export interface DepthRangeContext extends RenderContext {depthSemantics?:InputDecl['semantics'];}
export const depthRangeMask:NodeImpl<'mask.depthRange@1'>={type:'mask.depthRange@1',evaluate(inputs,p,ctx){
  const depth=scalarInput(inputs,'depth','Tiefenbereichsmaske'),src=depth.data,out=scalarField(depth.width,depth.height),f=Math.max(0,p.feather);
  // Invalid depth (+Inf sky, NaN) lies beyond every finite depth. Normalized depth clamps everything past the far percentile
  // to 1 (§6.2), so the sky joins it there; metric depth has no upper end, so the sky stays +Inf and falls outside any band.
  const sky=(ctx as DepthRangeContext).depthSemantics==='metric'?Infinity:1;
  for(let i=0;i<src.length;i++){const d=Number.isFinite(src[i])?src[i]:sky;out.data[i]=band(d,p.near,p.far,f);}
  return finish(out,ctx,p.invert);
}};

/**
 * Linear: t = projection of the pixel onto start→end (0 at start, 1 at end), m = smoothstep(−f, L+f, t·L), i.e. a Hermite
 * ramp from start to end whose transition is widened by `feather` on both sides. Radial: 1 within `radius`, smoothstep
 * falloff to 0 at radius+feather. Coordinates are normalized to the image width (y ∈ [0, H/W]), pixel centers at +0.5.
 * Missing points default to the frame: vertical top→bottom ramp, centered circle of radius 0.5.
 */
export const gradientMask:NodeImpl<'mask.gradient@1'>={type:'mask.gradient@1',evaluate(_inputs,p,ctx){
  const {width:w,height:h}=ctx,out=scalarField(w,h),f=Math.max(0,p.feather),aspect=h/w;
  if(p.shape==='radial'){
    const [cx,cy]=p.center??[.5,aspect/2],r=Math.max(0,p.radius??.5);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)out.data[y*w+x]=1-smoothstep(r,r+f,Math.hypot((x+.5)/w-cx,(y+.5)/w-cy));
  }else{
    const [sx,sy]=p.start??[.5,0],[ex,ey]=p.end??[.5,aspect],dx=ex-sx,dy=ey-sy,len=Math.hypot(dx,dy);
    if(len>0){const ux=dx/len,uy=dy/len;for(let y=0;y<h;y++)for(let x=0;x<w;x++)out.data[y*w+x]=smoothstep(-f,len+f,((x+.5)/w-sx)*ux+((y+.5)/w-sy)*uy);}
    else ctx.warn('Verlaufsmaske: Start- und Endpunkt sind identisch, die Maske bleibt leer.');
  }
  return finish(out,ctx,p.invert);
}};

/** Luminance with the weights of params.space; the image is converted per pixel when it carries another space. */
export const lumaMask:NodeImpl<'mask.luma@1'>={type:'mask.luma@1',evaluate(inputs,p,ctx){
  const img=imageInput(inputs,'Luminanzmaske'),wt=lumaWeights(p.space),same=img.space===p.space,src=img.data,out=scalarField(img.width,img.height),s=Math.max(0,p.softness);
  for(let i=0,n=img.width*img.height;i<n;i++){
    let c:RGB=[src[i*4],src[i*4+1],src[i*4+2]];if(!same)c=convertPixel(c,img.space,p.space);
    out.data[i]=band(wt[0]*c[0]+wt[1]*c[1]+wt[2]*c[2],p.low,p.high,s);
  }
  return finish(out,ctx);
}};

/** Declared mask input. AuxChannels masks are already scalar, so `channel` was applied by whoever bound the host clip. */
export const inputMask:NodeImpl<'mask.input@1'>={type:'mask.input@1',evaluate(_inputs,p,ctx){
  const name=p.input.replace(/^\$/,''),field=ctx.aux.masks[name];
  if(!field)throw new BuckError(`Eingabemaske „${name}“ ist nicht vorhanden.`);
  return finish(field,ctx);
}};

const pngCache=new WeakMap<Uint8Array,ScalarField>();
/** PNG → mask at native size: gray value or Rec.709 luma of the code values (masks are data, no transfer), times alpha. */
export function decodeMaskPng(bytes:Uint8Array,file:string):ScalarField{
  const cached=pngCache.get(bytes);if(cached)return cached;
  // Size and decompressed volume are checked before fast-png inflates anything (§11.4, png.ts).
  const {png:clean,width:w,height:h}=sanitizePng(bytes,`Maskenbild „${file}“`),interlaced=clean[28]===1;
  let png;try{png=decodePng(clean,{checkCrc:true});}catch(e){throw new BuckError(`Maskenbild „${file}“ ist beschädigt: ${e instanceof Error?e.message:String(e)}`);}
  const out=scalarField(w,h),n=w*h,ch=png.channels,depth=png.depth,max=2**depth-1,data=png.data,[lr,lg,lb]=LUMA.rec709;
  if(png.palette){
    if(depth<8&&interlaced)throw new BuckError(`Maskenbild „${file}“: Interlacing mit weniger als 8 Bit wird nicht unterstützt.`);
    const rgb=convertIndexedToRgb(png),k=rgb.length/n;
    for(let i=0;i<n;i++)out.data[i]=(lr*rgb[i*k]+lg*rgb[i*k+1]+lb*rgb[i*k+2])/255*(k===4?rgb[i*k+3]/255:1);
  }else if(depth<8){
    if(interlaced)throw new BuckError(`Maskenbild „${file}“: Interlacing mit weniger als 8 Bit wird nicht unterstützt.`);
    // Sub-byte grayscale stays packed MSB-first; each row starts on a byte boundary (PNG §7.2).
    const row=Math.ceil(w*depth/8),key=png.transparency?.length===1?png.transparency[0]&max:-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const bit=x*depth,v=(data[y*row+(bit>>3)]>>(8-depth-(bit&7)))&max;out.data[y*w+x]=v===key?0:v/max;}
  }else{
    const t=png.transparency,gray=ch<=2;
    for(let i=0;i<n;i++){
      const o=i*ch,r=data[o],g=gray?r:data[o+1],b=gray?r:data[o+2];
      // tRNS (only gray/RGB without alpha) marks one exact sample value as fully transparent.
      const keyed=t&&(gray?t.length===1&&ch===1&&r===(t[0]&max):t.length===3&&ch===3&&r===(t[0]&max)&&g===(t[1]&max)&&b===(t[2]&max));
      const alpha=ch===2||ch===4?data[o+ch-1]/max:keyed?0:1;
      out.data[i]=(gray?r:lr*r+lg*g+lb*b)/max*alpha;
    }
  }
  pngCache.set(bytes,out);return out;
}

/** Static PNG mask. stretch fills the frame; contain letterboxes (outside = 0); cover fills and crops, both centered. */
export const imageMask:NodeImpl<'mask.image@1'>={type:'mask.image@1',evaluate(_inputs,p,ctx){
  const bytes=ctx.files.get(p.file);if(!bytes)throw new BuckError(`Maskenbild „${p.file}“ fehlt im Archiv.`);
  const src=decodeMaskPng(bytes,p.file),{width:W,height:H}=ctx,out=scalarField(W,H);
  if(p.fit==='stretch'){const sx=src.width/W,sy=src.height/H;for(let y=0;y<H;y++)for(let x=0;x<W;x++)out.data[y*W+x]=sampleBilinear(src.data,src.width,src.height,1,(x+.5)*sx,(y+.5)*sy,0);}
  else{
    const s=p.fit==='contain'?Math.min(W/src.width,H/src.height):Math.max(W/src.width,H/src.height),ox=(W-src.width*s)/2,oy=(H-src.height*s)/2;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const u=(x+.5-ox)/s,v=(y+.5-oy)/s;
      out.data[y*W+x]=u<0||v<0||u>src.width||v>src.height?0:sampleBilinear(src.data,src.width,src.height,1,u,v,0);
    }
  }
  for(let i=0;i<out.data.length;i++)out.data[i]=unit(out.data[i]);
  return out;
}};

const COMBINE={multiply:(a:number,b:number)=>a*b,max:Math.max,min:Math.min,subtract:(a:number,b:number)=>a-b,screen:(a:number,b:number)=>1-(1-a)*(1-b)};
export const combineMask:NodeImpl<'mask.combine@1'>={type:'mask.combine@1',evaluate(inputs,p,ctx){
  const a=finish(scalarInput(inputs,'a','Maskenverknüpfung'),ctx).data,b=finish(scalarInput(inputs,'b','Maskenverknüpfung'),ctx).data,op=COMBINE[p.op];
  if(!op)throw new BuckError(`Maskenverknüpfung: unbekannte Operation „${String(p.op)}“.`);
  const out=scalarField(ctx.width,ctx.height);for(let i=0;i<out.data.length;i++)out.data[i]=clamp01(op(a[i],b[i]));
  return out;
}};

/**
 * Running max (dilate) or min (erode) over a window of 2r+1 samples, van Herk/Gil-Werman: block prefix and suffix
 * extremes give every window with 2 lookups, independent of r. Out-of-range samples are the identity element, which
 * equals clamped edges for max/min. Exact comparisons only, so the result matches a brute-force filter bit for bit.
 */
function extremeLine(line:Float32Array,r:number,dilate:boolean,g:Float32Array,hb:Float32Array,out:Float32Array){
  const n=line.length,k=2*r+1,len=n+2*r,id=dilate?-Infinity:Infinity,pick=dilate?Math.max:Math.min,at=(i:number)=>i<r||i>=r+n?id:line[i-r];
  for(let i=0;i<len;i++)g[i]=i%k===0?at(i):pick(g[i-1],at(i));
  for(let i=len-1;i>=0;i--)hb[i]=i===len-1||(i+1)%k===0?at(i):pick(hb[i+1],at(i));
  for(let j=0;j<n;j++)out[j]=pick(hb[j],g[j+2*r]);
}
export function extremeFilter(data:Float32Array,w:number,h:number,r:number,dilate:boolean){
  const tmp=new Float32Array(data.length),out=new Float32Array(data.length),m=Math.max(w,h),g=new Float32Array(m+2*r),hb=new Float32Array(m+2*r);
  const row=new Float32Array(w),rowOut=new Float32Array(w),col=new Float32Array(h),colOut=new Float32Array(h);
  for(let y=0;y<h;y++){row.set(data.subarray(y*w,(y+1)*w));extremeLine(row,r,dilate,g,hb,rowOut);tmp.set(rowOut,y*w);}
  for(let x=0;x<w;x++){for(let y=0;y<h;y++)col[y]=tmp[y*w+x];extremeLine(col,r,dilate,g,hb,colOut);for(let y=0;y<h;y++)out[y*w+x]=colOut[y];}
  return out;
}

/** Order: grow (square max/min filter, radius round(|grow|·W) px) → Gaussian blur (sigma = blur·W px) → gamma (m^gamma). */
export const refineMask:NodeImpl<'mask.refine@1'>={type:'mask.refine@1',evaluate(inputs,p,ctx){
  if(!(p.gamma>0)||!Number.isFinite(p.gamma))throw new BuckError('Maskenverfeinerung: gamma muss größer als 0 sein.');
  const W=ctx.width,limit=(v:number,cap:number,what:string)=>{if(Math.abs(v)>cap){ctx.warn(`Maskenverfeinerung: ${what} auf ${cap} Bildbreiten begrenzt.`);return Math.sign(v)*cap;}return v;};
  const grow=limit(p.grow,REFINE_LIMITS.grow,'Erweitern'),blur=limit(Math.max(0,p.blur),REFINE_LIMITS.blur,'Weichzeichnen');
  let data=finish(scalarInput(inputs,'mask','Maskenverfeinerung'),ctx).data;
  const r=Math.round(Math.abs(grow)*W);if(r>0)data=extremeFilter(data,W,ctx.height,r,grow>0);
  if(blur>0)data=gaussianBlur(data,W,ctx.height,1,blur*W);
  const out=scalarField(W,ctx.height);
  for(let i=0;i<data.length;i++){const v=unit(data[i]);out.data[i]=p.gamma===1?v:v**p.gamma;}
  return out;
}};
