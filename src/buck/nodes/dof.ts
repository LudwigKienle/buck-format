import { clamp01, imageBuf, LUMA, smoothstep } from '../field';
import { BuckError, LINEAR_SPACES } from '../types';
import type { Buf, DofParams, ImageBuf, NodeImpl, Resolved, ScalarField, SpaceName } from '../types';
/**
 * lens.dof@1 (spec §5.3.2), CPU reference. Scatter-as-gather in two layers after Jimenez, "Next Generation Post
 * Processing in Call of Duty: Advanced Warfare" (SIGGRAPH 2014): every pixel p scatters its bokeh shape of radius R_p;
 * a pixel q gathers the samples whose own shape covers it. Samples nearer than q form the foreground layer (full radius,
 * composited over with its coverage alpha), samples at or behind q form the background layer within q's own radius, so a
 * sharp subject never receives background blur (cf. the size clamp in Gustafsson, "Bokeh depth of field in a single
 * pass", 2018). Fixed Vogel spiral mapped radially onto the aperture polygon (polygonal bokeh as in McIntosh et al.,
 * CGF 2012); CoC and depth from the nearest pixel; color bilinear while taps are dense, else nearest from a CoC-aware
 * prefilter in the bokeh shape once taps are sparser than one per pixel. Fixed order, no randomness.
 */
type P=Resolved<DofParams>;
/** Fallbacks for optional params when the graph omits them (assumed editor-style defaults; sensorWidth = 36 mm full frame). */
export const DOF_DEFAULTS={focus:.3,focusRange:.1,blurNear:.01,blurFar:.01,focusDistance:3,fNumber:2.8,focalLength:50,sensorWidth:36};
/** Samples per gather pass: about one per covered pixel², bounded so the cost per pixel stays fixed. */
export const DOF_SAMPLES={min:24,max:128};
const TILE=16,GOLDEN_ANGLE=Math.PI*(3-Math.sqrt(5)),SHARP=.5;

/** Signed circle-of-confusion diameter in image widths, negative in front of the focus, clamped to ±maxBlur. */
export function cocWidth(depth:number,p:P):number {
  const max=Math.max(0,p.maxBlur);
  // Invalid depth (NaN/+Inf, spec §6.4) counts as far.
  const far=Number.isNaN(depth)||depth===Infinity;
  let c:number;
  if(p.mode==='physical'){
    const N=p.fNumber??DOF_DEFAULTS.fNumber,f=p.focalLength??DOF_DEFAULTS.focalLength,sw=p.sensorWidth??DOF_DEFAULTS.sensorWidth;
    const s=(p.focusDistance??DOF_DEFAULTS.focusDistance)*1000;
    if(!(N>0&&f>0&&sw>0))return 0;
    const d=far?Infinity:depth*1000;
    if(d<=0)return -max;
    // A focus at or inside the focal length cannot be imaged: everything is maximally out of focus.
    if(!(s>f))return d<s?-max:max;
    // Thin lens, all lengths in mm: c = f²·|d − s| / (N·d·(s − f)); d → ∞ gives f² / (N·(s − f)).
    c=(d===Infinity?f*f/(N*(s-f)):f*f*Math.abs(d-s)/(N*d*(s-f)))/sw;
    if(d<s)c=-c;
  }else{
    const d=far?1:clamp01(depth),focus=p.focus??DOF_DEFAULTS.focus,half=Math.max(0,p.focusRange??DOF_DEFAULTS.focusRange)/2;
    const lo=focus-half,hi=focus+half;
    c=d<lo?-Math.max(0,p.blurNear??DOF_DEFAULTS.blurNear)*smoothstep(lo,0,d):d>hi?Math.max(0,p.blurFar??DOF_DEFAULTS.blurFar)*smoothstep(hi,1,d):0;
  }
  return c<-max?-max:c>max?max:c;
}
/**
 * Bokeh boundary radius at angle theta (radians, counter-clockwise, y up) relative to the circumradius 1. blades < 3 is a
 * circle; otherwise a regular n-gon (vertex at `rotationDeg`) blended toward the circle by `curvature` (rounded blades).
 */
