export type RGB = [number, number, number];
export type SpaceId = 'rec709' | 'srgb' | 'p3' | 'rec2020' | 'linear709';
type Matrix = [number, number, number, number, number, number, number, number, number];
const REC709: Matrix = [0.4123907993,0.3575843394,0.1804807884,0.2126390059,0.7151686788,0.0721923154,0.0193308187,0.1191947798,0.9505321522];
const P3: Matrix = [0.4865709486,0.2656676932,0.1982172852,0.2289745641,0.6917385218,0.0792869141,0,0.0451133819,1.0439443689];
const REC2020: Matrix = [0.6369580483,0.1446169036,0.1688809752,0.2627002120,0.6779980715,0.0593017165,0,0.0280726930,1.0609850577];
export const SPACES: Record<SpaceId, {label:string; matrix:Matrix; transfer:'srgb'|'gamma24'|'linear'}> = {
  rec709: {label:'Rec.709 / Gamma 2.4', matrix:REC709, transfer:'gamma24'},
  srgb: {label:'sRGB', matrix:REC709, transfer:'srgb'},
  p3: {label:'Display P3 / sRGB-Kurve', matrix:P3, transfer:'srgb'},
  rec2020: {label:'Rec.2020 / Gamma 2.4 · SDR', matrix:REC2020, transfer:'gamma24'},
  linear709: {label:'Rec.709 / Linear', matrix:REC709, transfer:'linear'},
};
export const clamp = (x:number, lo=0, hi=1) => Math.min(hi, Math.max(lo,x));
export const mix = (a:number,b:number,t:number) => a+(b-a)*t;
export const luma = (c:RGB) => .2126*c[0]+.7152*c[1]+.0722*c[2];
export function smooth(a:number,b:number,x:number){const t=clamp((x-a)/(b-a));return t*t*(3-2*t);}
export function mul(m:Matrix,c:RGB):RGB {return [m[0]*c[0]+m[1]*c[1]+m[2]*c[2],m[3]*c[0]+m[4]*c[1]+m[5]*c[2],m[6]*c[0]+m[7]*c[1]+m[8]*c[2]];}
function inverse(m:Matrix):Matrix {
  const [a,b,c,d,e,f,g,h,i]=m, A=e*i-f*h,B=c*h-b*i,C=b*f-c*e,D=f*g-d*i,E=a*i-c*g,F=c*d-a*f,G=d*h-e*g,H=b*g-a*h,I=a*e-b*d;
  const det=a*A+b*D+c*G;return [A,B,C,D,E,F,G,H,I].map(x=>x/det) as Matrix;
}
const inverses=Object.fromEntries(Object.entries(SPACES).map(([k,v])=>[k,inverse(v.matrix)])) as Record<SpaceId,Matrix>;
export function decode(v:number,id:SpaceId){
  const x=Math.abs(v),s=Math.sign(v),t=SPACES[id].transfer;
  return s*(t==='linear'?x:t==='gamma24'?x**2.4:x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
}
export function encode(v:number,id:SpaceId){
  const x=Math.abs(v),s=Math.sign(v),t=SPACES[id].transfer;
  return s*(t==='linear'?x:t==='gamma24'?x**(1/2.4):x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055);
}
/** D65-to-D65 matrix conversion. Range mapping is an explicit separate stage. */
export function convert(c:RGB,from:SpaceId,to:SpaceId):RGB {
  if(from===to)return [...c];
  const lin=c.map(v=>decode(v,from)) as RGB;
  return mul(inverses[to],mul(SPACES[from].matrix,lin)).map(v=>encode(v,to)) as RGB;
}
/** Hue-direction preserving compression toward the neutral axis in linear RGB. */
export function gamutMap(c:RGB,id:SpaceId):RGB {
  const lin=c.map(v=>decode(v,id)) as RGB;
  const weights=SPACES[id].matrix.slice(3,6);
  const y=clamp(lin.reduce((sum,v,i)=>sum+v*weights[i],0));
  let scale=1;
  for(const v of lin){const d=v-y;if(d>0)scale=Math.min(scale,(1-y)/d);else if(d<0)scale=Math.min(scale,-y/d);}
  return lin.map(v=>encode(clamp(y+(v-y)*scale),id)) as RGB;
}
