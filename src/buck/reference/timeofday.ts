import { autoHorizon, skyPresetParams } from '../nodes/sky';
import { SKY_PRESETS } from '../types';
import type { RGB, SkyPreset } from '../types';
import { blur1, clamp, lumaOf, medianRGB, normY, quantile, rgbToKelvin } from './common';
import type { SkyRegion, Work } from './common';
/**
 * Sky region, sky measurement and time-of-day classification of an image. The sky is invalid depth when the depth has
 * any (≥ 1 %), else a region grown from the top border over smooth, far pixels with small color steps. Colors are medians
 * per channel, so stars, the moon or a lamp do not shift them. Classification: nearest prototype among SKY_PRESETS in a
 * small feature space (sky luminance, warmth at horizon and zenith, scene key, cloudiness), prototypes taken from the
 * preset table of sky.replace@1 plus an editorial scene key per preset.
 */
/** `imageFallback`: search the image when the depth has no invalid pixels (off for a source with model depth: there the depth decides). */
export function skyRegion(work:Work,imageFallback=true):SkyRegion{
  const {w,h,Y,rgb,depth}=work,n=w*h;
  let invalid=0;for(let i=0;i<n;i++)if(!Number.isFinite(depth[i]))invalid++;
  if(invalid/n>=.01){
    const mask=new Uint8Array(n);for(let i=0;i<n;i++)mask[i]=Number.isFinite(depth[i])?0:1;
    return finish(mask,w,h,'depth');
  }
  if(!imageFallback)return {mask:new Uint8Array(n),kind:'none',share:0,horizon:h/w/2};
  const l=new Float32Array(n),l2=new Float32Array(n);for(let i=0;i<n;i++){l[i]=Math.log(Y[i]+1e-3);l2[i]=l[i]*l[i];}
  const m=blur1(l,w,h,1.5),m2=blur1(l2,w,h,1.5),far=work.depthKind==='none'?-Infinity:quantile(depth,.55);
  const cand=new Uint8Array(n);
  for(let i=0;i<n;i++){const y=Math.floor(i/w),sd=Math.sqrt(Math.max(0,m2[i]-m[i]*m[i]));cand[i]=y<h*.75&&sd<.12&&depth[i]>=far?1:0;}
  const mask=new Uint8Array(n),queue:number[]=[];
  for(let x=0;x<w;x++)if(cand[x]){mask[x]=1;queue.push(x);}
  const chroma=(i:number)=>{const y=Y[i]+1e-4;return [rgb[i*3]/y,rgb[i*3+2]/y];};
  for(let q=0;q<queue.length;q++){
    const i=queue[q],x=i%w,y=(i-x)/w,ci=chroma(i);
    for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1]){
      if(j<0||mask[j]||!cand[j])continue;
      const cj=chroma(j);
      if(Math.abs(l[j]-l[i])<.06&&Math.abs(cj[0]-ci[0])+Math.abs(cj[1]-ci[1])<.1){mask[j]=1;queue.push(j);}
    }
  }
  // Holes (moon, stars, small clouds enclosed by sky) belong to the sky: non-sky pixels not connected to the image border.
  const outside=new Uint8Array(n),q2:number[]=[];
  for(let i=0;i<n;i++){const x=i%w,y=(i-x)/w;if(!mask[i]&&(x===0||y===0||x===w-1||y===h-1)){outside[i]=1;q2.push(i);}}
  for(let q=0;q<q2.length;q++){const i=q2[q],x=i%w,y=(i-x)/w;for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1])if(j>=0&&!mask[j]&&!outside[j]){outside[j]=1;q2.push(j);}}
  for(let i=0;i<n;i++)if(!mask[i]&&!outside[i])mask[i]=1;
  dropForeignRegions(mask,rgb,w,h);
  let s=0,my=0;for(let i=0;i<n;i++)if(mask[i]){s++;my+=Math.floor(i/w);}
  if(s/n<.03||my/s>h*.5||s/n>.8)return {mask:new Uint8Array(n),kind:'none',share:0,horizon:h/w/2};
  return finish(mask,w,h,'image');
}
/**
 * A smooth surface at the top border (an arch ceiling, a wall) passes the sky search too. Of the separate 4-connected regions the
 * largest is taken as the sky; any other whose mean chromaticity differs from it by more than FOREIGN_CHROMA is removed. Gaps between
 * branches show the same sky and stay.
 */