export function bokehRadius(theta:number,blades:number,rotationDeg:number,curvature:number){
  const n=Math.round(blades);if(!(n>=3))return 1;
  const seg=2*Math.PI/n,a=theta-rotationDeg*Math.PI/180,t=a-seg*Math.floor(a/seg);
  // Distance from the center to the edge of a regular polygon with circumradius 1: apothem / cos(angle to the apothem).
  const poly=Math.cos(Math.PI/n)/Math.cos(t-Math.PI/n);
  return poly+(1-poly)*clamp01(curvature);
}
/** Integer sample count for a gather radius in pixels; `unitArea` is the bokeh area at radius 1 (π for a circle). */
export function dofSampleCount(radiusPx:number,unitArea=Math.PI){
  const n=Math.ceil(unitArea*radiusPx*radiusPx);
  return n<DOF_SAMPLES.min?DOF_SAMPLES.min:n>DOF_SAMPLES.max?DOF_SAMPLES.max:n;
}
/** Signed CoC radii (px) that may be blended in one tap: within 1 px and both sharp or both scattering. */
const similar=(a:number,b:number)=>Math.abs(a-b)<=1&&(Math.abs(a)<SHARP)===(Math.abs(b)<SHARP);
/** Area of the intersection of two unit circles whose centers are `dist` apart. */
const lensArea=(dist:number)=>dist>=2?0:2*Math.acos(dist/2)-dist/2*Math.sqrt(4-dist*dist);
const lumaFor=(space:SpaceName)=>space==='ACEScg'?LUMA.ap1:space==='ACES2065-1'?LUMA.ap0:LUMA.rec709;

/** Vogel spiral (r = √((k + ½)/n), θ = k·golden angle) mapped radially onto the bokeh shape. */
interface Pattern {n:number;ux:Float64Array;uy:Float64Array;r:Float64Array;s:Float64Array;a:Float64Array;}
function makePattern(n:number,shape:(theta:number)=>number,unitArea:number):Pattern {
  const ux=new Float64Array(n),uy=new Float64Array(n),r=new Float64Array(n),s=new Float64Array(n),a=new Float64Array(n);
  let s2=0;
  for(let k=0;k<n;k++){
    const rk=Math.sqrt((k+.5)/n),th=k*GOLDEN_ANGLE,sk=shape(th);
    r[k]=rk;s[k]=sk;ux[k]=rk*sk*Math.cos(th);uy[k]=-rk*sk*Math.sin(th);s2+=sk*sk;
  }
  // Radial mapping thins the density by S(θ)²; each sample stands for an area ∝ S², summing to the shape area at radius 1.
  for(let k=0;k<n;k++)a[k]=unitArea*s[k]*s[k]/s2;
  return{n,ux,uy,r,s,a};
}
/**
 * Prefiltered taps, interleaved per pixel in `c`: mean of hw·rgb and mean of hw over CoC-similar pixels in a bokeh-shaped
 * kernel of radius k + ½ (offsets dx, dy, flat dj). Level 0 is complete (done = null); others are filled on demand.
 */
interface Level {k:number;c:Float32Array;done:Uint8Array|null;dx:Int32Array;dy:Int32Array;dj:Int32Array;}
interface State {
  W:number;H:number;src:Float32Array;R:Float32Array;Rs:Float32Array;key:Float32Array;hw:Float32Array;invR2:Float32Array;
  /** R, Rs, key and invR2 interleaved per pixel (one cache line per gather tap). */
  attr:Float32Array;
  /** 1 where the 2×2 block starting at this pixel is mutually `similar`, so bilinear taps need no per-corner test. */
  coherent:Uint8Array;
  unitArea:number;shape:(theta:number)=>number;patterns:Pattern[];taps:Taps[];levels:Level[];acc:Float64Array;
  /** Integer pixel coordinates of the receiving pixel q. */
  qx:number;qy:number;Rq:number;dq:number;
  /** A tap is foreground when it is nearer than q and its signed CoC is below this limit. */
  frontLimit:number;wx:number;wy:number;shift:number;areaScale:number;
  /** Foreground radius band [fLo, fHi) of the current pass and the G² of the first foreground pass (color scale). */
  fLo:number;fHi:number;fG2:number;
}
const MAX_PREFILTER=8;
/**
 * Prefilter radius that closes the gaps between taps once they are sparser than one per pixel (cf. Jimenez' prefilter).
 * The factor and the +1 were tuned on point-light bokeh (interior variation ≤ 10 %, energy kept, polygon edges intact).
 */
