import { describe, expect, it } from 'vitest';
import { imageBuf, sampleBilinear, scalarField } from '../src/buck/field';
import { bokehRadius, cocWidth, dofNode, dofSampleCount, DOF_SAMPLES } from '../src/buck/nodes/dof';
import { BuckError } from '../src/buck/types';
import type { DofParams, ImageBuf, RenderContext, Resolved, ScalarField } from '../src/buck/types';

type P=Resolved<DofParams>;
const base:P={mode:'artistic',focus:.3,focusRange:.1,blurNear:.02,blurFar:.02,maxBlur:.02,blades:0,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0};
const ctx=(w:number,h:number):RenderContext=>({width:w,height:h,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}});
/** Deterministic textured test image (no randomness). */
function texture(w:number,h:number):ImageBuf {
  const img=imageBuf(w,h,'ACEScg');
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,v=((x>>2)+(y>>2))&1;img.data[i]=.1+.8*v;img.data[i+1]=.5+.4*Math.sin(x*.7+y*.3);img.data[i+2]=.2+.1*((x*7+y*3)%5);img.data[i+3]=1-((x+y)%3)*.1;}
  return img;
}
const depthOf=(w:number,h:number,f:(x:number,y:number)=>number):ScalarField=>{const d=scalarField(w,h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)d.data[y*w+x]=f(x,y);return d;};
const run=(img:ImageBuf,depth:ScalarField,p:P)=>dofNode.evaluate({image:img,depth},p,ctx(img.width,img.height)) as ImageBuf;
const std=(img:ImageBuf,x0:number,x1:number,y0:number,y1:number)=>{
  let s=0,s2=0,n=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const v=img.data[(y*img.width+x)*4];s+=v;s2+=v*v;n++;}
  return Math.sqrt(Math.max(0,s2/n-(s/n)**2));
};

describe('cocWidth', () => {
  it('artistic: zero inside focus ± range/2, signed smoothstep ramps, clamped to maxBlur', () => {
    const p={...base,blurNear:.015,blurFar:.03,maxBlur:.025};
    for(const d of [.25,.3,.35])expect(cocWidth(d,p)).toBe(0);
    expect(cocWidth(0,p)).toBeCloseTo(-.015,12);
    expect(cocWidth(1,p)).toBe(.025);
    expect(cocWidth(.1,p)).toBeLessThan(0);
    expect(cocWidth(.7,p)).toBeGreaterThan(0);
    // Smoothstep midpoint between hi = 0.35 and 1.
    expect(cocWidth(.675,{...p,maxBlur:1})).toBeCloseTo(.015,12);
    let prev=-Infinity;for(let d=0;d<=1.0001;d+=.01){const c=cocWidth(d,p);expect(c).toBeGreaterThanOrEqual(prev);prev=c;}
  });
  it('invalid depth counts as far', () => {
    expect(cocWidth(Infinity,base)).toBe(cocWidth(1,base));
    expect(cocWidth(NaN,base)).toBe(cocWidth(1,base));
    expect(cocWidth(Infinity,{...base,mode:'physical'})).toBeGreaterThan(0);
  });
  it('physical: thin-lens circle of confusion c = f²|d−s|/(N·d·(s−f)) per sensor width', () => {
    const p:P={...base,mode:'physical',focusDistance:2,fNumber:2,focalLength:50,sensorWidth:36,maxBlur:1};
    expect(cocWidth(4,p)).toBeCloseTo(50*50*2000/(2*4000*1950)/36,12);
    expect(cocWidth(1,p)).toBeCloseTo(-50*50*1000/(2*1000*1950)/36,12);
    expect(cocWidth(2,p)).toBe(0);
    expect(cocWidth(Infinity,p)).toBeCloseTo(50*50/(2*1950)/36,12);
    expect(cocWidth(.5,{...p,maxBlur:.02})).toBe(-.02);
    expect(cocWidth(3,{...p,fNumber:4})).toBeCloseTo(cocWidth(3,p)/2,12);
  });
});

