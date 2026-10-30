import { describe, expect, it, vi } from 'vitest';
import { LINEAR_SPACES } from '../src/buck/types';
import type { ColorValue, ImageBuf, RelightParams, RenderContext, Resolved, RGB, ScalarField, SpaceName, VectorField } from '../src/buck/types';

// colorspace.ts belongs to another agent; a deterministic fake keeps these tests independent of it.
const convertPixel=vi.fn((rgb:RGB)=>rgb.map(v=>v*2) as RGB);
vi.mock('../src/buck/colorspace',()=>({
  isLinearSpace:(s:SpaceName)=>LINEAR_SPACES.includes(s),
  lumaWeights:(s:SpaceName):RGB=>s==='ACEScg'?[.2722287168,.6740817658,.0536895174]:[.2126,.7152,.0722],
  colorValueToRGB:(c:ColorValue)=>{if(Array.isArray(c))return [...c];throw new Error('kelvin not faked');},
  convertPixel:(rgb:RGB)=>convertPixel(rgb),
}));
const { lightVector, relightNode } = await import('../src/buck/nodes/relight');
const { normalsFromDepth, NORMALS_DEPTH_SCALE } = await import('../src/buck/aux/normals');

const W=32,H=16;
const ctx=(workingLinear:SpaceName='lin_rec709_srgb'):RenderContext=>({width:W,height:H,frame:0,aux:{masks:{}},files:new Map(),workingLinear,warn:()=>{}});
const gray=(v=.18,space:SpaceName='lin_rec709_srgb'):ImageBuf=>{const d=new Float32Array(W*H*4);for(let i=0;i<W*H;i++)d.set([v,v,v,1],i*4);return {kind:'image',width:W,height:H,data:d,space};};
const normalsOf=(f:(x:number,y:number)=>RGB):VectorField=>{
  const d=new Float32Array(W*H*3);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const n=f(x,y),l=Math.hypot(...n)||1;d.set(n.map(v=>v/l),(y*W+x)*3);}
  return {kind:'vector3',width:W,height:H,data:d};
};
const depthOf=(f:(x:number,y:number)=>number):ScalarField=>{const d=new Float32Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)d[y*W+x]=f(x,y);return {kind:'scalar',width:W,height:H,data:d};};
const params=(p:Partial<Resolved<RelightParams>>={}):Resolved<RelightParams>=>({azimuth:-90,elevation:0,color:[1,1,1],intensity:1,softness:0,mode:'add',preserveHighlights:0,...p});
const px=(img:ImageBuf,x:number,y:number)=>Array.from(img.data.subarray((y*W+x)*4,(y*W+x)*4+4));
// Left half faces left, right half faces right (both tilted 45° toward the camera).
const split=normalsOf(x=>x<W/2?[-1,0,1]:[1,0,1]);
const run=(img:ImageBuf,n:VectorField,p=params(),c=ctx())=>relightNode.evaluate({image:img,normals:n},p,c) as ImageBuf;

describe('lightVector', () => {
  it('follows the azimuth/elevation convention of §5.3.3', () => {
    const close=(a:RGB,b:RGB)=>a.forEach((v,i)=>expect(v).toBeCloseTo(b[i],12));
    close(lightVector(0,0),[0,0,1]);
    close(lightVector(-90,0),[-1,0,0]);
    close(lightVector(90,0),[1,0,0]);
    close(lightVector(180,0),[0,0,-1]);
    close(lightVector(0,90),[0,1,0]);
    close(lightVector(-90,30),[-Math.cos(Math.PI/6),.5,0]);
  });
});

describe('normals-from-depth@1', () => {
  it('gives (0,0,1) for a fronto-parallel plane', () => {
    const n=normalsFromDepth(depthOf(()=>.4),.002);
    for(let i=0;i<W*H;i++){expect(n.data[i*3]).toBeCloseTo(0,6);expect(n.data[i*3+1]).toBeCloseTo(0,6);expect(n.data[i*3+2]).toBeCloseTo(1,6);}
  });
  it('tilts a ramp receding to the right toward +X with slope k·∂d/∂x', () => {
    const a=.5,n=normalsFromDepth(depthOf(x=>a*(x+.5)/W),0),s=NORMALS_DEPTH_SCALE*a,l=Math.hypot(s,1);
    for(const [x,y] of [[0,0],[5,3],[W-1,H-1]]){
      const j=(y*W+x)*3;
      expect(n.data[j]).toBeCloseTo(s/l,5);expect(n.data[j+1]).toBeCloseTo(0,6);expect(n.data[j+2]).toBeCloseTo(1/l,5);
    }
  });
  it('maps image y (down) to camera +Y (up): depth growing downwards faces down, growing upwards faces up', () => {
    const down=normalsFromDepth(depthOf((_,y)=>.3*(y+.5)/W),0),up=normalsFromDepth(depthOf((_,y)=>.3*(H-y)/W),0),j=(8*W+10)*3;
    expect(down.data[j+1]).toBeLessThan(-.5);expect(up.data[j+1]).toBeGreaterThan(.5);
    expect(down.data[j]).toBeCloseTo(0,6);expect(down.data[j+2]).toBeGreaterThan(0);
  });
  it('is unit length, zero for invalid depth and one-sided next to it', () => {
    const n=normalsFromDepth(depthOf((x,y)=>x>=20?Infinity:y===0&&x===3?NaN:.2*(x+.5)/W),.03);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const j=(y*W+x)*3,l=Math.hypot(n.data[j],n.data[j+1],n.data[j+2]);
      if(x>=20||(y===0&&x===3))expect(l).toBe(0);else{expect(l).toBeCloseTo(1,5);expect(Number.isFinite(n.data[j])).toBe(true);}
    }
    // Right next to the sky the ramp slope survives instead of exploding.
    const j=(8*W+19)*3;expect(n.data[j]).toBeGreaterThan(0);expect(n.data[j]).toBeLessThan(.99);
  });
  it('is deterministic', () => {
    const d=depthOf((x,y)=>Math.sin(x*.7)*.1+y*.02+.3);
    expect(Array.from(normalsFromDepth(d,.01).data)).toEqual(Array.from(normalsFromDepth(d,.01).data));
  });
});