function dropForeignRegions(mask:Uint8Array,rgb:Float32Array,w:number,h:number){
  const n=w*h,label=new Int32Array(n).fill(-1),regions:{count:number;r:number;g:number;b:number}[]=[],stack:number[]=[];
  for(let i=0;i<n;i++){
    if(!mask[i]||label[i]>=0)continue;
    const id=regions.length,c={count:0,r:0,g:0,b:0};regions.push(c);label[i]=id;stack.push(i);
    while(stack.length){
      const j=stack.pop()!,x=j%w,y=(j-x)/w;c.count++;c.r+=rgb[j*3];c.g+=rgb[j*3+1];c.b+=rgb[j*3+2];
      for(const k of [x>0?j-1:-1,x<w-1?j+1:-1,y>0?j-w:-1,y<h-1?j+w:-1])if(k>=0&&mask[k]&&label[k]<0){label[k]=id;stack.push(k);}
    }
  }
  if(regions.length<2)return;
  const chroma=(c:{r:number;g:number;b:number})=>{const t=c.r+c.g+c.b+1e-6;return [c.r/t,c.b/t];},main=chroma(regions.reduce((a,b)=>b.count>a.count?b:a));
  const foreign=regions.map(c=>{const q=chroma(c);return Math.hypot(q[0]-main[0],q[1]-main[1])>FOREIGN_CHROMA;});
  for(let i=0;i<n;i++)if(mask[i]&&foreign[label[i]])mask[i]=0;
}
const FOREIGN_CHROMA=.08;
function finish(mask:Uint8Array,w:number,h:number,kind:SkyRegion['kind']):SkyRegion{
  let s=0;const f=new Float32Array(mask.length);for(let i=0;i<mask.length;i++){f[i]=mask[i];s+=mask[i];}
  return {mask,kind,share:s/mask.length,horizon:autoHorizon(f,w,h)};
}