export function prefilterRadius(radiusPx:number,unitArea=Math.PI){
  const spacing=Math.sqrt(unitArea*radiusPx*radiusPx/dofSampleCount(radiusPx,unitArea));
  return spacing<=1?0:Math.min(MAX_PREFILTER,Math.round(spacing*1.15)+1);
}
/** Tap spacing (px) of a gather pass of radius G after the 1/4 px quantization of `taps`. */
function tapSpacing(radius:number,unitArea:number){const G=Math.ceil(radius*4)/4;return Math.sqrt(unitArea*G*G/dofSampleCount(G,unitArea));}
function level(S:State,k:number):Level {
  const hit=S.levels[k];if(hit)return hit;
  const {W,H,src,hw}=S,count=W*H,c=new Float32Array(count*4);
  if(k===0){
    for(let i=0;i<count;i++){const w=hw[i];c[i*4]=w*src[i*4];c[i*4+1]=w*src[i*4+1];c[i*4+2]=w*src[i*4+2];c[i*4+3]=w;}
    return S.levels[k]={k,c,done:null,dx:new Int32Array(0),dy:new Int32Array(0),dj:new Int32Array(0)};
  }
  // CoC-bilateral prefilter with a kernel of the bokeh shape itself (radius k + ½): Minkowski sums of homothetic convex
  // shapes keep their form, so polygons stay polygons, unlike with a box. Similar neighbors only, so layers never mix.
  // Pixels are filled on first use (fillLevel); a pixel's value depends on its neighborhood only, never on the order.
  const dx:number[]=[],dy:number[]=[];
  for(let oy=-k;oy<=k;oy++)for(let ox=-k;ox<=k;ox++){const r=Math.hypot(ox,oy);if(r===0||r<=(k+.5)*S.shape(Math.atan2(-oy,ox))){dx.push(ox);dy.push(oy);}}
  return S.levels[k]={k,c,done:new Uint8Array(count),dx:Int32Array.from(dx),dy:Int32Array.from(dy),dj:Int32Array.from(dx,(v,t)=>dy[t]*W+v)};
}
/** Prefiltered value of pixel i: taps in raster order, sums in float64, exactly the per-pixel definition above. */
function fillLevel(S:State,L:Level,i:number){
  const {W,H,src,Rs,R,hw}=S,{k,c,dx,dy,dj}=L,m=dj.length,x=i%W,y=(i-x)/W,ri=Rs[i],si=R[i]<SHARP;
  let r=0,g=0,b=0,w=0,n=0;
  // Inline `similar`: |Rs_j − Rs_i| ≤ 1 and the same sharp/scattering class (R = |Rs|).
  if(x>=k&&x<W-k&&y>=k&&y<H-k){
    for(let t=0;t<m;t++){
      const j=i+dj[t];
      if(j!==i){const d=Rs[j]-ri;if(d>1||d<-1||(R[j]<SHARP)!==si)continue;}
      const v=hw[j],o=j*4;r+=v*src[o];g+=v*src[o+1];b+=v*src[o+2];w+=v;n++;
    }
  }else{
    for(let t=0;t<m;t++){
      const xx=x+dx[t],yy=y+dy[t];if(xx<0||xx>=W||yy<0||yy>=H)continue;
      const j=yy*W+xx;
      if(j!==i){const d=Rs[j]-ri;if(d>1||d<-1||(R[j]<SHARP)!==si)continue;}
      const v=hw[j],o=j*4;r+=v*src[o];g+=v*src[o+1];b+=v*src[o+2];w+=v;n++;
    }
  }
  const o=i*4;c[o]=r/n;c[o+1]=g/n;c[o+2]=b/n;c[o+3]=w/n;(L.done as Uint8Array)[i]=1;
}
/** Pixel-space taps of one pattern at radius G: nearest-pixel and bilinear-base offsets plus fractions, shared by every q. */
interface Taps {n:number;G:number;dxN:Int32Array;dyN:Int32Array;/** dyN·W + dxN and the offset bounds, for q away from the borders. */djN:Int32Array;dxMin:number;dxMax:number;dyMin:number;dyMax:number;bx:Int32Array;by:Int32Array;tx:Float64Array;ty:Float64Array;ox:Float64Array;oy:Float64Array;rho:Float64Array;s:Float64Array;a:Float64Array;prefilter:number;}
/** Radii are quantized up to 1/4 px so tap tables can be shared; the result depends on the pixel position only. */
function taps(S:State,radius:number):Taps {
  const q=Math.ceil(radius*4),hit=S.taps[q];if(hit)return hit;
  const G=q/4,n=dofSampleCount(G,S.unitArea),pt=S.patterns[n]??=makePattern(n,S.shape,S.unitArea);
  const dxN=new Int32Array(n),dyN=new Int32Array(n),bx=new Int32Array(n),by=new Int32Array(n),tx=new Float64Array(n),ty=new Float64Array(n);
  const ox=new Float64Array(n),oy=new Float64Array(n),rho=new Float64Array(n);
  for(let k=0;k<n;k++){
    // Tap position (x + ½ − ox, y + ½ − oy) for the pixel q = (x, y); p = q − o, so q − p = o points along the pattern ray.
    const sx=G*pt.ux[k],sy=G*pt.uy[k];ox[k]=sx;oy[k]=sy;rho[k]=G*pt.r[k];
    dxN[k]=Math.floor(.5-sx);dyN[k]=Math.floor(.5-sy);bx[k]=Math.floor(-sx);by[k]=Math.floor(-sy);tx[k]=-sx-bx[k];ty[k]=-sy-by[k];
  }
  return S.taps[q]={n,G,dxN,dyN,djN:Int32Array.from(dxN,(v,k)=>dyN[k]*S.W+v),dxMin:Math.min(0,...dxN),dxMax:Math.max(0,...dxN),dyMin:Math.min(0,...dyN),dyMax:Math.max(0,...dyN),bx,by,tx,ty,ox,oy,rho,s:pt.s,a:pt.a,prefilter:prefilterRadius(G,S.unitArea)};
}
/**
 * One gather pass of radius ≥ G around pixel (S.qx, S.qy); writes background sums to acc[0..3] and adds foreground sums
 * of the scatterers with S.fLo ≤ R < S.fHi to acc[4..8].
 */
