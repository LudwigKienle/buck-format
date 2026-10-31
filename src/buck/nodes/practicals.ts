import { colorValueToRGB, convertPixel, isLinearSpace, lumaWeights } from '../colorspace';
import { clamp01, gaussianBlurWide, imageBuf, smoothstep } from '../field';
import { extremeFilter } from './masks';
import { BuckError } from '../types';
import type { Buf, ColorValue, NodeImpl, PracticalsParams, Resolved, RGB, SpaceName } from '../types';
/**
 * light.practicals@1 (spec §5.3.5). Heuristic detection of practical lights (bright, compact regions: luminance threshold
 * plus a size band from two grayscale openings), recoloring at constant luminance, and screen-space light: core boost,
 * multi-scale glow and a broad "throw" onto the surroundings with an albedo estimate, optional depth similarity and normals.
 * No light transport and no shadows. Sizes are in image widths, so detection does not depend on the resolution.
 */
type P=Resolved<PracticalsParams>;
/** Fixed constants of @1: glow/throw scale factors and weights, albedo low-pass and depth tolerance. */
export const PRACTICALS={glowScales:[.5,1,2],glowWeights:[.5,.3,.2],throwScales:[.25,.5,1],refArea:4e-4,albedoLowpass:.02,depthTolerance:.25,maxPoints:8};
const EPS=1e-4;

/** Opening (erode → dilate) with a square of radius r px; r = 0 copies. */
function opening(m:Float32Array,w:number,h:number,r:number){return r>0?extremeFilter(extremeFilter(m,w,h,r,false),w,h,r,true):new Float32Array(m);}

/**
 * Detection mask 0…1: smoothstep around `threshold` (± softness EV) times a local-contrast test (luminance over its Gaussian
 * surround of sigma maxSize, smoothstep around 2^contrast ± 0.5 EV), minus everything narrower than minSize or wider than maxSize.
 */
export function detectPracticals(y:Float32Array,w:number,h:number,p:Pick<P,'threshold'|'softness'|'contrast'|'minSize'|'maxSize'>){
  const thr=Math.max(EPS,p.threshold),s=Math.max(0,p.softness),lo=thr*2**-s,hi=thr*2**s,cand=new Float32Array(y.length);
  const surround=gaussianBlurWide(y,w,h,1,Math.max(0,p.maxSize)*w),c=Math.max(0,p.contrast),clo=2**(c-.5),chi=2**(c+.5);
  for(let i=0;i<y.length;i++)cand[i]=smoothstep(lo,hi,y[i])*(c>0?smoothstep(clo,chi,y[i]/Math.max(EPS,surround[i])):1);
  const rmin=Math.round(Math.max(0,p.minSize)*w),rmax=Math.round(Math.max(0,p.maxSize)*w),out=new Float32Array(y.length);
  if(rmax<=rmin)return out;
  const small=opening(cand,w,h,rmin),large=opening(cand,w,h,rmax);
  for(let i=0;i<out.length;i++)out[i]=clamp01(small[i]-large[i]);
  return out;
}
const lin=(c:ColorValue,space:SpaceName,working:SpaceName):RGB=>{const v=colorValueToRGB(c,working);return space===working?v:convertPixel(v,working,space);};