export interface SkyMeasure {
  /** Linear Rec.709 display light (medians). */
  zenith:RGB;horizon:RGB;
  gradientPower?:number;
  /** Share of sky pixels deviating from the row profile (cloud texture), 0…1. */
  clouds:number;cloudColor?:RGB;
  stars:number;starCount:number;
  moon?:{x:number;height:number;radius:number;intensity:number;kelvin:number};
}
/** Stars per sky work pixel at stars = 1: procedural sky of sky.replace@1 rendered at 1024 and 1920 px, measured at 512 px work width (0.0154 / 0.0171; roughly linear in stars). */
export const STAR_DENSITY_AT_1=.016;
export function measureSky(work:Work,region:SkyRegion):SkyMeasure|undefined{
  const {w,h,rgb,Y}=work,n=w*h,mask=region.mask,hz=region.horizon;
  if(region.kind==='none')return undefined;
  const t=(i:number)=>{const y=Math.floor(i/w);return hz>0?((y+.5)/w)/hz:1;};
  const pick=(lo:number,hi:number)=>(i:number)=>mask[i]===1&&t(i)>=lo&&t(i)<hi;
  let zenith=medianRGB(rgb,n,pick(0,.3)),horizon=medianRGB(rgb,n,pick(.75,1.01));
  const all=medianRGB(rgb,n,i=>mask[i]===1);if(!all)return undefined;
  zenith??=all;horizon??=all;
  let gradientPower:number|undefined;
  const mid=medianRGB(rgb,n,pick(.4,.6)),yz=lumaOf(zenith),yh=lumaOf(horizon);
  if(mid&&Math.abs(yh-yz)>.15*Math.max(yz,yh)){const g=clamp((lumaOf(mid)-yz)/(yh-yz),.03,.97);gradientPower=clamp(Math.log(g)/Math.log(.5),.3,4);}
  // Row profile: median log-luminance per row inside the sky; clouds deviate from it, stars are isolated bright maxima.
  const rowMed=new Float32Array(h).fill(NaN),rowY=new Float32Array(h).fill(NaN);
  for(let y=0;y<h;y++){const vals:number[]=[];for(let x=0;x<w;x++){const i=y*w+x;if(mask[i])vals.push(Y[i]);}if(vals.length>=4){vals.sort((a,b)=>a-b);rowY[y]=vals[vals.length>>1];rowMed[y]=Math.log(rowY[y]+1e-4);}}
  let skyCount=0,dev=0,starCount=0;const cloudPix:number[]=[];
  for(let i=0;i<n;i++){
    if(!mask[i])continue;const x=i%w,y=(i-x)/w;if(!Number.isFinite(rowMed[y]))continue;skyCount++;
    const d=Math.log(Y[i]+1e-4)-rowMed[y];
    // Cloud texture: smooth deviations (checked on the 3×3 mean so single stars do not count).
    let s=0,k=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;const j=yy*w+xx;if(mask[j]){s+=Y[j];k++;}}
    const dm=Math.log(s/Math.max(1,k)+1e-4)-rowMed[y];
    if(Math.abs(dm)>.15){dev++;if(dm>.15)cloudPix.push(i);}
    // Star: strict 3×3 maximum, clearly above the row median, small (ring mean below 45 % of the peak), dark sky only.
    if(rowY[y]<.05&&d>Math.log(1.6)&&Y[i]>rowY[y]+.002){
      let isMax=true,ring=0,rk=0;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
        if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;const v=Y[yy*w+xx];
        if(Math.abs(dx)<=1&&Math.abs(dy)<=1&&v>=Y[i])isMax=false;
        if(Math.abs(dx)===2||Math.abs(dy)===2){ring+=v;rk++;}
      }
      if(isMax&&rk&&ring/rk<.45*Y[i])starCount++;
    }
  }
  const clouds=skyCount?clamp(dev/skyCount*1.3):0;
  let cloudColor:RGB|undefined;
  if(cloudPix.length>=20){const s=[0,0,0];for(const i of cloudPix)for(let c=0;c<3;c++)s[c]+=rgb[i*3+c];cloudColor=s.map(v=>v/cloudPix.length) as RGB;}
  const stars=skyCount?clamp(starCount/skyCount/STAR_DENSITY_AT_1):0;
  return {zenith,horizon,gradientPower,clouds,cloudColor,stars,starCount,moon:findMoon(work,region,lumaOf(all))};
}
/** Brightest compact disc in the sky (≥ 5× the sky median): position relative to the horizon, radius in image widths. */
function findMoon(work:Work,region:SkyRegion,skyY:number){
  const {w,h,Y,rgb}=work,mask=region.mask;let best=-1,by=0;
  for(let i=0;i<w*h;i++)if(mask[i]&&Y[i]>by){by=Y[i];best=i;}
  if(best<0||by<Math.max(.03,5*skyY))return undefined;
  const half=by*.5,seen=new Uint8Array(w*h),queue=[best];seen[best]=1;let sx=0,sy=0,minX=w,maxX=0,minY=h,maxY=0;const col=[0,0,0];
  for(let q=0;q<queue.length&&queue.length<w*h*.02;q++){
    const i=queue[q],x=i%w,y=(i-x)/w;sx+=x;sy+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    for(let c=0;c<3;c++)col[c]+=rgb[i*3+c];
    for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1])if(j>=0&&!seen[j]&&Y[j]>=half){seen[j]=1;queue.push(j);}
  }
  const area=queue.length,box=(maxX-minX+1)*(maxY-minY+1),radius=Math.sqrt(area/Math.PI)/w;
  // A moon is a disc of at least ~0.5 % image width (preset: 1.8 %); smaller bright points are stars.
  if(area>=w*h*.02||area/box<.5||radius>.08||radius<.005)return undefined;
  const cx=(sx/area+.5)/w,cy=(sy/area+.5)/w;
  return {x:Math.round(cx*1e3)/1e3,height:Math.round((region.horizon-cy)*1e3)/1e3,radius:Math.round(Math.max(.002,radius)*1e4)/1e4,
    intensity:Math.round(clamp(Math.log2(by/(.18*.9)),-10,10)*100)/100,kelvin:rgbToKelvin(col.map(v=>v/area) as RGB).kelvin};
}

