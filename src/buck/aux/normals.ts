import { gaussianBlur, vectorField } from '../field';
import type { ScalarField, VectorField } from '../types';
/**
 * normals-from-depth@1 (spec §6.1). Pinhole normal from depth gradients (D2NT, Feng et al. 2023, eq. 9) in the
 * orthographic limit, rotated from the OpenCV frame (y down, z forward) into the .buck camera frame
 * (+X right, +Y up, +Z toward the camera): n ∝ (k·∂d/∂x, −k·∂d/∂y, 1) with x, y in image widths and image y down.
 * Depth growing to the right means the surface faces right; depth growing downwards means it faces down.
 *
 * k converts normalized shot depth to lateral image units: k = ΔZ_shot / (2·Z·tan(hfov/2)). Assumed typical shot
 * for @1: 35 mm lens on a 36 mm wide sensor (hfov 54.4°, tan 27.2° = 0.514) and a far end at ~10× the subject
 * distance (ΔZ = 9·Z), giving k ≈ 8.75, rounded down to 8 to temper gradient noise. Part of the @1 definition.
 */
export const NORMALS_DEPTH_SCALE=8;
/** smoothing: Gaussian sigma in image widths applied to the depth first. Invalid depth (non-finite) gives (0,0,0). */
export function normalsFromDepth(depth:ScalarField,smoothing:number):VectorField {
  const {width,height}=depth,src=depth.data,d=gaussianBlur(src,width,height,1,Math.max(0,smoothing)*width);
  const out=vectorField(width,height),o=out.data,k=NORMALS_DEPTH_SCALE,step=width;
  const ok=(x:number,y:number)=>Number.isFinite(src[y*width+x]);
  // Central difference in image widths; one-sided where a neighbor is outside the image or invalid in the source.
  const diff=(x:number,y:number,dx:number,dy:number)=>{
    const xa=x-dx,ya=y-dy,xb=x+dx,yb=y+dy,i=y*width+x;
    const a=xa>=0&&ya>=0&&ok(xa,ya),b=xb<width&&yb<height&&ok(xb,yb);
    if(a&&b)return (d[yb*width+xb]-d[ya*width+xa])*step/2;
    if(b)return (d[yb*width+xb]-d[i])*step;
    if(a)return (d[i]-d[ya*width+xa])*step;
    return 0;
  };
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    if(!ok(x,y))continue;
    const nx=k*diff(x,y,1,0),ny=-k*diff(x,y,0,1),len=Math.hypot(nx,ny,1),j=(y*width+x)*3;
    o[j]=nx/len;o[j+1]=ny/len;o[j+2]=1/len;
  }
  return out;
}