export const practicalsNode:NodeImpl<'light.practicals@1'>={
  type:'light.practicals@1',
  evaluate(inputs:Record<string,Buf|undefined>,p:P,ctx){
    const image=inputs.image,depth=inputs.depth,normals=inputs.normals;
    if(!image||image.kind!=='image')throw new BuckError('Lampen: Bildeingang fehlt.');
    if(!isLinearSpace(image.space))throw new BuckError(`Lampen braucht einen linearen Farbraum, Eingang ist „${image.space}“. Davor einen Konvertierungsknoten setzen.`);
    const {width:W,height:H}=image,n=W*H,src=image.data,space=image.space,wt=lumaWeights(space);
    if(depth&&(depth.kind!=='scalar'||depth.width!==W||depth.height!==H))throw new BuckError('Lampen: Tiefe passt nicht zum Bild.');
    if(normals&&(normals.kind!=='vector3'||normals.width!==W||normals.height!==H))throw new BuckError('Lampen: Normalen passen nicht zum Bild.');
    const points=p.points??[];
    if(points.length>PRACTICALS.maxPoints)throw new BuckError(`Lampen: höchstens ${PRACTICALS.maxPoints} manuelle Lichtpunkte.`);
    const g=2**p.intensity-1,s=clamp01(p.recolor),out=imageBuf(W,H,space,new Float32Array(src)),o=out.data;
    if(g===0&&s===0&&!points.length)return out;
    const Y=new Float32Array(n);for(let i=0;i<n;i++){const j=i*4;Y[i]=wt[0]*src[j]+wt[1]*src[j+1]+wt[2]*src[j+2];}
    const m=detectPracticals(Y,W,H,p);
    // Recolor at constant luminance: c → c + s·(Y·T/Y(T) − c).
    const T=lin(p.color,space,ctx.workingLinear),ty=Math.max(EPS,wt[0]*T[0]+wt[1]*T[1]+wt[2]*T[2]),tn=T.map(v=>v/ty);
    const E=new Float32Array(n*3);let anyE=false;
    for(let i=0;i<n;i++){
      const k=m[i];if(!(k>0))continue;
      const j=i*4;anyE=true;
      for(let c=0;c<3;c++){const rc=src[j+c]+s*(Y[i]*tn[c]-src[j+c]);E[i*3+c]=k*rc;o[j+c]=src[j+c]+k*(rc-src[j+c])+k*rc*g;}
    }
    // Manual points: soft disc, own color (default: node color) at 0.18·2^intensity, added to the image and the emission.
    for(const pt of points){
      const r=Math.max(1e-4,pt.radius),col=lin(pt.color??p.color,space,ctx.workingLinear),cy=Math.max(EPS,wt[0]*col[0]+wt[1]*col[1]+wt[2]*col[2]),e=.18*2**pt.intensity/cy;
      const x0=Math.max(0,Math.floor((pt.x-r)*W)),x1=Math.min(W-1,Math.ceil((pt.x+r)*W)),y0=Math.max(0,Math.floor((pt.y-r)*W)),y1=Math.min(H-1,Math.ceil((pt.y+r)*W));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const k=1-smoothstep(r*.6,r,Math.hypot((x+.5)/W-pt.x,(y+.5)/W-pt.y));if(!(k>0))continue;
        const i=y*W+x,j=i*4;anyE=true;
        for(let c=0;c<3;c++){const v=k*col[c]*e;E[i*3+c]+=v;o[j+c]+=v;}
      }
    }
    if(!anyE||g===0)return out;
    const blur=(sigmaW:number)=>gaussianBlurWide(E,W,H,3,Math.max(0,sigmaW)*W);
    if(p.glow>0&&p.glowRadius>0){
      PRACTICALS.glowScales.forEach((f,k)=>{const b=blur(p.glowRadius*f),wk=p.glow*g*PRACTICALS.glowWeights[k];for(let i=0;i<n;i++){const j=i*4;o[j]+=b[i*3]*wk;o[j+1]+=b[i*3+1]*wk;o[j+2]+=b[i*3+2]*wk;}});
    }
    if(p.throw>0){
      // Multi-scale Gaussians approximate a heavy-tailed falloff; weight_k ∝ 2^(−2·falloff·k), small scale first.
      // Each scale is normalized by 2π·σ_k²/refArea: a source of refArea at luminance 1 lights its center with 1.
      const ws=PRACTICALS.throwScales.map((_,k)=>2**(-2*Math.max(0,p.falloff)*k)),wsum=ws.reduce((a,b)=>a+b,0),room=new Float32Array(n*3);
      PRACTICALS.throwScales.forEach((f,k)=>{const sw=p.throw*f,b=blur(sw),norm=ws[k]/wsum*2*Math.PI*sw*sw/PRACTICALS.refArea;for(let i=0;i<n*3;i++)room[i]+=b[i]*norm;});
      const ylow=gaussianBlurWide(Y,W,H,1,PRACTICALS.albedoLowpass*W);
      let dw:Float32Array|undefined;
      if(depth){
        // Emission-weighted mean source depth at the widest scale; surfaces at a similar depth receive the light.
        const ey=new Float32Array(n),ed=new Float32Array(n);
        for(let i=0;i<n;i++){const e=wt[0]*E[i*3]+wt[1]*E[i*3+1]+wt[2]*E[i*3+2],d=depth.data[i];ey[i]=e;ed[i]=e*(Number.isFinite(d)?d:1);}
        const by=gaussianBlurWide(ey,W,H,1,p.throw*W),bd=gaussianBlurWide(ed,W,H,1,p.throw*W);dw=new Float32Array(n);
        for(let i=0;i<n;i++){const d=depth.data[i];dw[i]=Number.isFinite(d)&&by[i]>1e-12?Math.exp(-(((d-bd[i]/by[i])/PRACTICALS.depthTolerance)**2)):0;}
      }
      for(let i=0;i<n;i++){
        let k=g/Math.max(EPS,ylow[i]);if(dw)k*=dw[i];
        if(normals){
          const v=i*3,nx=normals.data[v],ny=normals.data[v+1],nz=normals.data[v+2];
          if(nx!==0||ny!==0||nz!==0){
            // Screen-space direction toward the sources = gradient of the room light luminance (+Y up in camera space).
            const x=i%W,y=(i-x)/W,ly=(q:number)=>wt[0]*room[q*3]+wt[1]*room[q*3+1]+wt[2]*room[q*3+2];
            const gx=ly(y*W+Math.min(W-1,x+1))-ly(y*W+Math.max(0,x-1)),gy=ly(Math.max(0,y-1)*W+x)-ly(Math.min(H-1,y+1)*W+x),gl=Math.hypot(gx,gy);
            const lx=gl>0?gx/gl:0,lyy=gl>0?gy/gl:0,len=Math.hypot(lx,lyy,.6);
            k*=Math.max(0,((nx*lx+ny*lyy+nz*.6)/len+.5)/1.5);
          }
        }
        if(!(k>0))continue;
        const j=i*4;for(let c=0;c<3;c++)o[j+c]+=src[j+c]*room[i*3+c]*k;
      }
    }
    return out;
  },
};
