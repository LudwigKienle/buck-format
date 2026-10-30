import { BASELINE } from './analysis';
import type { Profile } from './analysis';
import { clamp, convert, gamutMap, luma, mix, smooth, SPACES } from './spaces';
import type { RGB, SpaceId } from './spaces';
import { applyLook, brightnessCurve, contrastCurve, skinKey } from './look';
import type { LookSpec } from './look';
/** brightness/contrast: -1…1, applied after the look at full strength. look/prompt: optional described look. */
export interface Settings {input:SpaceId;output:SpaceId;size:24|33|64|65;strength:number;skin:number;density:number;rolloff:number;brightness:number;contrast:number;mode:'reference'|'correct';look?:LookSpec;prompt?:string;}
export const DEFAULT_SETTINGS:Settings={input:'rec709',output:'rec709',size:64,strength:.7,skin:.5,density:0,rolloff:.1,brightness:0,contrast:0,mode:'reference'};
export interface Curve {x:number[];y:number[];m:number[];}
export interface Model {curve:Curve;matrix:number[];offset:number[];settings:Settings;notes:string[];}
/** Fritsch–Carlson monotonic Hermite interpolation: no tone-curve overshoot. */
export function makeCurve(x:number[],y:number[]):Curve {
  const n=x.length,d=x.slice(1).map((v,i)=>(y[i+1]-y[i])/(v-x[i])),m=[d[0]];
  for(let i=1;i<n-1;i++)m.push(d[i-1]*d[i]<=0?0:2/(1/d[i-1]+1/d[i]));m.push(d[n-2]);
  for(let i=0;i<n-1;i++){if(Math.abs(d[i])<1e-12){m[i]=0;m[i+1]=0;continue;}const a=m[i]/d[i],b=m[i+1]/d[i],h=Math.hypot(a,b);if(h>3){m[i]=3*a/h*d[i];m[i+1]=3*b/h*d[i];}}
  return{x,y,m};
}
export function curveAt(c:Curve,value:number){
  const x=clamp(value);let i=0;while(i<c.x.length-2&&x>c.x[i+1])i++;
  const h=c.x[i+1]-c.x[i],t=(x-c.x[i])/h,t2=t*t,t3=t2*t;
  return (2*t3-3*t2+1)*c.y[i]+(t3-2*t2+t)*h*c.m[i]+(-2*t3+3*t2)*c.y[i+1]+(t3-t2)*h*c.m[i+1];
}
function sqrtCov([a,b,d]:number[]){a+=.001;d+=.001;const s=Math.sqrt(Math.max(1e-12,a*d-b*b)),t=Math.sqrt(a+d+2*s);return[(a+s)/t,b/t,b/t,(d+s)/t];}
function inv2([a,b,c,d]:number[]){const k=1/(a*d-b*c);return[d*k,-b*k,-c*k,a*k];}
function mul2(a:number[],b:number[]){return[a[0]*b[0]+a[1]*b[2],a[0]*b[1]+a[1]*b[3],a[2]*b[0]+a[3]*b[2],a[2]*b[1]+a[3]*b[3]];}
/** In correct mode, `reference` is the image to be neutralized (the source image when one is loaded). */
export function buildModel(reference:Profile,source:Profile|undefined,settings:Settings):Model {
  const from=settings.mode==='correct'?reference:source||BASELINE,to=settings.mode==='correct'?BASELINE:reference,notes:string[]=[];
  if(!source&&settings.mode==='reference')notes.push('Einzelreferenz: Look-Schätzung gegen eine neutrale Basis. Für einen gezielten Abgleich ein Ausgangsbild ergänzen.');
  const low=from.lowInformation||to.lowInformation;
  if(low)notes.push('Geringer Tonwertumfang: Tonwertabgleich deaktiviert, Palettentransfer reduziert.');
  if(reference.clipped>.03)notes.push((settings.mode==='correct'?'Das korrigierte Bild':'Die Referenz')+' enthält beschnittene Lichter oder sehr tiefe Schatten. Fehlende Details lassen sich nicht rekonstruieren.');
  const x=[0],y=[0];
  if(!low)for(let i=0;i<7;i++){
    const v=clamp(from.quantiles[i],.001,.999);if(v-x[x.length-1]<.003)continue;
    const target=clamp(to.quantiles[i],v-.14,v+.14);
    x.push(v);y.push(Math.max(y[y.length-1],clamp(target,0,1)));
  }
  x.push(1);y.push(1);
  let matrix=mul2(sqrtCov(to.covariance),inv2(sqrtCov(from.covariance)));
  // Bounded matrix norm prevents unreliable covariance extrapolation in unseen colors.
  matrix=matrix.map((v,i)=>i===0||i===3?clamp(v,.7,1.35):clamp(v,-.18,.18));
  if(low)matrix=matrix.map((v,i)=>mix(i===0||i===3?1:0,v,.25));
  const offset=to.mean.map((v,i)=>clamp(v-matrix[i*2]*from.mean[0]-matrix[i*2+1]*from.mean[1],-.045,.045));
  return{curve:makeCurve(x,y),matrix,offset,settings,notes};
}
export function grade(rgb:RGB,model:Model):RGB {
  const {settings:s}=model;
  const looked=s.strength===0?[...rgb] as RGB:lookOf(rgb,model);
  if(!s.brightness&&!s.contrast)return looked;
  return looked.map(v=>contrastCurve(brightnessCurve(v,s.brightness),s.contrast)) as RGB;
}
function lookOf(rgb:RGB,model:Model):RGB {
  const {settings:s}=model;
  const y=luma(rgb),u=rgb[0]-y,v=rgb[2]-y;
  const chromaMix=1-s.skin*skinKey(rgb)*.8;
  const neutralProtection=smooth(.005,.07,Math.hypot(u,v));
  const du=(model.matrix[0]*u+model.matrix[1]*v-u+model.offset[0]*neutralProtection)*chromaMix;
  const dv=(model.matrix[2]*u+model.matrix[3]*v-v+model.offset[1]*neutralProtection)*chromaMix;
  const yy=curveAt(model.curve,y), uu=u+du,vv=v+dv;
  let c:RGB=[yy+uu, yy-(.2126*uu+.0722*vv)/.7152, yy+vv];
  if(s.look)c=applyLook(c,s.look,s.skin);
  const ly=luma(c);
  // Buckswood-inspired chromatic dye density; neutrals remain untouched.
  c=c.map((value,i)=>value*(1-s.density*Math.abs(value-ly)*[.38,.33,.30][i])) as RGB;
  c=c.map(value=>value<=.75?value:.75+(value-.75)/(1+s.rolloff*2*(value-.75))) as RGB;
  return c.map((value,i)=>mix(rgb[i],value,s.strength)) as RGB;
}
export function transform(rgb:RGB,model:Model):RGB {
  const s=model.settings;
  const working=convert(rgb,s.input,'rec709');
  return gamutMap(convert(grade(working,model),'rec709',s.output),s.output);
}
export function makeCube(model:Model):Float32Array {
  const n=model.settings.size,data=new Float32Array(n*n*n*3);let i=0;
  for(let b=0;b<n;b++)for(let g=0;g<n;g++)for(let r=0;r<n;r++){
    const c=transform([r/(n-1),g/(n-1),b/(n-1)],model);data[i++]=c[0];data[i++]=c[1];data[i++]=c[2];
  }
  return data;
}
/** Iridas .cube: red changes fastest. Exactly n^3 finite RGB rows, full-range domain. */
export function serializeCube(data:Float32Array,settings:Settings,name:string,provenance?:{model:string;prompt:string;sources:string[]}):string {
  if(data.length!==settings.size**3*3)throw new Error('Ungültige LUT-Größe.');
  const title=name.replace(/["\r\n\x00-\x1f]/g,' ').slice(0,100).trim()||'Buckswood Look';
  const lines=[`TITLE "${title}"`,'# Buckswood Auto LUT 1.0',`# Input: ${SPACES[settings.input].label}`,`# Output: ${SPACES[settings.output].label}`,'# Range: Full 0-1. Apply once in the declared input/output spaces.','# Recommended interpolation: tetrahedral',`LUT_3D_SIZE ${settings.size}`,'DOMAIN_MIN 0.0 0.0 0.0','DOMAIN_MAX 1.0 1.0 1.0'];
  if(provenance){
    const comment=(value:string)=>value.replace(/[\r\n\x00-\x1f\x7f]/g,' ').slice(0,2000);
    lines.splice(6,0,`# AI interpretation: ${comment(provenance.model)}`,`# Look description: ${comment(provenance.prompt)}`,...provenance.sources.slice(0,10).map(url=>`# Basis: ${comment(url)}`),'# Film references are approximations, not original production LUTs.');
  }
  for(let i=0;i<data.length;i+=3){if(!Number.isFinite(data[i]+data[i+1]+data[i+2]))throw new Error('Nicht endlicher LUT-Wert.');lines.push(`${data[i].toFixed(9)} ${data[i+1].toFixed(9)} ${data[i+2].toFixed(9)}`);}
  return lines.join('\n')+'\n';
}
