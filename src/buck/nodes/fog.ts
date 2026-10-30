import { colorValueToRGB, convertPixel, isLinearSpace } from '../colorspace';
import { clamp01, imageBuf } from '../field';
import { BuckError } from '../types';
import type { Buf, FogParams, NodeImpl, Resolved, RGB } from '../types';
/**
 * atmos.fog@1 (spec §5.3.1). Koschmieder/Beer–Lambert single-scattering model of a homogeneous atmosphere:
 * L = L0·e^(−βd) + L∞·(1 − e^(−βd)); here β = density, L∞ = color·0.18·2^luminance, T = e^(−βd) is the transmittance.
 */
type P=Resolved<FogParams>;
/** Raw transmittance before maxOpacity. Non-finite depth is evaluated as d = +Inf (zero for any extinction). */
export function fogTransmittance(d:number,p:P){
  const start=p.start,finite=Number.isFinite(d),dp=finite?Math.max(0,d-start):Infinity;
  if(p.model==='linear'){
    const span=(p.end??1)-start;
    // end <= start would divide by zero: treat as a hard step at start.
    if(!(span>0))return dp>0?0:1;
    return 1-clamp01(dp/span);
  }
  const density=Math.max(0,p.density);
  // Avoid 0·Inf = NaN: without extinction nothing is attenuated, even at infinity.
  if(density===0)return 1;
  return finite?Math.exp(-density*dp):0;
}
export const fogNode:NodeImpl<'atmos.fog@1'>={
  type:'atmos.fog@1',
  evaluate(inputs:Record<string,Buf|undefined>,p:P,ctx){
    const image=inputs.image,depth=inputs.depth;
    if(!image||image.kind!=='image')throw new BuckError('Nebel: Bildeingang fehlt.');
    if(!depth||depth.kind!=='scalar')throw new BuckError('Nebel: Tiefeneingang fehlt.');
    if(!isLinearSpace(image.space))throw new BuckError(`Nebel braucht einen linearen Farbraum, Eingang ist „${image.space}“. Davor einen Konvertierungsknoten setzen.`);
    const {width,height}=image;
    if(depth.width!==width||depth.height!==height)throw new BuckError(`Nebel: Tiefe ${depth.width}×${depth.height} passt nicht zum Bild ${width}×${height}.`);
    // ColorValue is defined in the working linear space (§8); move it into the image space only when they differ.
    let color:RGB=colorValueToRGB(p.color,ctx.workingLinear);
    if(image.space!==ctx.workingLinear)color=convertPixel(color,ctx.workingLinear,image.space);
    const gain=.18*Math.pow(2,p.luminance),fr=color[0]*gain,fg=color[1]*gain,fb=color[2]*gain;
    // Out-of-range opacities are clamped so T stays in [0,1]; the validator rejects them anyway.
    const opacity=clamp01(p.maxOpacity),protect=clamp01(p.skyProtect);
    const tSky0=1-opacity*(1-fogTransmittance(Infinity,p)),tSky=tSky0+protect*(1-tSky0);
    const src=image.data,dd=depth.data,out=imageBuf(width,height,image.space),o=out.data;
    for(let i=0,n=width*height;i<n;i++){
      const d=dd[i];
      const t=Number.isFinite(d)?1-opacity*(1-fogTransmittance(d,p)):tSky,f=1-t,j=i*4;
      o[j]=src[j]*t+fr*f;o[j+1]=src[j+1]*t+fg*f;o[j+2]=src[j+2]*t+fb*f;o[j+3]=src[j+3];
    }
    return out;
  },
};
