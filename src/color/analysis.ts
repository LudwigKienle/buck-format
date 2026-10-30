import { clamp, convert, luma } from './spaces';
import type { RGB, SpaceId } from './spaces';
export const QUANTILES=[.01,.05,.25,.5,.75,.95,.99];
export interface Profile {
  quantiles:number[]; mean: [number,number]; covariance:[number,number,number];
  count:number; clipped:number; palette:string[]; lowInformation:boolean;
}
export const BASELINE:Profile={quantiles:[.025,.08,.25,.45,.65,.88,.96],mean:[0,0],covariance:[.009,0,.009],count:0,clipped:0,palette:[],lowInformation:false};
export function percentile(sorted:number[],p:number){const x=(sorted.length-1)*p,i=Math.floor(x);return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(x-i);}
/** Input pixels are decoded by the browser into sRGB. Export-space selection does not reinterpret ICC-decoded images. */
export function analyze(pixels:Uint8ClampedArray|Float32Array,imageEncoding:SpaceId='srgb'):Profile {
  const ys:number[]=[],us:number[]=[],vs:number[]=[],bins=new Map<number,{count:number;sum:RGB}>();let clipped=0;
  const stride=Math.max(1,Math.floor(pixels.length/4/120000)),scale=pixels instanceof Float32Array?1:255;
  for(let i=0;i<pixels.length;i+=4*stride){
    if(pixels[i+3]/scale<.98)continue;
    const raw:RGB=[pixels[i]/scale,pixels[i+1]/scale,pixels[i+2]/scale];
    const rgb=convert(raw,imageEncoding,'rec709'), y=luma(rgb);
    ys.push(y);us.push(rgb[0]-y);vs.push(rgb[2]-y);
    if(Math.max(...raw)>.99||Math.max(...raw)<.01)clipped++;
    const key=(Math.round(raw[0]*255)>>5)*64+(Math.round(raw[1]*255)>>5)*8+(Math.round(raw[2]*255)>>5);
    const b=bins.get(key)||{count:0,sum:[0,0,0] as RGB};b.count++;b.sum=b.sum.map((s,k)=>s+raw[k]) as RGB;bins.set(key,b);
  }
  if(ys.length<16)throw new Error('Das Bild enthält zu wenige vollständig sichtbare Pixel (mindestens 16).');
  const n=ys.length,mean:[number,number]=[us.reduce((a,b)=>a+b,0)/n,vs.reduce((a,b)=>a+b,0)/n];
  let uu=0,uv=0,vv=0;for(let i=0;i<n;i++){const u=us[i]-mean[0],v=vs[i]-mean[1];uu+=u*u;uv+=u*v;vv+=v*v;}
  ys.sort((a,b)=>a-b);const q=QUANTILES.map(p=>percentile(ys,p));
  const palette=[...bins.values()].sort((a,b)=>b.count-a.count).slice(0,6).map(b=>'#'+b.sum.map(v=>Math.round(clamp(v/b.count)*255).toString(16).padStart(2,'0')).join(''));
  return {quantiles:q,mean,covariance:[uu/n,uv/n,vv/n],count:n,clipped:clipped/n,palette,lowInformation:q[5]-q[1]<.08};
}
