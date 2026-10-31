import { normalsFromDepth } from '../aux/normals';
import { scalarField } from '../field';
import { blur1, clamp, hash01, smooth } from './common';
import type { Work } from './common';
/**
 * Light direction by least squares on Lambert shading: log Y − log Gσ(Y) (σ = 10 % image width; removes albedo-free large
 * gradients such as vignetting or the sky/ground split) ≈ c₀ + v·n, with normals from the reference depth
 * (normals-from-depth@1, the same derivation the format uses). L = v/|v|. Albedo edges, cast shadows, specular highlights
 * and wrong normals all enter as noise, so the confidence combines the fit quality (R²), how well the normals span the
 * directions (smallest eigenvalue of their covariance), a split-half test and the depth source; Behelf depth caps it hard.
 */
export interface DirectionFit {azimuth:number;elevation:number;strength:number;r2:number;spread:number;samples:number;confidence:number;}
function solve4(A:number[][],b:number[]):number[]|undefined{
  const M=A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<4;c++){
    let p=c;for(let r=c+1;r<4;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;
    if(Math.abs(M[p][c])<1e-12)return undefined;[M[c],M[p]]=[M[p],M[c]];
    for(let r=0;r<4;r++)if(r!==c){const f=M[r][c]/M[c][c];for(let k=c;k<5;k++)M[r][k]-=f*M[c][k];}
  }
  return M.map((r,i)=>r[4]/M[i][i]);
}
/** Smallest eigenvalue of a symmetric 3×3 matrix (closed form, Smith 1961). */
function minEigen(m:number[][]){
  const p1=m[0][1]**2+m[0][2]**2+m[1][2]**2,q=(m[0][0]+m[1][1]+m[2][2])/3;
  if(p1<1e-15)return Math.min(m[0][0],m[1][1],m[2][2]);
  const p2=(m[0][0]-q)**2+(m[1][1]-q)**2+(m[2][2]-q)**2+2*p1,p=Math.sqrt(p2/6);
  const B=m.map((r,i)=>r.map((v,j)=>(v-(i===j?q:0))/p)),det=B[0][0]*(B[1][1]*B[2][2]-B[1][2]*B[2][1])-B[0][1]*(B[1][0]*B[2][2]-B[1][2]*B[2][0])+B[0][2]*(B[1][0]*B[2][1]-B[1][1]*B[2][0]);
  const phi=Math.acos(clamp(det/2,-1,1))/3;return q+2*p*Math.cos(phi+2*Math.PI/3);
}
interface Row {x:number[];s:number;wt:number;}
function fit(rows:Row[]){
  const AtA=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],Atb=[0,0,0,0];
  for(const r of rows)for(let a=0;a<4;a++){Atb[a]+=r.wt*r.x[a]*r.s;for(let b=0;b<4;b++)AtA[a][b]+=r.wt*r.x[a]*r.x[b];}
  return solve4(AtA,Atb);
}
const angleDeg=(a:number[],b:number[])=>{const la=Math.hypot(a[1],a[2],a[3]),lb=Math.hypot(b[1],b[2],b[3]);return la>0&&lb>0?Math.acos(clamp((a[1]*b[1]+a[2]*b[2]+a[3]*b[3])/(la*lb),-1,1))*180/Math.PI:180;};
/**
 * Both sides are high-passed with the same masked Gaussian (σ = 10 % width): s − Gσ(s) = v·(n − Gσ(n)). This removes the
 * smooth normal drift that normals-from-depth produces on a ground plane in perspective (true shading constant, estimated
 * normal varying) together with large-scale brightness gradients. Stability: the fit is repeated on two disjoint pixel halves
 * (fixed hash), their angle lowers the confidence. A systematic bias of the derived normals is not detected by this.
 */
export function fitLightDirection(work:Work,sky:Uint8Array,weights:Float32Array):DirectionFit|undefined{
  const {w,h,Y,depth}=work,n=w*h;
  if(work.depthKind==='none')return undefined;
  const normals=normalsFromDepth(scalarField(w,h,new Float32Array(depth)),.004).data;
  const vm=new Float32Array(n);
  for(let i=0;i<n;i++){const z=normals[i*3]===0&&normals[i*3+1]===0&&normals[i*3+2]===0;vm[i]=!sky[i]&&!z&&Y[i]>.01&&Y[i]<.95&&weights[i]>0?1:0;}
  const sigma=.1*w,mb=blur1(vm,w,h,sigma);
  const hp=(v:Float32Array)=>{const a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=v[i]*vm[i];const b=blur1(a,w,h,sigma),o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=mb[i]>1e-3?v[i]-b[i]/mb[i]:0;return o;};
  const logY=new Float32Array(n),nx=new Float32Array(n),ny=new Float32Array(n),nz=new Float32Array(n);
  for(let i=0;i<n;i++){logY[i]=Math.log(Math.max(1e-4,Y[i]));nx[i]=normals[i*3];ny[i]=normals[i*3+1];nz[i]=normals[i*3+2];}
  const s=hp(logY),hx=hp(nx),hy=hp(ny),hz=hp(nz);
  const rows:Row[]=[],cov=[[0,0,0],[0,0,0],[0,0,0]];let ws=0;
  for(let i=0;i<n;i++){
    if(!vm[i]||mb[i]<.2)continue;
    const wt=weights[i],x=[1,hx[i],hy[i],hz[i]];rows.push({x,s:s[i],wt});ws+=wt;
    for(let a=0;a<3;a++)for(let b=0;b<3;b++)cov[a][b]+=wt*x[a+1]*x[b+1];
  }
  if(rows.length<200||!(ws>0))return undefined;
  for(let a=0;a<3;a++)for(let b=0;b<3;b++)cov[a][b]/=ws;
  const sol=fit(rows);if(!sol)return undefined;
  const v=[sol[1],sol[2],sol[3]],len=Math.hypot(v[0],v[1],v[2]);if(!(len>1e-6))return undefined;
  const halfA=fit(rows.filter((_,k)=>hash01(k,5)<.5)),halfB=fit(rows.filter((_,k)=>hash01(k,5)>=.5)),split=halfA&&halfB?angleDeg(halfA,halfB):180;
  let sse=0,sst=0,sm=0;for(const r of rows)sm+=r.wt*r.s;sm/=ws;
  for(const r of rows){const p=sol[0]+sol[1]*r.x[1]+sol[2]*r.x[2]+sol[3]*r.x[3];sse+=r.wt*(r.s-p)**2;sst+=r.wt*(r.s-sm)**2;}
  const r2=sst>0?clamp(1-sse/sst):0,spread=Math.max(0,minEigen(cov)),L=v.map(c=>c/len);
  const azimuth=Math.round(Math.atan2(L[0],L[2])*180/Math.PI),elevation=Math.round(Math.asin(clamp(L[1],-1,1))*180/Math.PI);
  const depthFactor=work.depthKind==='heuristic'?.35:1;
  // Capped at 0.65 („mittel“): normals derived from relative depth can be biased in ways neither R² nor the split test sees
  // (synthetic test scenes: up to ~30° azimuth error with a consistent fit).
  const confidence=Math.min(.65,clamp(Math.sqrt(r2)*1.6)*smooth(.0005,.006,spread)*smooth(.03,.2,len)*clamp(1-split/40)*depthFactor);
  return {azimuth,elevation,strength:Math.round(len*1e3)/1e3,r2:Math.round(r2*1e3)/1e3,spread:Math.round(spread*1e4)/1e4,samples:rows.length,confidence};
}
