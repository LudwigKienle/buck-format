import { convertIndexedToRgb, decode as decodePng } from 'fast-png';
import { colorValueToRGB, convertPixel, isLinearSpace, lumaWeights } from '../colorspace';
import { boxMean, clamp01, gaussianBlurWide, guidedFilter, imageBuf, sampleBilinear, smoothstep } from '../field';
import { sanitizePng } from '../png';
import { extremeFilter } from './masks';
import { BuckError } from '../types';
import type { Buf, ColorValue, ImageBuf, NodeImpl, Resolved, RGB, SkyParams, SkyPreset, SpaceName } from '../types';
/**
 * sky.replace@1 (spec §5.3.4). Sky mask from depth (invalid or ≥ skyDepth), Gaussian edge, procedural sky (gradient,
 * horizon glow, value-noise clouds, hashed stars, Milky Way, aurora, moon) or a PNG from skies/, composited in linear light.
 * No random numbers: every pattern is an integer hash of a lattice fixed in image-width units, so it does not depend on
 * the resolution. The optional `mask` port and `amount` are applied by render.ts, not here.
 */
type P=Resolved<SkyParams>;

/** Integer hash (murmur3 finalizer) of a lattice point → [0, 1). */
export function hash3(x:number,y:number,seed:number){
  let h=Math.imul(x|0,0x27d4eb2d)^Math.imul(y|0,0x165667b1)^Math.imul(seed|0,0x9e3779b1);
  h=Math.imul(h^(h>>>15),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);h^=h>>>16;
  return (h>>>0)/4294967296;
}
/** Value noise with quintic fade on the integer lattice. */
export function valueNoise(x:number,y:number,seed:number){
  const xi=Math.floor(x),yi=Math.floor(y),tx=x-xi,ty=y-yi,fx=tx*tx*tx*(tx*(tx*6-15)+10),fy=ty*ty*ty*(ty*(ty*6-15)+10);
  const a=hash3(xi,yi,seed),b=hash3(xi+1,yi,seed),c=hash3(xi,yi+1,seed),d=hash3(xi+1,yi+1,seed);
  return (a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy;
}
/** Fractal sum of `octaves` value-noise layers (gain 0.5, lacunarity 2), normalized to 0…1. */
export function fbm(x:number,y:number,octaves:number,seed:number){
  let s=0,a=.5,n=0;
  for(let o=0;o<octaves;o++){s+=a*valueNoise(x,y,seed+o*101);n+=a;x*=2;y*=2;a*=.5;}
  return s/n;
}

/** Fixed constants of @1 (image widths unless noted). */
export const SKY={starCell:1/512,starSigma:.0003,starP:.06,glowWidth:.06,spillRadius:.08,cloudFade:.03,auroraGain:22,milkyGain:3};

/** Sky mask before the edge blur: 1 where depth is not finite or ≥ skyDepth. */
export function rawSkyMask(depth:Float32Array,skyDepth:number){
  const m=new Float32Array(depth.length);for(let i=0;i<depth.length;i++){const d=depth[i];m[i]=!Number.isFinite(d)||d>=skyDepth?1:0;}return m;
}
/** Automatic horizon: bottom edge of the lowest pixel row whose sky share is ≥ 1/64, in image widths; half height without sky. */
export function autoHorizon(raw:Float32Array,width:number,height:number){
  for(let y=height-1;y>=0;y--){let s=0;for(let x=0;x<width;x++)s+=raw[y*width+x];if(s*64>=width)return (y+1)/width;}
  return height/width/2;
}

const lin=(c:ColorValue,space:SpaceName,working:SpaceName):RGB=>{const v=colorValueToRGB(c,working);return space===working?v:convertPixel(v,working,space);};

/** Procedural sky radiance at normalized (u, v); `hz` = horizon y. Writes RGB into `out`. */
function proceduralSky(p:P,space:SpaceName,working:SpaceName,W:number,H:number,hz:number){
  const base=.18*2**p.exposure,zen=lin(p.zenith,space,working),hor=lin(p.horizon,space,working),glowC=lin(p.glowColor,space,working),cloudC=lin(p.cloudColor,space,working);
  const pw=Math.max(.05,p.gradientPower),stars=clamp01(p.stars),milky=clamp01(p.milkyWay),cov=clamp01(p.clouds),cw=.03+.35*(1-clamp01(p.cloudContrast));
  const scale=Math.max(.01,p.cloudScale),aur=Math.max(0,p.aurora),glow=Math.max(0,p.glow);
  const moon=p.moon,moonC=moon?lin(moon.color??{kelvin:4100},space,working).map(v=>v*.18*2**moon.intensity):undefined;
  const mx=moon?.x??0,my=moon?hz-moon.height:0,mr=moon?Math.max(1e-4,moon.radius):1,aa=Math.max(.75/W,.02*mr);
  // Star footprint: at least 0.6 px; amplitude scaled so the flux of a star is the same at every resolution.
  const sig=Math.max(SKY.starSigma,.6/W),amp=(SKY.starSigma/sig)**2,cell=SKY.starCell;
  // Milky Way: band through (0.5, hz − 0.22) at 62°, in image widths.
  const ang=62*Math.PI/180,nx=-Math.sin(ang),ny=Math.cos(ang),bx=.5,by=hz-.22;
  const out=new Float32Array(W*H*3);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const u=(x+.5)/W,v=(y+.5)/W,t=hz>0?clamp01(v/hz):1,g=t**pw;
    let r=(zen[0]+(hor[0]-zen[0])*g)*base,gg=(zen[1]+(hor[1]-zen[1])*g)*base,b=(zen[2]+(hor[2]-zen[2])*g)*base;
    const above=hz-v;
    if(glow>0){const k=glow*base*(above>0?Math.exp(-above/SKY.glowWidth):1);r+=glowC[0]*k;gg+=glowC[1]*k;b+=glowC[2]*k;}
    let mw=0;
    if(milky>0){
      const dist=(u-bx)*nx+(v-by)*ny,band=Math.exp(-((dist/.09)**2));
      if(band>1e-3){
        const dust=smoothstep(.5,.72,fbm(u*14,v*14,4,71))*Math.exp(-((dist/.03)**2));
        const k=milky*band*base*SKY.milkyGain*(.4+fbm(u*7,v*7,5,53))*(1-.75*dust)*smoothstep(0,.08,above);
        r+=k*.85;gg+=k*.9;b+=k;mw=milky*band;
      }
    }
    if(aur>0&&above>-.02){
      // Two curtains: base line wanders with 1-D noise, sharp lower edge, long upper decay, vertical rays.
      for(let c=0;c<2;c++){
        const yb=hz-.08-.05*c-.06*valueNoise(u*3+c*7,c*13,90+c),a=yb-v,prof=a<0?Math.exp(a/.012):Math.exp(-a/(.1+.04*c));
        if(prof<1e-3)continue;
        const lat=smoothstep(.42,.78,fbm(u*2.2+c*3.1,c*5,3,110+c)),ray=.55+.45*valueNoise(u*160+a*25,c*31,130+c);
        const k=aur*base*SKY.auroraGain*prof*lat*ray*(c?.6:1),top=smoothstep(.015,.16,a);
        r+=k*(.05+.45*top);gg+=k*(1-.88*top);b+=k*(.3+.35*top);
      }
    }
    let cloud=0;
    if(cov>0){
      // Mild perspective (vertical compression ∝ √d toward the horizon, no convergence in x) plus a domain warp for clumps.
      const d=1/(Math.max(0,above)+.12),X=(u-.5)*.6/scale,Z=.24*Math.sqrt(d)/scale,wx=fbm(X*.5,Z*.5,3,41)-.5,wz=fbm(X*.5+5.2,Z*.5+1.3,3,43)-.5;
      const n=fbm(X+1.6*wx,Z+1.6*wz,5,11),fade=Math.exp(-Math.max(0,above)/SKY.cloudFade);
      const n2=n*(1-fade)+.5*fade;
      cloud=smoothstep(1-cov-cw,1-cov+cw,n2);
      if(cloud>0){const shade=(.55+.45*smoothstep(.3,.9,fbm(X+3.7,Z+1.3,4,29)))*base;r+=(cloudC[0]*shade-r)*cloud;gg+=(cloudC[1]*shade-gg)*cloud;b+=(cloudC[2]*shade-b)*cloud;}
    }
    if(moonC){
      const d=Math.hypot(u-mx,v-my);
      if(d<mr*12){
        const disc=1-smoothstep(mr-aa,mr,d),maria=disc>0?.78+.22*fbm((u-mx)/mr*2.5,(v-my)/mr*2.5,3,201):0;
        const halo=(d>mr?.18*Math.exp(-(d-mr)/(mr*1.2))+.04*Math.exp(-((d/(mr*6))**2)):.22)*(1-cloud*.5);
        const k=disc*maria*(1-cloud*.85)+halo;r+=moonC[0]*k;gg+=moonC[1]*k;b+=moonC[2]*k;
      }
    }
    if(stars>0&&above>0){
      const ci=Math.floor(u/cell),cj=Math.floor(v/cell),prob=stars*SKY.starP*(1+6*mw);let s=0,sr=0,sb=0;
      for(let j=cj-1;j<=cj+1;j++)for(let i=ci-1;i<=ci+1;i++){
        if(hash3(i,j,1)>=prob)continue;
        const sx=(i+hash3(i,j,2))*cell,sy=(j+hash3(i,j,3))*cell,d2=((u-sx)**2+(v-sy)**2)/(sig*sig);
        if(d2>9)continue;
        const lum=(.015+.6*hash3(i,j,4)**6)*amp*Math.exp(-.5*d2),tint=hash3(i,j,5)-.5;
        s+=lum;sr+=lum*tint;sb-=lum*tint;
      }
      if(s>0){const k=(1-cloud)*smoothstep(0,.02,above);r+=(s+.25*sr)*k;gg+=s*k;b+=(s+.25*sb)*k;}
    }
    const o=(y*W+x)*3;out[o]=r;out[o+1]=gg;out[o+2]=b;
  }
  return out;
}

