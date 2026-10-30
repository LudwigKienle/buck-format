import { describe,expect,it,vi } from 'vitest';
import { fogNode,fogTransmittance } from '../src/buck/nodes/fog';
import { imageBuf,scalarField } from '../src/buck/field';
import { BuckError,LINEAR_SPACES } from '../src/buck/types';
import type { ColorValue,FogParams,ImageBuf,RenderContext,Resolved,RGB,SpaceName } from '../src/buck/types';
// Deterministic fake of the colorspace module so these tests do not depend on its math (it may not exist yet).
const {KELVIN_FAKE}=vi.hoisted(()=>({KELVIN_FAKE:[1.3,1,.6] as RGB}));
vi.mock('../src/buck/colorspace',()=>({
  isLinearSpace:(s:SpaceName)=>LINEAR_SPACES.includes(s),
  colorValueToRGB:(c:ColorValue,space:SpaceName)=>Array.isArray(c)?[...c]:space==='ACEScg'&&c.kelvin===3200?[...KELVIN_FAKE]:[NaN,NaN,NaN],
  convertPixel:(rgb:RGB,from:SpaceName,to:SpaceName)=>from===to?[...rgb]:from==='ACEScg'&&to==='lin_rec709_srgb'?[rgb[0]*2,rgb[1]*3,rgb[2]*4]:[NaN,NaN,NaN],
}));
type P=Resolved<FogParams>;
const base:P={model:'exponential',start:0,density:2,color:[1,1,1],luminance:0,maxOpacity:1,skyProtect:0};
const ctx:RenderContext={width:0,height:0,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}};
/** One row of pixels, each with the same RGBA and its own depth. */
function run(depths:number[],p:Partial<P>={},rgba=[.5,.25,.1,.7],space:SpaceName='ACEScg'){
  const n=depths.length,img=imageBuf(n,1,space);for(let i=0;i<n;i++)img.data.set(rgba,i*4);
  return fogNode.evaluate({image:img,depth:scalarField(n,1,Float32Array.from(depths))},{...base,...p},ctx) as ImageBuf;
}
const px=(o:ImageBuf,i:number)=>Array.from(o.data.subarray(i*4,i*4+4));
const f32=(x:number)=>Math.fround(x);
describe('atmos.fog@1 reference math',()=>{
  it('leaves the image untouched at zero depth and without density',()=>{
    expect(px(run([0]),0)).toEqual([.5,.25,.1,.7].map(f32));
    expect(px(run([.3,.9],{density:0}),1)).toEqual([.5,.25,.1,.7].map(f32));
  });
  it('matches the exponential formula exactly and reaches full fog color at large depth',()=>{
    const o=run([.4,50],{color:[.8,.6,.4],luminance:1}),t=Math.exp(-2*.4),c=[.8,.6,.4].map(v=>v*.18*2);
    [.5,.25,.1].forEach((v,k)=>expect(o.data[k]).toBe(f32(v*t+c[k]*(1-t))));
    expect(px(o,1).slice(0,3)).toEqual(c.map(f32));
  });
  it('matches the linear model with default end = 1 and an explicit end',()=>{
    expect(fogTransmittance(.25,{...base,model:'linear',start:0})).toBeCloseTo(.75,12);
    expect(fogTransmittance(.6,{...base,model:'linear',start:.2,end:.6})).toBe(0);
    expect(fogTransmittance(.3,{...base,model:'linear',start:.2,end:.6})).toBeCloseTo(.75,12);
    expect(fogTransmittance(.2,{...base,model:'linear',start:.2,end:.2})).toBe(1);
    expect(fogTransmittance(.21,{...base,model:'linear',start:.2,end:.2})).toBe(0);
  });
  it('is monotone in depth for both models',()=>{
    const depths=Array.from({length:101},(_,i)=>i/100*1.5);
    for(const model of ['exponential','linear'] as const){
      const o=run(depths,{model,start:.1,color:[0,0,0]});let prev=Infinity;
      for(let i=0;i<depths.length;i++){const r=o.data[i*4];expect(r).toBeLessThanOrEqual(prev);prev=r;}
      expect(o.data[0]).toBe(f32(.5));expect(o.data[100*4]).toBeLessThan(.5);
    }
  });
  it('applies no fog before start',()=>{
    const o=run([0,.29,.3,.31],{start:.3});
    expect(px(o,0)).toEqual(px(o,1));expect(px(o,2)).toEqual(px(o,0));expect(o.data[3*4]).not.toBe(o.data[0]);
    expect(fogTransmittance(.5,{...base,start:.3})).toBeCloseTo(Math.exp(-2*.2),12);
  });
  it('limits the opacity at infinity with maxOpacity',()=>{
    const o=run([1e6],{maxOpacity:.6,color:[1,1,1],luminance:0});
    expect(o.data[0]).toBe(f32(.5*.4+.18*.6));
    const mid=run([.5],{maxOpacity:.6}),t=1-.6*(1-Math.exp(-1));expect(mid.data[1]).toBe(f32(.25*t+.18*(1-t)));
    expect(px(run([5],{maxOpacity:0}),0)).toEqual([.5,.25,.1,.7].map(f32));
  });
  it('treats +Inf and NaN depth as infinitely far and holds it back with skyProtect',()=>{
    const p={maxOpacity:.8,skyProtect:.25},o=run([Infinity,NaN,-Infinity,1e9],p);
    const tSky=(1-.8)+.25*.8;
    expect(o.data[0]).toBe(f32(.5*tSky+.18*(1-tSky)));expect(px(o,1)).toEqual(px(o,0));expect(px(o,2)).toEqual(px(o,0));
    expect(o.data[3*4]).toBe(f32(.5*.2+.18*.8));
    expect(px(run([Infinity],{skyProtect:1}),0)).toEqual([.5,.25,.1,.7].map(f32));
    expect(px(run([Infinity],{skyProtect:1,density:0}),0)).toEqual([.5,.25,.1,.7].map(f32));
    expect(Array.from(run([Infinity,NaN],{density:0,model:'exponential'}).data).every(Number.isFinite)).toBe(true);
  });
  it('passes alpha through untouched',()=>{
    const o=run([0,.5,Infinity],{},[.2,.2,.2,.123]);for(let i=0;i<3;i++)expect(o.data[i*4+3]).toBe(f32(.123));
  });
  it('resolves a Kelvin color in the working space and converts it into the image space when they differ',()=>{
    const p={color:{kelvin:3200},luminance:0},far=1e6;
    expect(px(run([far],p),0).slice(0,3)).toEqual(KELVIN_FAKE.map(v=>f32(v*.18)));
    const o=run([far],p,[.5,.25,.1,1],'lin_rec709_srgb');
    expect(o.space).toBe('lin_rec709_srgb');
    expect(px(o,0).slice(0,3)).toEqual([KELVIN_FAKE[0]*2,KELVIN_FAKE[1]*3,KELVIN_FAKE[2]*4].map(v=>f32(v*.18)));
  });
  it('rejects display-referred input and missing or mismatched inputs with German errors',()=>{
    expect(()=>run([.5],{},undefined,'Rec.1886 Rec.709 - Display')).toThrow(BuckError);
    expect(()=>run([.5],{},undefined,'sRGB - Display')).toThrow(/linearen Farbraum/);
    expect(()=>fogNode.evaluate({image:imageBuf(1,1,'ACEScg')},base,ctx)).toThrow(/Tiefeneingang/);
    expect(()=>fogNode.evaluate({image:imageBuf(2,1,'ACEScg'),depth:scalarField(1,1)},base,ctx)).toThrow(/passt nicht/);
    expect(()=>fogNode.evaluate({depth:scalarField(1,1)},base,ctx)).toThrow(/Bildeingang/);
  });
  it('is deterministic and does not modify its inputs',()=>{
    const img=imageBuf(3,2,'ACEScg',Float32Array.from({length:24},(_,i)=>i/24)),depth=scalarField(3,2,Float32Array.from([0,.2,.4,.6,Infinity,2]));
    const before=Array.from(img.data),p={...base,start:.1,maxOpacity:.9,skyProtect:.4,luminance:.5};
    const a=fogNode.evaluate({image:img,depth},p,ctx) as ImageBuf,b=fogNode.evaluate({image:img,depth},p,ctx) as ImageBuf;
    expect(Array.from(a.data)).toEqual(Array.from(b.data));expect(Array.from(img.data)).toEqual(before);expect(a.data).not.toBe(img.data);
  });
});