/** Editorial scene key per preset: log2(median non-sky luminance / 0.18) of a typical frame (display light). */
const SCENE_EV:Record<SkyPreset,number>={'night':-4,'starry-night':-4.3,'moonrise':-3.5,'twilight':-3,'blue-hour':-2.2,'golden-hour':-1.2,
  'overcast':-1.3,'clear-day':-.8,'storm':-2,'sandstorm':-1,'aurora':-4.3,'neon-night':-3.3};
/** green: max G/max(R,B) of zenith/horizon; magenta: min(R,B)/G at the horizon (aurora and neon skies need these hues). */
export interface TimeFeatures {skyEV?:number;warmH?:number;warmZ?:number;sceneEV:number;clouds:number;stars:number;moon:boolean;moonHeight?:number;lightWarm:number;green:number;magenta:number;/** Extra far haze over the source (fitFog amount). */haze:number;}
export interface TimeClass {preset:SkyPreset;second:SkyPreset;distance:number;confidence:number;features:TimeFeatures;ranking:[SkyPreset,number][];}
const warm=(c:RGB)=>Math.log(Math.max(1e-4,c[0])/Math.max(1e-4,c[2]));
function prototype(p:SkyPreset){
  const s=skyPresetParams(p,'lin_rec709_srgb'),base=.18*2**(s.exposure as number),z=s.zenith as RGB,hz=s.horizon as RGB;
  const yz=lumaOf(z)*base,yh=lumaOf(hz)*base;
  return {skyEV:Math.log2(Math.sqrt(yz*yh)/.18),warmH:warm(hz),warmZ:warm(z),sceneEV:SCENE_EV[p],clouds:s.clouds as number,stars:s.stars as number,night:(s.stars as number)>0||(s.exposure as number)<-2};
}
const PROTOS=Object.fromEntries(SKY_PRESETS.map(p=>[p,prototype(p)])) as Record<SkyPreset,ReturnType<typeof prototype>>;
/** Nearest preset prototype; confidence from the margin to the second-nearest (and lower without a measured sky). */
export function classifyTime(f:TimeFeatures,hasSky:boolean):TimeClass{
  // Hue is unreliable in dark skies (noise, grading): its weight drops below a sky luminance of about −3 EV.
  const hueW=f.skyEV!==undefined&&f.skyEV<-3?2.5:1,cloudW=f.skyEV!==undefined&&f.skyEV<-3?1:.6;
  const d:[SkyPreset,number][]=SKY_PRESETS.map(p=>{
    const q=PROTOS[p];let s=((f.sceneEV-q.sceneEV)/1.4)**2;
    if(hasSky&&f.skyEV!==undefined)s+=((f.skyEV-q.skyEV)/1.1)**2+((f.warmH!-q.warmH)/(.45*hueW))**2+((f.warmZ!-q.warmZ)/(1*hueW))**2+((f.clouds-q.clouds)/cloudW)**2;
    else s+=((f.lightWarm-q.warmH*.5)/.5)**2;
    // Stars and a moon only appear in dark skies; a moon speaks for night/moonrise, many stars for the starry presets.
    // Moonrise means a low moon (preset: 0.035 image widths above the horizon).
    if(f.moon)s+=p==='night'||(p==='moonrise'&&(f.moonHeight??0)<.08)?-.8:1;
    else if(p==='moonrise')s+=1;
    if(f.stars>.15)s+=q.stars>=.25?-.5:1;
    else if(q.night&&hasSky&&!f.moon)s+=.4;
    if(p==='aurora'&&f.green<1)s+=1.5;
    if(p==='neon-night'&&f.magenta<1.15)s+=1.5;
    // A sandstorm hides the distance: without strong measured haze it is unlikely.
    if(p==='sandstorm'&&f.haze<.25)s+=1.5;
    return [p,Math.sqrt(Math.max(0,s))];
  });
  d.sort((a,b)=>a[1]-b[1]);
  const [best,d1]=d[0],[second,d2]=d[1];
  const confidence=clamp((.3+.9*(d2-d1)/(d2+.5))*(hasSky?1:.6)*clamp(1.6-d1/3,.3,1));
  return {preset:best,second,distance:d1,confidence,features:f,ranking:d.map(([p,v])=>[p,Math.round(v*100)/100])};
}
/** Measured warmth helper for callers without a sky. */
export const lightWarmth=(light:RGB)=>warm(normY(light));