const skyCache=new WeakMap<Uint8Array,{w:number;h:number;rgb:Float32Array}>();
/** Sky PNG → linear Rec.709 RGB at native size. Code values are taken as sRGB (spec §3.2). Gate: sanitizePng. */
export function decodeSkyPng(bytes:Uint8Array,file:string){
  const cached=skyCache.get(bytes);if(cached)return cached;
  const {png:clean,width:w,height:h}=sanitizePng(bytes,`Himmelsbild „${file}“`);
  let png;try{png=decodePng(clean,{checkCrc:true});}catch(e){throw new BuckError(`Himmelsbild „${file}“ ist beschädigt: ${e instanceof Error?e.message:String(e)}`);}
  const n=w*h,rgb=new Float32Array(n*3);
  let src:ArrayLike<number>=png.data,ch=png.channels,max=2**png.depth-1;
  if(png.palette){src=convertIndexedToRgb(png);ch=src.length/n;max=255;}
  else if(png.depth<8)throw new BuckError(`Himmelsbild „${file}“: weniger als 8 Bit je Kanal werden nicht unterstützt.`);
  const lut=(v:number)=>{const x=v/max;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;};
  for(let i=0;i<n;i++){const o=i*ch,gray=ch<=2;rgb[i*3]=lut(src[o]);rgb[i*3+1]=lut(gray?src[o]:src[o+1]);rgb[i*3+2]=lut(gray?src[o]:src[o+2]);}
  const r={w,h,rgb};skyCache.set(bytes,r);return r;
}
function imageSky(p:P,ctx:{files:Map<string,Uint8Array>},space:SpaceName,W:number,H:number){
  if(!p.file)throw new BuckError('Himmel: Quelle „image“ braucht eine Datei skies/<name>.png.');
  const bytes=ctx.files.get(p.file);if(!bytes)throw new BuckError(`Himmelsbild „${p.file}“ fehlt im Archiv.`);
  const img=decodeSkyPng(bytes,p.file),s=Math.max(W/img.w,H/img.h),ox=(W-img.w*s)/2,oy=(H-img.h*s)/2,gain=2**p.exposure;
  const out=new Float32Array(W*H*3);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    let c:RGB=[0,1,2].map(k=>sampleBilinear(img.rgb,img.w,img.h,3,(x+.5-ox)/s,(y+.5-oy)/s,k)*gain) as RGB;
    if(space!=='lin_rec709_srgb')c=convertPixel(c,'lin_rec709_srgb',space);
    const o=(y*W+x)*3;out[o]=c[0];out[o+1]=c[1];out[o+2]=c[2];
  }
  return out;
}