function gather(S:State,radius:number,doB:boolean,doF:boolean){
  const T=taps(S,radius),{n,dxN,dyN,djN,bx,by,tx,ty,ox,oy,rho,s,a}=T,L=level(S,T.prefilter),lc=L.c,done=L.done,nearest=T.prefilter>0;
  const {W,H,Rs,attr,coherent,qx:x,qy:y,Rq,dq,frontLimit,wx,wy,shift,acc,fLo,fHi}=S,ia=1/S.areaScale,iq=1/(Rq*Rq);
  // Away from the borders the nearest tap pixel needs no clamping.
  const inside=x+T.dxMin>=0&&x+T.dxMax<W&&y+T.dyMin>=0&&y+T.dyMax<H,qj=y*W+x;
  let bR=0,bG=0,bB=0,bW=0,fR=0,fG=0,fB=0,fW=0,alpha=0;
  for(let k=0;k<n;k++){
    let j:number;
    if(inside)j=qj+djN[k];
    else{let ix=x+dxN[k],iy=y+dyN[k];ix=ix<0?0:ix>=W?W-1:ix;iy=iy<0?0:iy>=H?H-1:iy;j=iy*W+ix;}
    const pa=j*4,Rp=attr[pa],front=attr[pa+2]<dq&&attr[pa+1]<frontLimit;
    if(front?!doF||Rp<fLo||Rp>=fHi:!doB)continue;
    // Samples at or behind q spread with q's radius: a sharp q gathers nothing from behind (no background bleeding over a
    // sharp subject), a blurred foreground q shows the neighboring background through its own blur (symmetric silhouettes).
    const reff=front?Rp:Rq;
    // Coverage of q by p's shape with a one-pixel soft edge measured along the sample ray.
    let cov=(reff-rho[k])*s[k]+.5;if(cov<=0)continue;if(cov>1)cov=1;
    if(shift>0){const vx=ox[k]-shift*reff*wx,vy=oy[k]-shift*reff*wy,cc=reff-Math.sqrt(vx*vx+vy*vy)+.5;if(cc<=0)continue;if(cc<cov)cov=cc;}
    const w=a[k]*cov*ia*(front?attr[pa+3]:iq);
    // Prefiltered levels are already smooth at the tap spacing, so the nearest pixel suffices (about 4× cheaper).
    if(nearest){if(done!==null&&done[j]===0)fillLevel(S,L,j);const c=j*4,cr=w*lc[c],cg=w*lc[c+1],cb=w*lc[c+2],ch=w*lc[c+3];if(front){alpha+=w;fR+=cr;fG+=cg;fB+=cb;fW+=ch;}else{bR+=cr;bG+=cg;bB+=cb;bW+=ch;}continue;}
    // Dense taps fetch color bilinearly (like a GPU texture tap) from similar corners; CoC and depth stay nearest-pixel.
    let x0=x+bx[k],y0=y+by[k],fx=tx[k],fy=ty[k];
    if(x0<0){x0=0;fx=0;}else if(x0>=W-1){x0=W-1;fx=0;}
    if(y0<0){y0=0;fy=0;}else if(y0>=H-1){y0=H-1;fy=0;}
    const x1=x0+1<W?x0+1:x0,y1=y0+1<H?y0+1:y0;
    const j00=y0*W+x0,j10=y0*W+x1,j01=y1*W+x0,j11=y1*W+x1;
    let w00=(1-fx)*(1-fy),w10=fx*(1-fy),w01=(1-fx)*fy,w11=fx*fy,ws=1;
    if(!coherent[j00]){
      const rp=Rs[j];
      if(j00!==j&&!similar(Rs[j00],rp))w00=0;
      if(j10!==j&&!similar(Rs[j10],rp))w10=0;
      if(j01!==j&&!similar(Rs[j01],rp))w01=0;
      if(j11!==j&&!similar(Rs[j11],rp))w11=0;
      // The nearest pixel is always one of the corners with weight ≥ 1/4, so ws > 0.
      ws=w00+w10+w01+w11;
    }
    const m=ws===1?w:w/ws,a00=m*w00,a10=m*w10,a01=m*w01,a11=m*w11,c00=j00*4,c10=j10*4,c01=j01*4,c11=j11*4;
    const cr=a00*lc[c00]+a10*lc[c10]+a01*lc[c01]+a11*lc[c11];
    const cg=a00*lc[c00+1]+a10*lc[c10+1]+a01*lc[c01+1]+a11*lc[c11+1];
    const cb=a00*lc[c00+2]+a10*lc[c10+2]+a01*lc[c01+2]+a11*lc[c11+2];
    const ch=a00*lc[c00+3]+a10*lc[c10+3]+a01*lc[c01+3]+a11*lc[c11+3];
    if(front){alpha+=w;fR+=cr;fG+=cg;fB+=cb;fW+=ch;}
    else{bR+=cr;bG+=cg;bB+=cb;bW+=ch;}
  }
  if(doB){acc[0]=bR;acc[1]=bG;acc[2]=bB;acc[3]=bW;}
  // Σ tap area (a·G²) / scatter area (unitArea·R²·areaScale) = fraction of q covered by foreground shapes. Colors of a
  // later (denser) pass are scaled to the tap area of the first pass so that both mix by covered area.
  if(doF){
    const G2=T.G*T.G,f=S.fG2===0?(S.fG2=G2,1):G2/S.fG2;
    acc[4]+=fR*f;acc[5]+=fG*f;acc[6]+=fB*f;acc[7]+=fW*f;acc[8]+=alpha*G2/S.unitArea;
  }
}

