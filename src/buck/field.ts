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
  const at=(xx:number,yy:number)=>data[(yy*width+xx)*channels+channel];
  return (at(x0,y0)*(1-tx)+at(x1,y0)*tx)*(1-ty)+(at(x0,y1)*(1-tx)+at(x1,y1)*tx)*ty;
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
 */
export function gaussianBlur(data:Float32Array,width:number,height:number,channels:number,sigma:number){
  if(!(sigma>0))return new Float32Array(data);
  const k=gaussianKernel(sigma),r=(k.length-1)/2,tmp=new Float32Array(data.length),out=new Float32Array(data.length);
  const pass=(src:Float32Array,dst:Float32Array,horizontal:boolean)=>{
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<channels;c++){
      let sum=0,w=0;
      for(let i=-r;i<=r;i++){
        const xx=horizontal?Math.min(width-1,Math.max(0,x+i)):x,yy=horizontal?y:Math.min(height-1,Math.max(0,y+i));
        const v=src[(yy*width+xx)*channels+c];if(Number.isFinite(v)){sum+=v*k[i+r];w+=k[i+r];}
      }
      const idx=(y*width+x)*channels+c;dst[idx]=w>0?sum/w:src[idx];
    }
  };
  pass(data,tmp,true);pass(tmp,out,false);return out;
}
/** Linear-light luminance with the weights of the given RGB primaries (Rec.709 or AP1/AP0 rows of RGB→XYZ). */
export const LUMA:Record<'rec709'|'ap1'|'ap0',[number,number,number]>={rec709:[.2126,.7152,.0722],ap1:[.2722287168,.6740817658,.0536895174],ap0:[.3439664498,.7281660966,-.0721325464]};