/**
 * Keeps the sky components that belong to the sky: 4-connected components of the raw mask touching the top border, plus
 * every other component whose centroid lies above the lowest row of those (gaps between branches, enclosed holes).
 * Components further down (sky reflected in water or glass, which depth models also report as far) are dropped.
 * Without any component at the top border the mask is returned unchanged.
 */
export function cleanSkyMask(raw:Float32Array,W:number,H:number){
  const n=W*H,label=new Int32Array(n).fill(-1),comps:{top:boolean;maxY:number;sumY:number;count:number}[]=[],stack:number[]=[];
  for(let i=0;i<n;i++){
    if(raw[i]<.5||label[i]>=0)continue;
    const id=comps.length,c={top:false,maxY:0,sumY:0,count:0};comps.push(c);label[i]=id;stack.push(i);
    while(stack.length){
      const j=stack.pop()!,x=j%W,y=(j-x)/W;c.count++;c.sumY+=y;if(y>c.maxY)c.maxY=y;if(y===0)c.top=true;
      for(const k of [x>0?j-1:-1,x<W-1?j+1:-1,y>0?j-W:-1,y<H-1?j+W:-1])if(k>=0&&label[k]<0&&raw[k]>=.5){label[k]=id;stack.push(k);}
    }
  }
  let low=-1;for(const c of comps)if(c.top&&c.maxY>low)low=c.maxY;
  if(low<0)return raw;
  const keep=comps.map(c=>c.top||c.sumY/c.count<=low),out=new Float32Array(n);
  for(let i=0;i<n;i++)out[i]=label[i]>=0&&keep[label[i]]?1:0;
  return out;
}
/** Regularization of the guided filter (guide in cube-root encoded linear light, ~0…1.2). */
const MATTE_EPS=1e-3;
/**
 * Matte, in three steps. (1) Outside a band of ±edge image widths (b px) around the cleaned depth boundary alpha is the
 * cleaned mask. (2) Inside the band a color estimate: S = local old sky (masked Gaussian mean of in·erode(mask), σ = 2b),
 * F = local foreground (same with 1 − dilate(mask)), a = smoothstep(0.15, 0.6, ⟨in − F, S − F⟩ / |S − F|²), blended with the mask by the
 * separability conf = smoothstep(0.005, 0.03, |S − F|² / (Y(S)² + Y(F)² + 10⁻⁶)) · (1 − smoothstep(0.25, 1, e² / |S − F|²)), e being
 * the distance of the pixel from the line F–S (a third color such as a cloud leaves the decision to the mask). (3) The color-guided filter (He, Sun,
 * Tang 2013; radius max(1, round(b/3)), guide = cube root of the linear input, eps = MATTE_EPS) removes the noise of (2)
 * while keeping the transition on the edges of the image; smoothstep(0.1, 0.9) pushes it toward 0/1, and the result is
 * clamped between the color estimate and the mask (box-softened with the same radius), so the filter only decides where the
 * two disagree. Also returns S for the
 * compositing and the cleaned mask. edge = 0 gives the hard cleaned mask.
 */