function renderDof(image:ImageBuf,depth:ScalarField,p:P):ImageBuf {
  const {width:W,height:H}=image,src=image.data,dd=depth.data,count=W*H;
  const R=new Float32Array(count),Rs=new Float32Array(count),key=new Float32Array(count);
  let maxR=0;
  for(let i=0;i<count;i++){
    const d=dd[i];key[i]=Number.isNaN(d)?Infinity:d;
    const r=cocWidth(d,p)*W/2;Rs[i]=r;R[i]=Math.abs(r);if(R[i]>maxR)maxR=R[i];
  }
  // Nothing scatters beyond its own pixel: the input passes through bit-identically.
  if(maxR<SHARP)return imageBuf(W,H,image.space,new Float32Array(src));

  const blades=p.blades,rot=p.rotation,curv=p.bladeCurvature,shape=(th:number)=>bokehRadius(th,blades,rot,curv);
  let m2=0;for(let k=0;k<1024;k++){const s=shape(k*2*Math.PI/1024);m2+=s*s;}
  // Highlight boost: a sample's weight grows linearly with its luminance above 1 (scene-linear only, never below 1).
  const boost=Math.max(0,p.highlightBoost),hw=new Float32Array(count).fill(1);
  if(boost>0){const [lr,lg,lb]=lumaFor(image.space);for(let i=0;i<count;i++){const y=lr*src[i*4]+lg*src[i*4+1]+lb*src[i*4+2];if(y>1)hw[i]=1+boost*(y-1);}}
  const coherent=new Uint8Array(count);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x,i1=x+1<W?i+1:i,i2=y+1<H?i+W:i,i3=y+1<H?i1+W:i1;
    const a=Rs[i],b=Rs[i1],c=Rs[i2],d=Rs[i3],lo=Math.min(a,b,c,d),hi=Math.max(a,b,c,d),s=R[i]<SHARP;
    coherent[i]=hi-lo<=1&&(R[i1]<SHARP)===s&&(R[i2]<SHARP)===s&&(R[i3]<SHARP)===s?1:0;
  }
  const invR2=new Float32Array(count);for(let i=0;i<count;i++)if(R[i]>=SHARP)invR2[i]=1/(R[i]*R[i]);
  const attr=new Float32Array(count*4);for(let i=0;i<count;i++){attr[i*4]=R[i];attr[i*4+1]=Rs[i];attr[i*4+2]=key[i];attr[i*4+3]=invR2[i];}
  const S:State={W,H,src,R,Rs,key,hw,invR2,attr,coherent,unitArea:Math.PI*m2/1024,shape,patterns:[],taps:[],levels:[],acc:new Float64Array(9),qx:0,qy:0,Rq:0,dq:0,frontLimit:0,wx:0,wy:0,shift:0,areaScale:1,fLo:SHARP,fHi:Infinity,fG2:0};

  // Tile max CoC radius and min signed CoC of scatterers, dilated to every tile a scatterer can reach (foreground reach).
  const tw=Math.ceil(W/TILE),th=Math.ceil(H/TILE),tMax=new Float64Array(tw*th),tMin=new Float64Array(tw*th).fill(Infinity);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x,r=R[i];if(r<SHARP)continue;
    const t=(y/TILE|0)*tw+(x/TILE|0);if(r>tMax[t])tMax[t]=r;if(Rs[i]<tMin[t])tMin[t]=Rs[i];
  }
  const gMax=new Float64Array(tw*th),gMin=new Float64Array(tw*th).fill(Infinity),reach=Math.ceil((maxR+1)/TILE);
  for(let ty=0;ty<th;ty++)for(let tx=0;tx<tw;tx++){
    let g=0,m=Infinity;
    for(let vy=Math.max(0,ty-reach);vy<=Math.min(th-1,ty+reach);vy++)for(let vx=Math.max(0,tx-reach);vx<=Math.min(tw-1,tx+reach);vx++){
      const u=vy*tw+vx,r=tMax[u];if(r<SHARP)continue;
      const gx=Math.max(0,Math.abs(vx-tx)-1)*TILE,gy=Math.max(0,Math.abs(vy-ty)-1)*TILE;
      if(Math.hypot(gx,gy)>r+1)continue;
      if(r>g)g=r;if(tMin[u]<m)m=tMin[u];
    }
    gMax[ty*tw+tx]=g;gMin[ty*tw+tx]=m;
  }
  // Smallest scatter radius in the tile and its 8 neighbors: decides whether a denser foreground pass is needed.
  const tRmin=new Float64Array(tw*th).fill(Infinity),gRmin=new Float64Array(tw*th).fill(Infinity);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const r=R[y*W+x],t=(y/TILE|0)*tw+(x/TILE|0);if(r>=SHARP&&r<tRmin[t])tRmin[t]=r;}
  for(let ty=0;ty<th;ty++)for(let tx=0;tx<tw;tx++){
    let m=Infinity;
    for(let vy=Math.max(0,ty-1);vy<=Math.min(th-1,ty+1);vy++)for(let vx=Math.max(0,tx-1);vx<=Math.min(tw-1,tx+1);vx++)if(tRmin[vy*tw+vx]<m)m=tRmin[vy*tw+vx];
    gRmin[ty*tw+tx]=m;
  }

  // Cat eye: each shape is clipped by a second circle of the same radius, shifted toward the image center by
  // catEye·(distance from center / half diagonal) radii (assumed optical-vignetting model, 0 at the center).
  const cat=clamp01(p.catEye),halfDiag=Math.hypot(W/2,H/2),acc=S.acc;
  const out=imageBuf(W,H,image.space),o=out.data;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x,c=i*4,t=(y/TILE|0)*tw+(x/TILE|0),Rq=R[i],dq=key[i],sharp=Rq<SHARP;
    // Signed CoC grows monotonically with depth. Nearer taps within 1 px of q's CoC join the background layer (same
    // result, cheaper); for a sharp q every nearer scatterer, i.e. every near-side one (signed CoC < 0), is foreground.
    const limit=sharp?Infinity:Rs[i]-1,needF=gMax[t]>=SHARP&&gMin[t]<(sharp?0:limit);
    S.frontLimit=limit;
    o[c+3]=src[c+3];
    if(sharp&&!needF){o[c]=src[c];o[c+1]=src[c+1];o[c+2]=src[c+2];continue;}
    S.qx=x;S.qy=y;S.Rq=Rq;S.dq=dq;
    if(cat>0){
      const dx=x+.5-W/2,dy=y+.5-H/2,len=Math.hypot(dx,dy);
      S.shift=len>0?cat*len/halfDiag:0;S.wx=len>0?-dx/len:0;S.wy=len>0?-dy/len:0;S.areaScale=lensArea(S.shift)/Math.PI;
    }
    acc.fill(0);S.fG2=0;
    const gB=Rq+.5,gF=gMax[t]+1,combined=!sharp&&needF&&gF<=gB+1;
    if(!sharp&&!combined)gather(S,gB,true,false);
    // Fix within lens.dof@1 (prototype draft 0.1): a sparse foreground tap stands for spacing² px of scatterers. A
    // scatterer whose own radius is below the tap spacing (e.g. the soft depth ramp of an estimated silhouette) was
    // counted with that whole area, so a single tap could reach coverage ≥ 1 and stamp a dark dot next to a sharp
    // subject. Such scatterers are now left to a denser pass of radius spacing + 1, repeated until taps are ≤ 1 px apart.
    if(needF){
      let g=gF,hi=Infinity,doB=combined;
      for(;;){
        const sp=tapSpacing(g,S.unitArea),lo=sp>1&&(sp+1>TILE||gRmin[t]<sp)?sp:SHARP;
        S.fLo=lo;S.fHi=hi;gather(S,g,doB,true);
        if(lo===SHARP)break;
        doB=false;hi=lo;g=lo+1;
      }
    }
    let br=src[c],bg=src[c+1],bb=src[c+2];
    if(!sharp&&acc[3]>0){br=acc[0]/acc[3];bg=acc[1]/acc[3];bb=acc[2]/acc[3];}
    const al=acc[8]>1?1:acc[8];
    if(acc[7]>0&&al>0){
      const k=al/acc[7],ik=1-al;
      o[c]=acc[4]*k+br*ik;o[c+1]=acc[5]*k+bg*ik;o[c+2]=acc[6]*k+bb*ik;
    }else{o[c]=br;o[c+1]=bg;o[c+2]=bb;}
  }
  return out;
}

