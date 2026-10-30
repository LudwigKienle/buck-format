import { imageBuf } from './field';
import { BuckError, LINEAR_SPACES, SPACE_NAMES } from './types';
import type { ColorValue, ImageBuf, RGB, SpaceName } from './types';
/**
 * Color space conversion for the spec §8 names, matching the OCIO ACES studio config
 * studio-config-v2.1.0_aces-v1.3_ocio-v2.3 (base of ofx-native-v1.5_aces-v1.3_ocio-v2.3):
 * - Matrices are derived in float64 from primaries exactly like OCIO's ColorMatrixHelpers.cpp.
 * - Hub is CIE XYZ with D65 white (the config's display reference). ACES spaces reach it through
 *   "UTILITY - ACES-AP0_to_CIE-XYZ-D65_BFD" (Bradford D60→D65), which is also the config's default view
 *   transform "Un-tone-mapped", so scene↔display conversions equal OCIO's. AP1↔AP0 needs no adaptation.
 * - Display spaces are inverted to linearized display light (spec §8 note), not scene-linear light.
 *   sRGB uses the IEC 61966-2-1 piecewise curve (OCIO's continuous moncurve differs by < 1e-6),
 *   Rec.1886 the pure 2.4 power (BT.1886 with Lb = 0).
 * - Negative values keep their sign (mirrored curves, like src/color/spaces.ts). OCIO clamps them for
 *   Rec.1886 and extends the linear segment for sRGB; results only differ for negative input.
 */
type M3=[number,number,number,number,number,number,number,number,number];
type XY=[number,number];
type Transfer='linear'|'srgb'|'bt1886';
type Primaries='rec709'|'ap1'|'ap0';

function inv(m:M3):M3 {
  const [a,b,c,d,e,f,g,h,i]=m,A=e*i-f*h,B=c*h-b*i,C=b*f-c*e,D=f*g-d*i,E=a*i-c*g,F=c*d-a*f,G=d*h-e*g,H=b*g-a*h,I=a*e-b*d;
  const det=a*A+b*D+c*G;return [A/det,B/det,C/det,D/det,E/det,F/det,G/det,H/det,I/det];
}
function mul(p:M3,q:M3):M3 {
  const r=new Array<number>(9);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)r[i*3+j]=p[i*3]*q[j]+p[i*3+1]*q[3+j]+p[i*3+2]*q[6+j];
  return r as M3;
}
const apply=(m:M3,c:RGB):RGB=>[m[0]*c[0]+m[1]*c[1]+m[2]*c[2],m[3]*c[0]+m[4]*c[1]+m[5]*c[2],m[6]*c[0]+m[7]*c[1]+m[8]*c[2]];
const xyToXYZ=(w:XY):RGB=>[w[0]/w[1],1,(1-w[0]-w[1])/w[1]];
/** RGB→XYZ from chromaticities, white normalized to Y = 1 (OCIO rgb2xyz_from_xy). */
function rgbToXyz(r:XY,g:XY,b:XY,w:XY):M3 {
  const P:M3=[r[0],g[0],b[0],r[1],g[1],b[1],1-r[0]-r[1],1-g[0]-g[1],1-b[0]-b[1]],s=apply(inv(P),xyToXYZ(w));
  return P.map((v,k)=>v*s[k%3]) as M3;
}
/** Von Kries adaptation in Bradford cone space (OCIO build_vonkries_adapt, ADAPTATION_BRADFORD). */
function bradford(src:RGB,dst:RGB):M3 {
  const B:M3=[.8951,.2664,-.1614,-.7502,1.7135,.0367,.0389,-.0685,1.0296],s=apply(B,src),d=apply(B,dst);
  return mul(inv(B),mul([d[0]/s[0],0,0,0,d[1]/s[1],0,0,0,d[2]/s[2]],B));
}
// Chromaticities from SMPTE ST 2065-1 (AP0), ACES S-2014-004 (AP1), ITU-R BT.709; ACES white ≈ D60.
const D60:XY=[.32168,.33767],D65:XY=[.3127,.329];
const NATIVE:Record<Primaries,M3>={
  rec709:rgbToXyz([.64,.33],[.3,.6],[.15,.06],D65),
  ap1:rgbToXyz([.713,.293],[.165,.83],[.128,.044],D60),
  ap0:rgbToXyz([.7347,.2653],[0,1],[.0001,-.077],D60),
};
const ACES_TO_D65=bradford(apply(NATIVE.ap0,[1,1,1]),xyToXYZ(D65));
const TO_XYZ:Record<Primaries,M3>={rec709:NATIVE.rec709,ap1:mul(ACES_TO_D65,NATIVE.ap1),ap0:mul(ACES_TO_D65,NATIVE.ap0)};
const FROM_XYZ:Record<Primaries,M3>={rec709:inv(TO_XYZ.rec709),ap1:inv(TO_XYZ.ap1),ap0:inv(TO_XYZ.ap0)};
const SPACES:Record<SpaceName,{primaries:Primaries;transfer:Transfer}>={
  'Rec.1886 Rec.709 - Display':{primaries:'rec709',transfer:'bt1886'},
  'sRGB - Display':{primaries:'rec709',transfer:'srgb'},
  'ACEScg':{primaries:'ap1',transfer:'linear'},
  'ACES2065-1':{primaries:'ap0',transfer:'linear'},
  'lin_rec709_srgb':{primaries:'rec709',transfer:'linear'},
};
// AP1↔AP0 cancels the Bradford step, giving OCIO's unadapted ACEScg_to_ACES2065-1 matrix.
const pairMatrix=(a:Primaries,b:Primaries)=>a===b?undefined:a==='ap1'&&b==='ap0'?mul(inv(NATIVE.ap0),NATIVE.ap1):a==='ap0'&&b==='ap1'?mul(inv(NATIVE.ap1),NATIVE.ap0):mul(FROM_XYZ[b],TO_XYZ[a]);
const MATRICES=new Map<string,M3|undefined>();
for(const a of ['rec709','ap1','ap0'] as const)for(const b of ['rec709','ap1','ap0'] as const)MATRICES.set(a+b,pairMatrix(a,b));