export function skyMatte(src:Float32Array,raw:Float32Array,W:number,H:number,edge:number,wt:RGB){
  const n=W*H,b=Math.round(edge*W),mask=cleanSkyMask(raw,W,H);
  if(b<1)return {alpha:mask,oldSky:undefined,fg:undefined,clean:mask};
  const dil=extremeFilter(mask,W,H,b,true),ero=extremeFilter(mask,W,H,b,false),sigma=2*b;
  const sNum=new Float32Array(n*3),fNum=new Float32Array(n*3),fw=new Float32Array(n);
  for(let i=0;i<n;i++){fw[i]=1-dil[i];for(let c=0;c<3;c++){sNum[i*3+c]=src[i*4+c]*ero[i];fNum[i*3+c]=src[i*4+c]*fw[i];}}
  const sB=gaussianBlurWide(sNum,W,H,3,sigma),sW=gaussianBlurWide(ero,W,H,1,sigma),fB=gaussianBlurWide(fNum,W,H,3,sigma),fW=gaussianBlurWide(fw,W,H,1,sigma);
  const oldSky=new Float32Array(n*3),p=new Float32Array(mask),nb=Math.max(1,Math.round(b/2)),nDil=extremeFilter(mask,W,H,nb,true),nEro=extremeFilter(mask,W,H,nb,false);
  for(let i=0;i<n;i++)for(let c=0;c<3;c++)oldSky[i*3+c]=sW[i]>1e-6?sB[i*3+c]/sW[i]:src[i*4+c];
  for(let i=0;i<n;i++){
    if(nDil[i]===nEro[i])continue;
    const j=i*4,S=[oldSky[i*3],oldSky[i*3+1],oldSky[i*3+2]],F=fW[i]>1e-6?[fB[i*3]/fW[i],fB[i*3+1]/fW[i],fB[i*3+2]/fW[i]]:S;
    const d=[S[0]-F[0],S[1]-F[1],S[2]-F[2]],dd=d[0]*d[0]+d[1]*d[1]+d[2]*d[2],ys=wt[0]*S[0]+wt[1]*S[1]+wt[2]*S[2],yf=wt[0]*F[0]+wt[1]*F[1]+wt[2]*F[2];
    // Sky side favored (smoothstep 0.15…0.6): horizon haze is brighter than the sky core S and would otherwise keep ~20 %
    // of the old sky as a grey band.
    const t=dd>0?((src[j]-F[0])*d[0]+(src[j+1]-F[1])*d[1]+(src[j+2]-F[2])*d[2])/dd:0,a=dd>0?smoothstep(.15,.6,t):mask[i];
    // A third color (a cloud between ridge and sky) lies off the line F–S: there the color estimate yields to the mask.
    let off=0;for(let c=0;c<3;c++){const e=src[j+c]-F[c]-t*d[c];off+=e*e;}
    const conf=smoothstep(.005,.03,dd/(ys*ys+yf*yf+1e-6))*(1-smoothstep(.25,1,dd>0?off/dd:1));
    p[i]=conf*a+(1-conf)*mask[i];
  }
  const guide=[0,1,2].map(c=>{const g=new Float32Array(n);for(let i=0;i<n;i++)g[i]=Math.cbrt(Math.max(0,src[i*4+c]));return g;});
  const r=Math.max(1,Math.round(b/3)),q=guidedFilter(guide,p,W,H,r,MATTE_EPS,Math.max(1,Math.floor(r/3))),alpha=new Float32Array(mask);
  // The filter only decides between the two estimates: where mask and color estimate agree, their value holds (a cloud next
  // to a ridge would otherwise lose alpha in a window that mixes three colors).
  // The mask is softened by a box of the same radius so an edge without color contrast stays anti-aliased instead of binary.
  const soft=boxMean(mask,W,H,r);
  for(let i=0;i<n;i++)if(dil[i]!==ero[i]){const lo=Math.min(p[i],soft[i]),hi=Math.max(p[i],soft[i]);alpha[i]=Math.min(hi,Math.max(lo,smoothstep(.1,.9,q[i])));}
  const fg=new Float32Array(n*3);for(let i=0;i<n;i++)for(let c=0;c<3;c++)fg[i*3+c]=fW[i]>1e-6?fB[i*3+c]/fW[i]:src[i*4+c];
  return {alpha,oldSky,fg,clean:mask};
}