describe('bokehRadius and sampling', () => {
  it('circle, regular polygon, rotation and blade curvature', () => {
    for(let t=0;t<7;t+=.37)expect(bokehRadius(t,0,0,0)).toBe(1);
    expect(bokehRadius(0,6,0,0)).toBeCloseTo(1,12);
    expect(bokehRadius(Math.PI/6,6,0,0)).toBeCloseTo(Math.cos(Math.PI/6),12);
    expect(bokehRadius(Math.PI/6,6,30,0)).toBeCloseTo(1,12);
    expect(bokehRadius(Math.PI/5,5,0,0)).toBeCloseTo(Math.cos(Math.PI/5),12);
    expect(bokehRadius(Math.PI/6,6,0,1)).toBeCloseTo(1,12);
    expect(bokehRadius(Math.PI/6,6,0,.5)).toBeCloseTo((1+Math.cos(Math.PI/6))/2,12);
    for(let t=0;t<7;t+=.11){const r=bokehRadius(t,7,13,.2);expect(r).toBeLessThanOrEqual(1+1e-12);expect(r).toBeGreaterThanOrEqual(Math.cos(Math.PI/7)-1e-12);expect(bokehRadius(t+2*Math.PI/7,7,13,.2)).toBeCloseTo(r,9);}
  });
  it('sample count is an integer function of the radius within the bounds', () => {
    expect(dofSampleCount(0)).toBe(DOF_SAMPLES.min);
    expect(dofSampleCount(50)).toBe(DOF_SAMPLES.max);
    let prev=0;for(let r=0;r<20;r+=.25){const n=dofSampleCount(r);expect(Number.isInteger(n)).toBe(true);expect(n).toBeGreaterThanOrEqual(prev);prev=n;}
  });
});

