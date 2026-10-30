import { describe, expect, it } from 'vitest';
import { colorValueToRGB, convertImage, convertPixel, isLinearSpace, kelvinToXYZ, linearToSrgbHex, lumaWeights, srgbHexToLinear, toSRGB8 } from '../src/buck/colorspace';
import { LUMA, imageBuf } from '../src/buck/field';
import { BuckError, SPACE_NAMES } from '../src/buck/types';
import type { RGB, SpaceName } from '../src/buck/types';

const maxDiff=(a:ArrayLike<number>,b:ArrayLike<number>)=>{let m=0;for(let i=0;i<a.length;i++)m=Math.max(m,Math.abs(a[i]-b[i]));return m;};
const column=(from:SpaceName,to:SpaceName,i:number)=>convertPixel([0,1,2].map(k=>k===i?1:0) as RGB,from,to);
const matrixOf=(from:SpaceName,to:SpaceName)=>{const c=[0,1,2].map(i=>column(from,to,i));return [0,1,2].flatMap(r=>c.map(col=>col[r]));};
const xy=(xyz:RGB)=>{const s=xyz[0]+xyz[1]+xyz[2];return [xyz[0]/s,xyz[1]/s];};
const srgbEncode=(x:number)=>x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055;

describe('buck colorspace matrices', () => {
  it('matches the hard-coded AP0 → Linear Rec.709 matrix of the OCIO studio config v2.1.0', () => {
    const ocio=[2.52168618674388,-1.13413098823972,-0.387555198504164,-0.276479914229922,1.37271908766826,-0.096239173438334,-0.0153780649660342,-0.152975335867399,1.16835340083343];
    expect(maxDiff(matrixOf('ACES2065-1','lin_rec709_srgb'),ocio)).toBeLessThan(1e-12);
  });
  it('matches the ACES CTL AP0 → AP1 matrix (ACEScsc, no adaptation)', () => {
    const ctl=[1.4514393161,-0.2365107469,-0.2149285693,-0.0765537734,1.1762296998,-0.0996759264,0.0083161484,-0.0060324498,0.9977163014];
    expect(maxDiff(matrixOf('ACES2065-1','ACEScg'),ctl)).toBeLessThan(1e-9);
  });
  it('maps sRGB red into ACEScg like the Bradford literature value', () => {
    // colour-science sRGB → ACEScg (Bradford), first column rounded to 4 digits.
    expect(maxDiff(convertPixel([1,0,0],'lin_rec709_srgb','ACEScg'),[.6131,.0702,.0206])).toBeLessThan(1e-4);
    expect(maxDiff(convertPixel([1,0,0],'sRGB - Display','ACEScg'),[.6131,.0702,.0206])).toBeLessThan(1e-4);
  });
  it('keeps D65 white white in every space (Bradford D65 ↔ ACES white)', () => {
    for(const from of SPACE_NAMES)for(const to of SPACE_NAMES)expect(maxDiff(convertPixel([1,1,1],from,to),[1,1,1])).toBeLessThan(1e-12);
    expect(maxDiff(convertPixel([.18,.18,.18],'lin_rec709_srgb','ACEScg'),[.18,.18,.18])).toBeLessThan(1e-12);
  });
  it('round-trips every pair below 1e-6, including negatives and values above 1', () => {
    const samples:RGB[]=[[0,0,0],[1,0,0],[0,1,0],[0,0,1],[.18,.5,.9],[-.2,.03,1.7],[2.5,-.01,.002],[.0005,.04,.0031]];
    for(const a of SPACE_NAMES)for(const b of SPACE_NAMES)for(const s of samples)expect(maxDiff(convertPixel(convertPixel(s,a,b),b,a),s)).toBeLessThan(1e-6);
  });
  it('rejects unknown space names with a German error', () => {
    expect(()=>convertPixel([0,0,0],'Linear P3' as SpaceName,'ACEScg')).toThrow(BuckError);
    expect(()=>convertPixel([0,0,0],'ACEScg','constructor' as SpaceName)).toThrow(/Unbekannter Farbraum/);
  });
});