export const skyNode:NodeImpl<'sky.replace@1'>={
  type:'sky.replace@1',
  evaluate(inputs:Record<string,Buf|undefined>,p:P,ctx){
    const image=inputs.image,depth=inputs.depth;
    if(!image||image.kind!=='image')throw new BuckError('Himmel: Bildeingang fehlt.');
    const skyIn=inputs.sky;
    if(!(depth&&depth.kind==='scalar')&&!(skyIn&&skyIn.kind==='scalar'))throw new BuckError('Himmel: Weder Tiefe noch Himmelsmaske ist verbunden.');
    if(!isLinearSpace(image.space))throw new BuckError(`Himmel braucht einen linearen Farbraum, Eingang ist „${image.space}“. Davor einen Konvertierungsknoten setzen.`);
    const {width:W,height:H}=image,n=W*H;
    const field=skyIn&&skyIn.kind==='scalar'?skyIn:depth!;
    if(field.width!==W||field.height!==H)throw new BuckError(`Himmel: ${skyIn?'Himmelsmaske':'Tiefe'} ${field.width}×${field.height} passt nicht zum Bild ${W}×${H}.`);
    // A sky segmentation (probability) wins over depth: ≥ 0.5 is sky; skyDepth then has no effect.
    const raw=skyIn&&skyIn.kind==='scalar'?Float32Array.from(skyIn.data,v=>v>=.5?1:0):rawSkyMask(field.data,p.skyDepth),src=image.data,out:ImageBuf=imageBuf(W,H,image.space,new Float32Array(src));
    if(!raw.some(v=>v>0))return out;
    const {alpha:mask,oldSky,fg,clean}=skyMatte(src,raw,W,H,Math.max(0,p.edge),lumaWeights(image.space));
    const hz=p.horizonY??autoHorizon(clean,W,H);
    const sky=p.source==='image'?imageSky(p,ctx,image.space,W,H):proceduralSky(p,image.space,ctx.workingLinear,W,H,hz);
    const o=out.data,spill=clamp01(p.spill);
    if(spill>0){
      // Ambient tint: mask-weighted mean sky color normalized to luminance 1, strongest near the sky edge.
      const wt=lumaWeights(image.space);let sr=0,sg=0,sb=0;
      for(let i=0;i<n;i++){const m=mask[i];sr+=sky[i*3]*m;sg+=sky[i*3+1]*m;sb+=sky[i*3+2]*m;}
      const y=wt[0]*sr+wt[1]*sg+wt[2]*sb;
      if(y>0){
        const tint=[sr/y-1,sg/y-1,sb/y-1],near=gaussianBlurWide(clean,W,H,1,SKY.spillRadius*W);
        for(let i=0;i<n;i++){const k=spill*(.35+.65*clamp01(near[i]*2)),j=i*4;for(let c=0;c<3;c++)o[j+c]=src[j+c]*(1+k*tint[c]);}
      }
    }
    // out = (1 − a)·F' + a·sky. F' is the unmixed foreground (c − a·S)/(1 − a), but taken only as far along the line from c
    // toward it as the box between c and the local foreground F allows, with one factor t for all channels: the color keeps
    // its hue instead of being clamped channel by channel (which produced colored fringes).
    for(let i=0;i<n;i++){
      const a=mask[i];if(!(a>0))continue;
      const j=i*4;
      if(a>=1||!oldSky||!fg){for(let c=0;c<3;c++)o[j+c]+=(sky[i*3+c]-o[j+c])*Math.min(1,a);continue;}
      let t=1;
      for(let c=0;c<3;c++){
        const v=o[j+c],u=(v-a*oldSky[i*3+c])/(1-a),F=fg[i*3+c],lo=Math.min(v,F),hi=Math.max(v,F);
        if(u<lo)t=Math.min(t,(v-lo)/(v-u));else if(u>hi)t=Math.min(t,(hi-v)/(u-v));
      }
      for(let c=0;c<3;c++){const v=o[j+c],f=v+t*((v-a*oldSky[i*3+c])/(1-a)-v);o[j+c]=(1-a)*f+a*sky[i*3+c];}
    }
    return out;
  },
};