export const dofNode:NodeImpl<'lens.dof@1'>={
  type:'lens.dof@1',
  evaluate(inputs:Record<string,Buf|undefined>,p:P,ctx){
    const image=inputs.image,depth=inputs.depth;
    if(!image||image.kind!=='image')throw new BuckError('Tiefenschärfe: Bildeingang fehlt.');
    if(!depth||depth.kind!=='scalar')throw new BuckError('Tiefenschärfe: Tiefeneingang fehlt.');
    if(!LINEAR_SPACES.includes(image.space))throw new BuckError(`Tiefenschärfe braucht einen linearen Farbraum, Eingang ist „${image.space}“. Davor einen Konvertierungsknoten setzen.`);
    if(depth.width!==image.width||depth.height!==image.height)throw new BuckError(`Tiefenschärfe: Tiefe ${depth.width}×${depth.height} passt nicht zum Bild ${image.width}×${image.height}.`);
    if(p.mode==='physical'){
      const N=p.fNumber??DOF_DEFAULTS.fNumber,f=p.focalLength??DOF_DEFAULTS.focalLength,sw=p.sensorWidth??DOF_DEFAULTS.sensorWidth;
      if(!(N>0&&f>0&&sw>0))ctx.warn('Tiefenschärfe: Blendenzahl, Brennweite und Sensorbreite müssen positiv sein – der Effekt bleibt aus.');
      else if(!((p.focusDistance??DOF_DEFAULTS.focusDistance)*1000>f))ctx.warn('Tiefenschärfe: Die Fokusdistanz liegt innerhalb der Brennweite – alles ist maximal unscharf.');
    }
    return renderDof(image,depth,p);
  },
};