describe('buck colorspace transfer curves', () => {
  it('decodes sRGB - Display with the IEC 61966-2-1 piecewise curve', () => {
    expect(convertPixel([.5,.04,1],'sRGB - Display','lin_rec709_srgb')).toEqual([((.5+.055)/1.055)**2.4,.04/12.92,1]);
    expect(convertPixel([.214041140482232,0,0],'lin_rec709_srgb','sRGB - Display')[0]).toBeCloseTo(.5,12);
  });
  it('decodes Rec.1886 as a pure 2.4 power (Lb = 0)', () => {
    expect(convertPixel([.5,0,1],'Rec.1886 Rec.709 - Display','lin_rec709_srgb')).toEqual([.5**2.4,0,1]);
    const r=convertPixel([.5,.5,.5],'Rec.1886 Rec.709 - Display','sRGB - Display');
    expect(r[0]).toBeCloseTo(srgbEncode(.5**2.4),12);
  });
  it('preserves the sign of negative values', () => {
    expect(convertPixel([-.5,-.02,0],'sRGB - Display','lin_rec709_srgb')).toEqual([-(((.5+.055)/1.055)**2.4),-.02/12.92,0]);
    expect(convertPixel([-.25,0,0],'lin_rec709_srgb','Rec.1886 Rec.709 - Display')[0]).toBeCloseTo(-(.25**(1/2.4)),12);
  });
});

describe('buck colorspace helpers', () => {
  it('reports linear spaces', () => {
    expect(SPACE_NAMES.filter(isLinearSpace)).toEqual(['ACEScg','ACES2065-1','lin_rec709_srgb']);
  });
  it('derives luma weights consistent with field.ts and BT.709', () => {
    expect(maxDiff(lumaWeights('ACEScg'),LUMA.ap1)).toBeLessThan(1e-9);
    expect(maxDiff(lumaWeights('ACES2065-1'),LUMA.ap0)).toBeLessThan(1e-9);
    expect(maxDiff(lumaWeights('lin_rec709_srgb'),LUMA.rec709)).toBeLessThan(1e-4);
    expect(lumaWeights('sRGB - Display')).toEqual(lumaWeights('lin_rec709_srgb'));
    for(const s of SPACE_NAMES)expect(lumaWeights(s).reduce((a,b)=>a+b,0)).toBeCloseTo(1,12);
  });
  it('converts images, copies alpha and returns new buffers', () => {
    const img=imageBuf(2,1,'sRGB - Display',new Float32Array([.5,.25,1,.3, 0,1,-.1,1]));
    const out=convertImage(img,'ACEScg');
    expect(out).toMatchObject({kind:'image',width:2,height:1,space:'ACEScg'});
    expect(out.data).not.toBe(img.data);
    expect([out.data[3],out.data[7]]).toEqual([Math.fround(.3),1]);
    const px=convertPixel([.5,.25,1],'sRGB - Display','ACEScg');
    expect(maxDiff(out.data.subarray(0,3),px)).toBeLessThan(1e-6);
    const back=convertImage(out,'sRGB - Display');
    expect(maxDiff(back.data,img.data)).toBeLessThan(2e-6);
    const same=convertImage(img,'sRGB - Display');
    expect(same.data).not.toBe(img.data);
    expect(Array.from(same.data)).toEqual(Array.from(img.data));
    expect(Array.from(convertImage(img,'ACEScg').data)).toEqual(Array.from(out.data));
  });
});

describe('buck colorspace kelvin', () => {
  it('returns XYZ with Y = 1', () => {
    for(const k of [1667,2222,3200,4000,5600,6504,10000,25000])expect(kelvinToXYZ(k)[1]).toBe(1);
  });
  it('lands near D65 at 6504 K (D65 lies slightly above the Planck locus)', () => {
    const [x,y]=xy(kelvinToXYZ(6504));
    expect(Math.abs(x-.3127)).toBeLessThan(.002);
    expect(Math.abs(y-.329)).toBeLessThan(.007);
  });
  it('matches CIE illuminant A (Planck at 2848 K with today\'s c2)', () => {
    const [x,y]=xy(kelvinToXYZ(2848));
    expect(Math.abs(x-.44757)).toBeLessThan(5e-4);
    expect(Math.abs(y-.40745)).toBeLessThan(5e-4);
  });
  it('is nearly continuous at the spline joints and clamps the valid range', () => {
    for(const k of [2222,4000]){const a=xy(kelvinToXYZ(k-1e-6)),b=xy(kelvinToXYZ(k+1e-6));expect(maxDiff(a,b)).toBeLessThan(2e-4);}
    expect(kelvinToXYZ(1000)).toEqual(kelvinToXYZ(1667));
    expect(kelvinToXYZ(40000)).toEqual(kelvinToXYZ(25000));
    expect(()=>kelvinToXYZ(Number.NaN)).toThrow(BuckError);
  });
  it('gets bluer with rising temperature', () => {
    let prev=1;for(const k of [2000,3000,4500,6500,9000,15000]){const x=xy(kelvinToXYZ(k))[0];expect(x).toBeLessThan(prev);prev=x;}
  });
});

