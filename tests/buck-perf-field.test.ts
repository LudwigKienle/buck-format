import { describe, expect, it } from 'vitest';
import { boxMean, gaussianBlur, gaussianKernel, guidedFilter, resample, sampleBilinear } from '../src/buck/field';

/** Reference copies of the implementations before the performance rewrite (field.ts, prototype draft 0.1). */
function refGaussianBlur(data:Float32Array,width:number,height:number,channels:number,sigma:number){
  if(!(sigma>0))return new Float32Array(data);
  const k=gaussianKernel(sigma),r=(k.length-1)/2,tmp=new Float32Array(data.length),out=new Float32Array(data.length);
  const pass=(src:Float32Array,dst:Float32Array,horizontal:boolean)=>{
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<channels;c++){
      let sum=0,w=0;
      for(let i=-r;i<=r;i++){
        const xx=horizontal?Math.min(width-1,Math.max(0,x+i)):x,yy=horizontal?y:Math.min(height-1,Math.max(0,y+i));
        const v=src[(yy*width+xx)*channels+c];if(Number.isFinite(v)){sum+=v*k[i+r];w+=k[i+r];}
      }
      const idx=(y*width+x)*channels+c;dst[idx]=w>0?sum/w:src[idx];
    }
  };
  pass(data,tmp,true);pass(tmp,out,false);return out;
}
function refSampleBilinear(data:Float32Array,width:number,height:number,channels:number,x:number,y:number,channel:number){
  const fx=Math.min(width-1,Math.max(0,x-.5)),fy=Math.min(height-1,Math.max(0,y-.5)),x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),tx=fx-x0,ty=fy-y0;
  const at=(xx:number,yy:number)=>data[(yy*width+xx)*channels+channel];
  return (at(x0,y0)*(1-tx)+at(x1,y0)*tx)*(1-ty)+(at(x0,y1)*(1-tx)+at(x1,y1)*tx)*ty;
}
function refResample(data:Float32Array,width:number,height:number,channels:number,toWidth:number,toHeight:number){
  if(width===toWidth&&height===toHeight)return new Float32Array(data);
  const out=new Float32Array(toWidth*toHeight*channels),sx=width/toWidth,sy=height/toHeight;
  for(let y=0;y<toHeight;y++)for(let x=0;x<toWidth;x++)for(let c=0;c<channels;c++)out[(y*toWidth+x)*channels+c]=refSampleBilinear(data,width,height,channels,(x+.5)*sx,(y+.5)*sy,c);
  return out;
}

/** Deterministic pseudo-random test data (fixed LCG seed) with optional non-finite samples. */
function field(w:number,h:number,ch:number,seed:number,holes:'none'|'some'|'rows'|'all'){
  const d=new Float32Array(w*h*ch);let s=seed>>>0;
  const rnd=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/2**32;};
  for(let i=0;i<d.length;i++)d[i]=(rnd()-.3)*(i%7===0?40:1.5);
  if(holes==='some')for(let i=0;i<d.length;i++){const u=rnd();if(u<.03)d[i]=Infinity;else if(u<.04)d[i]=NaN;else if(u<.045)d[i]=-Infinity;}
  if(holes==='rows')for(let y=0;y<h;y+=3)for(let j=0;j<w*ch;j++)d[y*w*ch+j]=j%2?Infinity:NaN;
  if(holes==='all')d.fill(Infinity);
  return d;
}
/** Number of samples that differ in their bit pattern (NaN equals NaN, +0 differs from −0). */
const mismatches=(a:Float32Array,b:Float32Array)=>{expect(a.length).toBe(b.length);let n=0;for(let i=0;i<a.length;i++)if(!Object.is(a[i],b[i]))n++;return n;};