/**
 * Editorial preset values in lin_rec709 (converted to `working`). Sky colors are relative (1 ≈ 18 % grey at exposure 0);
 * sources for the color directions are listed in docs/BUCK_FORMAT.md §5.3.4. horizonY stays automatic.
 */
const PRESET_TABLE:Record<SkyPreset,{z:RGB;h:RGB;ev:number;pw:number;glow:number;gc:RGB|number;stars:number;mw:number;cl:number;cc:number;cs:number;cloud:RGB;aur:number;moon?:{x:number;height:number;radius:number;intensity:number;kelvin:number};spill:number}>={
  'night':{z:[.12,.26,.95],h:[.28,.4,.85],ev:-2.7,pw:.8,glow:.15,gc:[.4,.5,.8],stars:.45,mw:0,cl:0,cc:.5,cs:.3,cloud:[.5,.55,.7],aur:0,moon:{x:.72,height:.16,radius:.018,intensity:1.6,kelvin:4100},spill:.25},
  'starry-night':{z:[.1,.2,.8],h:[.22,.32,.7],ev:-3.2,pw:.7,glow:.1,gc:[.35,.42,.7],stars:1,mw:.8,cl:0,cc:.5,cs:.3,cloud:[.4,.45,.6],aur:0,spill:.2},
  'moonrise':{z:[.16,.26,.8],h:[.7,.55,.65],ev:-2.4,pw:.9,glow:.5,gc:[1,.6,.4],stars:.25,mw:0,cl:0,cc:.5,cs:.3,cloud:[.6,.55,.65],aur:0,moon:{x:.62,height:.035,radius:.045,intensity:1.2,kelvin:2600},spill:.3},
  'twilight':{z:[.14,.24,.85],h:[.55,.45,.85],ev:-2,pw:1,glow:.35,gc:[.9,.55,.6],stars:.15,mw:0,cl:0,cc:.5,cs:.3,cloud:[.5,.45,.6],aur:0,spill:.3},
  'blue-hour':{z:[.12,.3,1.1],h:[.45,.55,1],ev:-.6,pw:1,glow:.3,gc:[.85,.55,.8],stars:0,mw:0,cl:0,cc:.5,cs:.3,cloud:[.5,.55,.8],aur:0,spill:.35},
  'golden-hour':{z:[.3,.45,.85],h:[1.6,.85,.35],ev:1.2,pw:1.6,glow:1,gc:[1.4,.65,.2],stars:0,mw:0,cl:.25,cc:.6,cs:.35,cloud:[1.3,.75,.45],aur:0,spill:.35},
  'overcast':{z:[.82,.85,.92],h:[1,1,1.02],ev:1.4,pw:1.2,glow:0,gc:0,stars:0,mw:0,cl:.95,cc:.15,cs:.4,cloud:[.85,.87,.92],aur:0,spill:.3},
  'clear-day':{z:[.22,.45,1.2],h:[.62,.78,1],ev:1.6,pw:1.3,glow:.1,gc:[1,1,1],stars:0,mw:0,cl:.12,cc:.7,cs:.3,cloud:[1.05,1.05,1.1],aur:0,spill:.2},
  'storm':{z:[.55,.6,.7],h:[.9,.92,.98],ev:.8,pw:1,glow:.15,gc:[.7,.72,.8],stars:0,mw:0,cl:.68,cc:.6,cs:.3,cloud:[.12,.14,.2],aur:0,spill:.35},
  'sandstorm':{z:[1,.62,.3],h:[1.25,.82,.42],ev:1.3,pw:.6,glow:.6,gc:[1.2,.75,.35],stars:0,mw:0,cl:.9,cc:.1,cs:.6,cloud:[1.15,.72,.35],aur:0,spill:.45},
  'aurora':{z:[.08,.16,.5],h:[.2,.3,.55],ev:-3.4,pw:.8,glow:.1,gc:[.3,.5,.5],stars:.6,mw:0,cl:0,cc:.5,cs:.3,cloud:[.4,.45,.6],aur:1,spill:.3},
  'neon-night':{z:[.2,.06,.35],h:[.9,.25,.75],ev:-2.4,pw:1.4,glow:.9,gc:[1,.35,.6],stars:0,mw:0,cl:.35,cc:.4,cs:.35,cloud:[.7,.3,.65],aur:0,spill:.4},
};
export const SKY_PRESET_LABELS:Record<SkyPreset,{label:string;description:string}>={
  'night':{label:'Nacht',description:'Dunkles Nachtblau, Sterne, Mond mit Halo.'},
  'starry-night':{label:'Sternenhimmel',description:'Klare Nacht, dichtes Sternfeld und Milchstraße, kein Mond.'},
  'moonrise':{label:'Mondaufgang',description:'Späte Dämmerung, großer warmer Mond knapp über dem Horizont.'},
  'twilight':{label:'Zwielicht',description:'Zwischen blauer Stunde und Nacht, violetter Horizont.'},
  'blue-hour':{label:'Blaue Stunde',description:'Tiefes Blau oben, Cyan-Violett am Horizont.'},
  'golden-hour':{label:'Goldene Stunde',description:'Warmes Orange am Horizont, flaches Licht.'},
  'overcast':{label:'Bedeckt',description:'Geschlossene graue Wolkendecke, gleichmäßiges Licht.'},
  'clear-day':{label:'Klarer Tag',description:'Blauer Taghimmel mit wenigen Wolken.'},
  'storm':{label:'Gewitterhimmel',description:'Dunkle, dramatische Wolkendecke in Graublau.'},
  'sandstorm':{label:'Sandsturm',description:'Dichter ockerfarbener Staub, kein Horizontdetail.'},
  'aurora':{label:'Polarlicht',description:'Nacht mit grün-violetten Polarlichtvorhängen.'},
  'neon-night':{label:'Neon-Nacht',description:'Stadtnacht, Violett-Magenta mit Lichtglocke am Horizont.'},
};
const r4=(x:number)=>Math.round(x*1e4)/1e4;
/** Full parameter set of a preset in the working linear space; source procedural, depth/edge/spill defaults included. */
export function skyPresetParams(preset:SkyPreset,working:SpaceName):SkyParams{
  const t=PRESET_TABLE[preset],c=(v:RGB):ColorValue=>(working==='lin_rec709_srgb'?v:convertPixel(v,'lin_rec709_srgb',working)).map(r4) as RGB;
  const p:SkyParams={source:'procedural',preset,zenith:c(t.z),horizon:c(t.h),gradientPower:t.pw,exposure:t.ev,glow:t.glow,glowColor:typeof t.gc==='number'?[1,1,1]:c(t.gc),
    stars:t.stars,milkyWay:t.mw,clouds:t.cl,cloudContrast:t.cc,cloudScale:t.cs,cloudColor:c(t.cloud),aurora:t.aur,skyDepth:2,edge:.01,spill:t.spill};
  if(t.moon)p.moon={x:t.moon.x,height:t.moon.height,radius:t.moon.radius,intensity:t.moon.intensity,color:{kelvin:t.moon.kelvin}};
  return p;
}