function space(name:SpaceName){
  const s=SPACES[name];if(!s||!(SPACE_NAMES as readonly string[]).includes(name))throw new BuckError(`Unbekannter Farbraum „${String(name)}“.`);
  return s;
}
/** Encoded display value → linear display light. */
function decode(v:number,t:Transfer){
  if(t==='linear')return v;
  const x=v<0?-v:v,y=t==='bt1886'?x**2.4:x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
  return v<0?-y:y;
}
function encode(v:number,t:Transfer){
  if(t==='linear')return v;
  const x=v<0?-v:v,y=t==='bt1886'?x**(1/2.4):x<=.0031308?x*12.92:1.055*x**(1/2.4)-.055;
  return v<0?-y:y;
}
export const isLinearSpace=(name:SpaceName)=>LINEAR_SPACES.includes(name);
export function convertPixel(rgb:RGB,from:SpaceName,to:SpaceName):RGB {
  const f=space(from),t=space(to);
  if(from===to)return [rgb[0],rgb[1],rgb[2]];
  let c:RGB=[decode(rgb[0],f.transfer),decode(rgb[1],f.transfer),decode(rgb[2],f.transfer)];
  const m=MATRICES.get(f.primaries+t.primaries);if(m)c=apply(m,c);
  return [encode(c[0],t.transfer),encode(c[1],t.transfer),encode(c[2],t.transfer)];
}
/** New buffer in `to`; alpha is copied untouched. Same space returns a copy. */
export function convertImage(img:ImageBuf,to:SpaceName):ImageBuf {
  const f=space(img.space),t=space(to),src=img.data,out=imageBuf(img.width,img.height,to),o=out.data;
  if(img.space===to){o.set(src);return out;}
  const m=MATRICES.get(f.primaries+t.primaries),ft=f.transfer,tt=t.transfer;
  for(let i=0;i<src.length;i+=4){
    let r=decode(src[i],ft),g=decode(src[i+1],ft),b=decode(src[i+2],ft);
    if(m){const r0=r,g0=g;r=m[0]*r0+m[1]*g0+m[2]*b;g=m[3]*r0+m[4]*g0+m[5]*b;b=m[6]*r0+m[7]*g0+m[8]*b;}
    o[i]=encode(r,tt);o[i+1]=encode(g,tt);o[i+2]=encode(b,tt);o[i+3]=src[i+3];
  }
  return out;
}
/**
 * Luminance weights: Y row of the space's own RGB→XYZ matrix (ACES CTL AP1_RGB2Y for ACEScg, equal to LUMA in
 * field.ts), exact derived values instead of the rounded BT.709 constants. Display spaces return the Rec.709
 * weights, valid only for linearized values.
 */