describe('field.gaussianBlur (performance rewrite) is bit-identical to the reference', () => {
  const sizes:[number,number][]=[[1,1],[1,9],[9,1],[5,3],[37,23],[64,40]];
  for(const [w,h] of sizes)for(const ch of [1,3,4])for(const holes of ['none','some','rows','all'] as const){
    it(`${w}×${h}×${ch} holes=${holes}`, () => {
      const d=field(w,h,ch,w*131+h*7+ch,holes);
      for(const sigma of [0,-1,NaN,.2,.5,1,2.5,7,40])expect(mismatches(gaussianBlur(d,w,h,ch,sigma),refGaussianBlur(d,w,h,ch,sigma))).toBe(0);
    });
  }
  it('a wide image with relight-size sigmas (0.02 W and 0.006 W) and a depth field with an infinite sky', () => {
    const w=320,h=180,img=field(w,h,1,99,'none'),n=field(w,h,3,7,'none'),depth=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)depth[y*w+x]=y<40+10*Math.sin(x/17)?Infinity:.2+.7*(1-y/h)+.01*((x*13)%7);
    expect(mismatches(gaussianBlur(img,w,h,1,.02*w),refGaussianBlur(img,w,h,1,.02*w))).toBe(0);
    expect(mismatches(gaussianBlur(n,w,h,3,.006*w),refGaussianBlur(n,w,h,3,.006*w))).toBe(0);
    expect(mismatches(gaussianBlur(depth,w,h,1,.002*w),refGaussianBlur(depth,w,h,1,.002*w))).toBe(0);
    expect(mismatches(gaussianBlur(depth,w,h,1,.05*w),refGaussianBlur(depth,w,h,1,.05*w))).toBe(0);
  });
  it('never aliases its input', () => {
    const d=field(8,8,1,3,'none'),out=gaussianBlur(d,8,8,1,1);
    expect(out).not.toBe(d);expect(gaussianBlur(d,8,8,1,0)).not.toBe(d);
  });
});

describe('field.sampleBilinear / resample (closure removed) are bit-identical to the reference', () => {
  it('samples everywhere including outside the image', () => {
    const w=13,h=7,ch=3,d=field(w,h,ch,5,'none');
    for(let y=-2;y<=h+2;y+=.37)for(let x=-2;x<=w+2;x+=.41)for(let c=0;c<ch;c++)expect(Object.is(sampleBilinear(d,w,h,ch,x,y,c),refSampleBilinear(d,w,h,ch,x,y,c))).toBe(true);
  });
  it('resamples up and down', () => {
    const d=field(31,17,4,11,'none');
    for(const [tw,th] of [[31,17],[62,34],[10,6],[1,1],[47,9]])expect(mismatches(resample(d,31,17,4,tw,th),refResample(d,31,17,4,tw,th))).toBe(0);
  });
});

describe('boxMean and guidedFilter', () => {
  it('box mean equals the brute-force clamped window mean', () => {
    const w=13,h=9,v=new Float32Array(w*h).map((_,i)=>Math.sin(i*1.7)),r=3,b=boxMean(v,w,h,r);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let s=0,k=0;for(let j=Math.max(0,y-r);j<=Math.min(h-1,y+r);j++)for(let i=Math.max(0,x-r);i<=Math.min(w-1,x+r);i++){s+=v[j*w+i];k++;}
      expect(b[y*w+x]).toBeCloseTo(s/k,5);
    }
  });
  it('reproduces the guide itself and moves a misplaced step onto the edge of the guide', () => {
    // Guide: dark left, bright right (edge between x=15 and 16); input: a hard step at x=12 (the coarse mask).
    const w=32,h=8,g=[0,1,2].map(()=>new Float32Array(w*h)),p=new Float32Array(w*h),tex=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;for(const c of g)c[i]=x<16?.1:.9;p[i]=x>=12?1:0;tex[i]=g[0][i];}
    for(const s of [1,2]){
      // s = 1 only (float32, three identical guide channels make the covariance nearly singular): the subsampled variant
      // interpolates the coefficients across the step and is only close away from it.
      if(s===1){const id=guidedFilter(g,tex,w,h,3,1e-8,s);for(let i=0;i<w*h;i++)expect(id[i]).toBeCloseTo(tex[i],2);}
      const q=guidedFilter(g,p,w,h,4,1e-4,s),jump=(x:number)=>Math.abs(q[4*w+x+1]-q[4*w+x]);
      for(let x=16;x<21;x++)expect(q[4*w+x]).toBeGreaterThan(.95);
      expect(jump(15)).toBeGreaterThan(2*jump(11));
    }
  });
});