describe('lens.dof@1', () => {
  const W=96,H=64;
  it('keeps the in-focus region bit-identical, background never bleeds over a sharp subject', () => {
    const img=texture(W,H),depth=depthOf(W,H,x=>x<W/2?.3:1),out=run(img,depth,{...base,blurFar:.06,maxBlur:.06});
    for(let y=0;y<H;y++)for(let x=0;x<W/2;x++)for(let c=0;c<4;c++)expect(out.data[(y*W+x)*4+c]).toBe(img.data[(y*W+x)*4+c]);
    expect(std(out,W/2+6,W,0,H)).toBeLessThan(std(img,W/2+6,W,0,H)*.5);
  });
  it('blurred foreground bleeds over a sharp background, far from it stays identical', () => {
    const img=texture(W,H),depth=depthOf(W,H,x=>x<W/2?0:.3),out=run(img,depth,{...base,blurNear:.06,maxBlur:.06});
    const R=.06*W/2;let changed=0;
    for(let y=0;y<H;y++)for(let x=W/2;x<W;x++){const i=(y*W+x)*4,diff=out.data[i]!==img.data[i];if(x<W/2+R-1&&diff)changed++;if(x>W/2+R+2)expect(out.data[i]).toBe(img.data[i]);}
    expect(changed).toBeGreaterThan(H);
  });
  it('blurs foreground silhouettes symmetrically and keeps sharp silhouettes halo-free', () => {
    const W2=96,H2=24,edge=(fg:number,bg:number)=>{
      const img=imageBuf(W2,H2,'ACEScg'),d=scalarField(W2,H2);
      for(let i=0;i<W2*H2;i++){const left=i%W2<W2/2;img.data[i*4]=left?1:0;img.data[i*4+1]=left?0:1;img.data[i*4+3]=1;d.data[i]=left?fg:bg;}
      return run(img,d,{...base,blurNear:.08,blurFar:.08,maxBlur:.1});
    };
    // Blurred foreground (R ≈ 3.8 px) over a sharp background: a smooth monotone ramp that is ½ across the silhouette.
    const a=edge(0,.3),row=Array.from({length:W2},(_,x)=>a.data[(12*W2+x)*4]);
    expect(row[W2/2-1]+row[W2/2]).toBeCloseTo(1,1);
    for(let x=1;x<W2;x++){expect(row[x]).toBeLessThanOrEqual(row[x-1]+1e-6);expect(row[x-1]-row[x]).toBeLessThan(.25);}
    expect(row[W2/2-6]).toBe(1);expect(row[W2/2+6]).toBe(0);
    // Sharp foreground over a blurred background: the subject stays exact and never leaks into the background blur.
    const b=edge(.3,1);
    for(let i=0;i<W2*H2;i++){if(i%W2<W2/2){expect(b.data[i*4]).toBe(1);expect(b.data[i*4+1]).toBe(0);}else expect(b.data[i*4]).toBe(0);}
  });
  // Fix within lens.dof@1 (prototype draft 0.1): sparse foreground taps used to count a scatterer smaller than the tap
  // spacing with the whole tap area, so one tap could stamp it opaquely (coverage ≥ 1) into the blurred background.
  it('spreads a small mid-depth scatterer over its own disc instead of stamping it (energy kept, no dark dot)', () => {
    const W2=200,H2=60,img=imageBuf(W2,H2,'ACEScg'),d=scalarField(W2,H2),p={...base,blurFar:.2,maxBlur:.2};
    let dm=.35;while(cocWidth(dm,p)*W2/2<2)dm+=.001;
    for(let i=0;i<W2*H2;i++){img.data.set([1,1,1,1],i*4);d.data[i]=1;}
    const pts:[number,number][]=[[50,30],[90,25],[130,35],[160,28]];
    for(const [x,y] of pts){img.data.set([0,0,0,1],(y*W2+x)*4);d.data[y*W2+x]=dm;}
    const out=run(img,d,p);
    for(const [px,py] of pts){
      let dark=0,min=Infinity;
      for(let y=py-8;y<=py+8;y++)for(let x=px-8;x<=px+8;x++){const v=out.data[(y*W2+x)*4];dark+=1-v;min=Math.min(min,v);}
      // One black pixel spread over π·2² px: about 1/12.6 coverage each (the receiving pixel itself shows its own blur).
      expect(dark).toBeGreaterThan(.85);expect(dark).toBeLessThan(1.15);
      expect(min).toBeGreaterThan(.75);
    }
  });
  it('no dark edge: a thin contour on the depth ramp of a sharp silhouette is not stamped into the blurred background', () => {
    // Estimated depth puts the dark outline pixel of a subject at an intermediate depth (CoC ≈ 2 px) between the sharp
    // subject (0.3) and the bright, strongly blurred background (1.0); the silhouette is jagged as in a real image.
    const W2=200,H2=64,img=imageBuf(W2,H2,'ACEScg'),d=scalarField(W2,H2),p={...base,blurFar:.2,maxBlur:.2},edge=(y:number)=>100+((y*5)%7)-3;
    let dm=.35;while(cocWidth(dm,p)*W2/2<2)dm+=.001;
    for(let y=0;y<H2;y++)for(let x=0;x<W2;x++){const i=y*W2+x,e=edge(y),v=x<e?.3:x===e?.02:1;img.data.set([v,v,v,1],i*4);d.data[i]=x<e?.3:x===e?dm:1;}
    const out=run(img,d,p);
    for(let y=0;y<H2;y++){
      for(let x=0;x<edge(y);x++)expect(out.data[(y*W2+x)*4]).toBe(img.data[(y*W2+x)*4]);
      // Beyond the contour the background is never darker than the softly spread contour (before the fix: 0.02 dots).
      for(let x=edge(y)+1;x<W2;x++)expect(out.data[(y*W2+x)*4]).toBeGreaterThan(.6);
    }
  });
  it('preserves a constant image (energy) for every bokeh option', () => {
    const img=imageBuf(W,H,'ACEScg');for(let i=0;i<W*H;i++)img.data.set([.42,.17,2.5,1],i*4);
    const depth=depthOf(W,H,(x,y)=>(x*13+y*7)%10/9);
    for(const opt of [{},{blades:6,rotation:15},{blades:5,bladeCurvature:.4,catEye:1},{highlightBoost:1}]){
      const out=run(img,depth,{...base,...opt});
      for(let i=0;i<W*H;i++){expect(out.data[i*4]).toBeCloseTo(.42,5);expect(out.data[i*4+1]).toBeCloseTo(.17,5);expect(out.data[i*4+2]).toBeCloseTo(2.5,5);expect(out.data[i*4+3]).toBe(1);}
    }
  });
  it('approximately conserves the energy of a point light', () => {
    const img=imageBuf(W,H,'ACEScg');for(let i=0;i<W*H;i++)img.data[i*4+3]=1;
    img.data[(32*W+48)*4]=100;
    const out=run(img,depthOf(W,H,()=>1),{...base,blurFar:.1,maxBlur:.1});
    let sum=0;for(let i=0;i<W*H;i++)sum+=out.data[i*4];
    expect(out.data[(32*W+48)*4]).toBeLessThan(10);
    expect(sum).toBeGreaterThan(70);expect(sum).toBeLessThan(130);
  });
  it('blur grows monotonically with blurFar', () => {
    const img=texture(W,H),depth=depthOf(W,H,()=>1);let prev=Infinity;
    for(const b of [0,.02,.04,.08,.16]){const s=std(run(img,depth,{...base,blurFar:b,maxBlur:.2}),8,W-8,8,H-8);expect(s).toBeLessThan(prev);prev=s;}
  });
  it('maps the bokeh of a point light onto the aperture polygon', () => {
    const S=81,R=12,img=imageBuf(S,S,'lin_rec709_srgb');for(let i=0;i<S*S;i++)img.data[i*4+3]=1;
    img.data[(40*S+40)*4]=1;
    const bokeh=(o:Partial<P>)=>{
      const out=run(img,depthOf(S,S,()=>1),{...base,blurFar:2*R/S,maxBlur:1,...o}),ch=new Float32Array(S*S);
      for(let i=0;i<S*S;i++)ch[i]=out.data[i*4];
      let inner=0,n=0,lit=0;for(let y=0;y<S;y++)for(let x=0;x<S;x++)if(Math.hypot(x-40,y-40)<R/2){inner+=ch[y*S+x];n++;}
      const half=inner/n/2;for(const v of ch)if(v>half)lit++;
      // Half-maximum radius along a screen direction (degrees, counter-clockwise, y up).
      const extent=(deg:number)=>{const c=Math.cos(deg*Math.PI/180),s=-Math.sin(deg*Math.PI/180);let r=0;while(sampleBilinear(ch,S,S,1,40.5+r*c,40.5+r*s,0)>half)r+=.05;return r;};
      return{lit,extent};
    };
    const circle=bokeh({}),hex=bokeh({blades:6}),pent=bokeh({blades:5}),rot=bokeh({blades:6,rotation:30});
    expect(circle.lit/(Math.PI*R*R)).toBeGreaterThan(.9);expect(circle.lit/(Math.PI*R*R)).toBeLessThan(1.1);
    expect(hex.lit/circle.lit).toBeGreaterThan(.75);expect(hex.lit/circle.lit).toBeLessThan(.9);
    expect(Math.abs(circle.extent(0)-circle.extent(90))).toBeLessThan(.5);
    // Hexagon: vertex at 0°, edge midpoint (apothem 0.866 R) at 90°; rotation 30° swaps them. The tap prefilter rounds
    // vertex tips by about a pixel, so only the ordering is asserted with a margin.
    expect(hex.extent(0)-hex.extent(90)).toBeGreaterThan(.4);
    expect(rot.extent(90)-rot.extent(0)).toBeGreaterThan(.4);
    expect(hex.extent(90)).toBeLessThan(circle.extent(90)-1);
    // Pentagon: vertex toward +x, edge midpoint (0.809 R) toward −x.
    expect(pent.extent(0)-pent.extent(180)).toBeGreaterThan(.8);
  });
  it('is deterministic and produces no NaN for invalid depth and odd params', () => {
    const img=texture(W,H),depth=depthOf(W,H,(x,y)=>[NaN,Infinity,-1,2,0,.3,1][(x+y*3)%7]);
    for(const p of [{...base,blades:7,catEye:.8,highlightBoost:1,rotation:40,bladeCurvature:.3},{...base,mode:'physical' as const,focusDistance:.01,fNumber:1.4,focalLength:85,sensorWidth:24.9},{...base,mode:'physical' as const,fNumber:0},{...base,focusRange:-1,maxBlur:-1}]){
      const a=run(img,depth,p),b=run(img,depth,p);
      expect(Array.from(a.data)).toEqual(Array.from(b.data));
      for(const v of a.data)expect(Number.isFinite(v)).toBe(true);
    }
  });
  it('warns about impossible physical optics', () => {
    const warnings:string[]=[],img=texture(8,8),d=depthOf(8,8,()=>5);
    for(const p of [{fNumber:0},{focusDistance:.03,focalLength:50}]){
      const out=dofNode.evaluate({image:img,depth:d},{...base,mode:'physical',...p},{...ctx(8,8),warn:m=>warnings.push(m)}) as ImageBuf;
      for(const v of out.data)expect(Number.isFinite(v)).toBe(true);
    }
    expect(warnings).toHaveLength(2);expect(warnings[0]).toMatch(/Blendenzahl/);expect(warnings[1]).toMatch(/Fokusdistanz/);
  });
  it('rejects non-linear images, missing depth and mismatched sizes', () => {
    const img=texture(8,8),d=depthOf(8,8,()=>1);
    expect(()=>run({...img,space:'Rec.1886 Rec.709 - Display'},d,base)).toThrow(BuckError);
    expect(()=>dofNode.evaluate({image:img},base,ctx(8,8))).toThrow(/Tiefeneingang/);
    expect(()=>run(img,depthOf(4,4,()=>1),base)).toThrow(BuckError);
  });
  it('renders a 1100×620 preview with maxBlur 0.02 (timing logged)', () => {
    const w=1100,h=620,img=imageBuf(w,h,'ACEScg');
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;img.data[i]=(x*y)%17/16;img.data[i+1]=.5;img.data[i+2]=(x%9)/8*3;img.data[i+3]=1;}
    // Worst case: a depth ramp with near and far blur everywhere outside a thin focus band.
    const depth=depthOf(w,h,(x,y)=>.6*x/w+.4*y/h),p={...base,focus:.4,focusRange:.05,blades:6,highlightBoost:.5};
    run(img,depth,p);
    const t0=performance.now(),out=run(img,depth,p),ms=performance.now()-t0;
    console.log(`lens.dof@1 1100×620 maxBlur 0.02: ${ms.toFixed(0)} ms`);
    expect(out.width).toBe(w);expect(ms).toBeLessThan(5000);
  },30000);
});