describe('light.relight@1', () => {
  it('adds albedo·color·(2^EV−1)·0.18·lambert where the normal faces the light', () => {
    const out=run(gray(),normalsOf(()=>[-1,0,0]));
    // Uniform 18 % grey: albedo = 1, lambert = 1 → 0.18 + 0.18.
    expect(px(out,5,5)[0]).toBeCloseTo(.36,6);expect(px(out,5,5)[3]).toBe(1);
  });
  it('light from the left brightens left-facing surfaces and leaves the back side untouched without wrap', () => {
    const src=gray(),out=run(src,split);
    expect(px(out,4,8)[1]).toBeGreaterThan(.18*1.5);
    expect(px(out,4,8)[1]).toBeCloseTo(.18+.18*Math.SQRT1_2,5);
    expect(px(out,W-4,8)).toEqual(px(src,W-4,8));
  });
  it('wrap (softness) opens the terminator', () => {
    const out=run(gray(),split,params({softness:1}));
    // (n·L + w)/(1 + w) with n·L = −√½ and w = 1.
    expect(px(out,W-4,8)[0]).toBeCloseTo(.18+.18*(1-Math.SQRT1_2)/2,4);
    expect(px(out,4,8)[0]).toBeGreaterThan(px(out,W-4,8)[0]);
  });
  it('intensity 0 is the identity', () => {
    const src=gray();src.data[17]=.9;src.data[40]=2.5;
    const out=run(src,split,params({intensity:0,softness:.6,preserveHighlights:.7}));
    expect(Array.from(out.data)).toEqual(Array.from(src.data));expect(out.data).not.toBe(src.data);
  });
  it('zero normals have no effect, even with wrap', () => {
    const n=normalsOf(x=>x<W/2?[0,0,0]:[0,0,1]),src=gray(),out=run(src,n,params({softness:1,azimuth:0}));
    expect(px(out,2,2)).toEqual(px(src,2,2));
    expect(px(out,W-3,8)[0]).toBeGreaterThan(.18);
  });
  it('preserveHighlights holds back bright pixels', () => {
    const src=gray(1.2),out=run(src,normalsOf(()=>[-1,0,0]),params({preserveHighlights:1}));
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
  it('keeps fine texture (albedo) in the added light, treats large-scale brightness as shading', () => {
    // 256 px wide: the low-pass sigma is 0.02·256 = 5.12 px, so alternating 0.12/0.24 columns average to 0.18.
    const w=256,h=4,d=new Float32Array(w*h*4),nd=new Float32Array(w*h*3);
    for(let i=0;i<w*h;i++){const v=i%2?.24:.12;d.set([v,v,v,1],i*4);nd.set([-1,0,0],i*3);}
    const src:ImageBuf={kind:'image',width:w,height:h,data:d,space:'lin_rec709_srgb'};
    const out=relightNode.evaluate({image:src,normals:{kind:'vector3',width:w,height:h,data:nd}},params(),{...ctx(),width:w,height:h}) as ImageBuf;
    const at=(x:number)=>out.data[(2*w+x)*4];
    expect(at(128)/at(129)).toBeCloseTo(.12/.24,3);
    expect(at(128)).toBeCloseTo(.24,3);
  });
  it('lights depth-derived normals: a surface whose depth falls to the right faces left', () => {
    const facesLeft=normalsFromDepth(depthOf(x=>.6-.3*(x+.5)/W),.002),facesRight=normalsFromDepth(depthOf(x=>.3+.3*(x+.5)/W),.002);
    const src=gray();
    expect(px(run(src,facesLeft),10,8)[0]).toBeGreaterThan(.2);
    expect(px(run(src,facesRight),10,8)).toEqual(px(src,10,8));
  });
  it('converts the light color from the working space only when the image space differs', () => {
    convertPixel.mockClear();
    run(gray(),split,params(),ctx('lin_rec709_srgb'));expect(convertPixel).not.toHaveBeenCalled();
    const out=run(gray(),normalsOf(()=>[-1,0,0]),params(),ctx('ACEScg'));
    expect(convertPixel).toHaveBeenCalledTimes(1);
    expect(px(out,3,3)[0]).toBeCloseTo(.18+.18*2,6);
  });
  it('refuses display-referred images and missing normals', () => {
    expect(()=>run(gray(.18,'Rec.1886 Rec.709 - Display'),split)).toThrow(/linearen Farbraum/);
    expect(()=>relightNode.evaluate({image:gray()},params(),ctx())).toThrow(/Normalen/);
  });
  it('is deterministic', () => {
    const src=gray();for(let i=0;i<W*H;i++)src.data[i*4]=(i%7)/7;
    const n=normalsFromDepth(depthOf((x,y)=>Math.cos(x*.4)*.1+y*.03+.2),.004),p=params({softness:.6,preserveHighlights:.7,elevation:20,azimuth:-70});
    expect(Array.from(run(src,n,p).data)).toEqual(Array.from(run(src,n,p).data));
  });
});
