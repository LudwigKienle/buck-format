import { colorValueToRGB, convertPixel, isLinearSpace, lumaWeights } from '../colorspace';
import { clamp01, gaussianBlur, imageBuf, smoothstep } from '../field';
import { BuckError } from '../types';
import type { Buf, NodeImpl, RelightParams, Resolved, RGB } from '../types';
/**
 * light.relight@1, mode "add" (spec §5.3.3). Wrapped Lambert (Green, GPU Gems ch. 16: (n·L + w)/(1 + w)) times a
 * center/surround albedo estimate (ratio of the image to its Gaussian-surround luminance, as in Jobson et al.'s
 * retinex). No shadows, no specular, no distance falloff: the optional depth port is accepted but unused in @1.
 */
type P=Resolved<RelightParams>;
/** Gaussian sigma of the luminance low-pass for the albedo estimate, in image widths. Fixed for @1. */
export const ALBEDO_LOWPASS=.02;
/** Normal smoothing sigma per unit softness, in image widths. */
export const NORMAL_SOFTEN=.01;
const EPS=1e-4;
/** Unit vector toward the light in camera space: azimuth 0 = from the camera, −90 = from the left; elevation +90 = from above. */
export function lightVector(azimuthDeg:number,elevationDeg:number):RGB {
  const a=azimuthDeg*Math.PI/180,e=elevationDeg*Math.PI/180,ce=Math.cos(e);
  return [Math.sin(a)*ce,Math.sin(e),Math.cos(a)*ce];
}
export const relightNode:NodeImpl<'light.relight@1'>={
  type:'light.relight@1',
  evaluate(inputs:Record<string,Buf|undefined>,p:P,ctx){
    const image=inputs.image,normals=inputs.normals;
    if(!image||image.kind!=='image')throw new BuckError('Relight: Bildeingang fehlt.');
    if(!normals||normals.kind!=='vector3')throw new BuckError('Relight: Normaleneingang fehlt.');
    if((p.mode as string)!=='add')throw new BuckError(`Relight: Modus „${p.mode}“ ist in Version 1 nicht definiert, nur „add“.`);
    if(!isLinearSpace(image.space))throw new BuckError(`Relight braucht einen linearen Farbraum, Eingang ist „${image.space}“. Davor einen Konvertierungsknoten setzen.`);
    const {width,height}=image,n=width*height,src=image.data;
    if(normals.width!==width||normals.height!==height)throw new BuckError(`Relight: Normalen ${normals.width}×${normals.height} passen nicht zum Bild ${width}×${height}.`);
    const gain=Math.pow(2,p.intensity)-1;
    if(gain===0)return imageBuf(width,height,image.space,new Float32Array(src));
    // ColorValue is defined in the working linear space (§8); move it into the image space only when they differ.
    let color:RGB=colorValueToRGB(p.color,ctx.workingLinear);
    if(image.space!==ctx.workingLinear)color=convertPixel(color,ctx.workingLinear,image.space);
    const soft=clamp01(p.softness),protect=clamp01(p.preserveHighlights),[wr,wg,wb]=lumaWeights(image.space),L=lightVector(p.azimuth,p.elevation);
    const lr=color[0]*gain*.18,lg=color[1]*gain*.18,lb=color[2]*gain*.18;
    // Zero (invalid) normals take part in the blur only as missing weight; renormalizing restores unit length.
    const nv=normals.data,ns=gaussianBlur(nv,width,height,3,soft*NORMAL_SOFTEN*width);
    const y=new Float32Array(n);
    for(let i=0;i<n;i++){const j=i*4;y[i]=wr*src[j]+wg*src[j+1]+wb*src[j+2];}
    const ylow=gaussianBlur(y,width,height,1,ALBEDO_LOWPASS*width);
    const out=imageBuf(width,height,image.space,new Float32Array(src)),o=out.data;
    for(let i=0;i<n;i++){
      const v=i*3;
      if(nv[v]===0&&nv[v+1]===0&&nv[v+2]===0)continue;
      const nx=ns[v],ny=ns[v+1],nz=ns[v+2],len=Math.hypot(nx,ny,nz);
      if(!(len>1e-6))continue;
      const lambert=Math.max(0,((nx*L[0]+ny*L[1]+nz*L[2])/len+soft)/(1+soft));
      if(lambert===0)continue;
      const f=lambert*(1-protect*smoothstep(.5,1,y[i]))/Math.max(EPS,ylow[i]),j=i*4;
      o[j]=src[j]+src[j]*lr*f;o[j+1]=src[j+1]+src[j+1]*lg*f;o[j+2]=src[j+2]+src[j+2]*lb*f;
    }
    return out;
  },
};