describe('buck colorspace colorValueToRGB', () => {
  it('passes RGB through unchanged as a copy', () => {
    const c:RGB=[.2,-.1,3];const r=colorValueToRGB(c,'ACEScg');
    expect(r).toEqual(c);expect(r).not.toBe(c);
  });
  it('turns 3200 K into a warm color with luminance 1', () => {
    for(const s of ['ACEScg','ACES2065-1','lin_rec709_srgb'] as const){
      const c=colorValueToRGB({kelvin:3200},s),w=lumaWeights(s);
      expect(c[0]).toBeGreaterThan(c[2]);
      expect(w[0]*c[0]+w[1]*c[1]+w[2]*c[2]).toBeCloseTo(1,12);
    }
  });
  it('is the same chromaticity in every space and close to neutral at 6504 K', () => {
    // Each space normalizes with its own luma weights, so only the scale may differ (AP1 Y row vs Bradford-adapted Y).
    const a=convertPixel(colorValueToRGB({kelvin:5600},'ACEScg'),'ACEScg','lin_rec709_srgb'),b=colorValueToRGB({kelvin:5600},'lin_rec709_srgb');
    const w=lumaWeights('lin_rec709_srgb'),ya=w[0]*a[0]+w[1]*a[1]+w[2]*a[2];
    expect(maxDiff(a.map(v=>v/ya),b)).toBeLessThan(1e-12);
    expect(Math.abs(ya-1)).toBeLessThan(2e-3);
    for(const v of colorValueToRGB({kelvin:6504},'lin_rec709_srgb'))expect(Math.abs(v-1)).toBeLessThan(.06);
  });
  it('encodes for display spaces', () => {
    const lin=colorValueToRGB({kelvin:3200},'lin_rec709_srgb'),d=colorValueToRGB({kelvin:3200},'sRGB - Display');
    expect(maxDiff(d,lin.map(srgbEncode))).toBeLessThan(1e-12);
  });
  it('rejects malformed color values', () => {
    expect(()=>colorValueToRGB({} as never,'ACEScg')).toThrow(BuckError);
    expect(()=>colorValueToRGB({kelvin:Number.POSITIVE_INFINITY},'ACEScg')).toThrow(/Kelvin/);
  });
});

describe('buck colorspace preview and hex', () => {
  it('clamps, rounds and scales alpha in toSRGB8', () => {
    const img=imageBuf(4,1,'lin_rec709_srgb',new Float32Array([1,.5,0,1, -1,2,Number.NaN,.5, .2,0,0,0, .0031308,0,0,2]));
    expect(Array.from(toSRGB8(img))).toEqual([255,188,0,255, 0,255,0,128, 124,0,0,0, 10,0,0,255]);
    expect(Array.from(toSRGB8(imageBuf(1,1,'ACEScg',new Float32Array([1,1,1,1]))))).toEqual([255,255,255,255]);
  });
  it('parses hex colors in sRGB - Display', () => {
    expect(srgbHexToLinear('#ffffff','lin_rec709_srgb')).toEqual([1,1,1]);
    expect(srgbHexToLinear('fff','ACEScg').every(v=>Math.abs(v-1)<1e-12)).toBe(true);
    expect(srgbHexToLinear('#808080','lin_rec709_srgb')[0]).toBeCloseTo(((128/255+.055)/1.055)**2.4,12);
    expect(srgbHexToLinear('#FF0000','sRGB - Display')).toEqual([1,0,0]);
    expect(()=>srgbHexToLinear('#12345','ACEScg')).toThrow(/Ungültiger Farbwert/);
  });
  it('round-trips every 8-bit hex value through linear spaces', () => {
    for(const s of SPACE_NAMES)for(let v=0;v<256;v+=5){
      const hex='#'+[v,255-v,(v*7)%256].map(n=>n.toString(16).padStart(2,'0')).join('');
      expect(linearToSrgbHex(srgbHexToLinear(hex,s),s)).toBe(hex);
    }
  });
  it('clamps out-of-gamut values when writing hex', () => {
    expect(linearToSrgbHex([2,-1,.5],'lin_rec709_srgb')).toBe('#ff00bc');
  });
});