export function lumaWeights(name:SpaceName):RGB {
  const m=NATIVE[space(name).primaries];return [m[3],m[4],m[5]];
}
/**
 * CIE 1931 2° chromaticity of the Planckian locus as XYZ with Y = 1, using the cubic spline of Kim et al.
 * (US 7024034; Kang et al., J. Korean Phys. Soc. 41(6), 2002). Valid 1667–25000 K, input is clamped to that range.
 */
export function kelvinToXYZ(kelvin:number):RGB {
  if(typeof kelvin!=='number'||!Number.isFinite(kelvin))throw new BuckError('Farbtemperatur muss eine endliche Zahl in Kelvin sein.');
  const T=Math.min(25000,Math.max(1667,kelvin)),a=1e9/T**3,b=1e6/T**2,c=1e3/T;
  const x=T<=4000?-.2661239*a-.2343589*b+.8776956*c+.17991:-3.0258469*a+2.1070379*b+.2226347*c+.24039;
  const y=T<=2222?-1.1063814*x**3-1.3481102*x**2+2.18555832*x-.20219683
    :T<=4000?-.9549476*x**3-1.37418593*x**2+2.09137015*x-.16748867
    :3.081758*x**3-5.8733867*x**2+3.75112997*x-.37001483;
  return [x/y,1,(1-x-y)/y];
}
/**
 * ColorValue in `name`: RGB is returned unchanged (as a copy). Kelvin XYZ is taken as the config's CIE-XYZ-D65
 * reference (no adaptation, so a temperature has the same chromaticity in every space), normalized to luminance 1
 * with the target's lumaWeights and, for display spaces, encoded with the display curve. ACES luma weights are
 * unadapted (D60), so the absolute scale differs from Rec.709 by < 0.2 % for the same temperature.
 */
export function colorValueToRGB(c:ColorValue,name:SpaceName):RGB {
  const s=space(name);
  if(Array.isArray(c))return [c[0],c[1],c[2]];
  if(!c||typeof c!=='object'||!('kelvin' in c))throw new BuckError('Farbwert muss [R, G, B] oder {"kelvin": K} sein.');
  const lin=apply(FROM_XYZ[s.primaries],kelvinToXYZ(c.kelvin)),w=lumaWeights(name),y=w[0]*lin[0]+w[1]*lin[1]+w[2]*lin[2];
  return lin.map(v=>encode(v/y,s.transfer)) as RGB;
}
const to8=(v:number)=>v>0?(v<1?Math.round(v*255):255):0; // NaN and negatives → 0
/** RGBA8 preview in sRGB - Display. Out-of-gamut values are clamped per channel (hue may shift), no gamut mapping. */
export function toSRGB8(img:ImageBuf):Uint8ClampedArray {
  const s=convertImage(img,'sRGB - Display').data,out=new Uint8ClampedArray(s.length);
  for(let i=0;i<s.length;i++)out[i]=to8(s[i]);
  return out;
}
/** `#rrggbb` or `#rgb` (sRGB - Display encoded) as RGB in `name`: linear for linear spaces, encoded for display spaces. */
export function srgbHexToLinear(hex:string,name:SpaceName):RGB {
  const m=/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if(!m)throw new BuckError(`Ungültiger Farbwert „${hex}“, erwartet wird #rrggbb.`);
  const h=m[1].length===3?[...m[1]].map(d=>d+d).join(''):m[1];
  const rgb:RGB=[0,1,2].map(i=>parseInt(h.slice(i*2,i*2+2),16)/255) as RGB;
  return convertPixel(rgb,'sRGB - Display',name);
}
/** Inverse of srgbHexToLinear for 8-bit values; out-of-gamut channels are clamped. */
export function linearToSrgbHex(rgb:RGB,name:SpaceName):string {
  return '#'+convertPixel(rgb,name,'sRGB - Display').map(v=>to8(v).toString(16).padStart(2,'0')).join('');
}
