import { describe, expect, it, vi } from 'vitest';
import { encode as encodePng } from 'fast-png';
import type { ImageData as PngImage } from 'fast-png';
import { combineMask, depthRangeMask, gradientMask, imageMask, inputMask, lumaMask, refineMask } from '../src/buck/nodes/masks';
import { scalarField, smoothstep } from '../src/buck/field';
import { BuckError, LIMITS } from '../src/buck/types';
import type { AuxChannels, ImageBuf, RGB, RenderContext, ScalarField, SpaceName } from '../src/buck/types';

// colorspace.ts belongs to another agent: inject a fake with known weights and an observable conversion.
vi.mock('../src/buck/colorspace',()=>({
  lumaWeights:(space:string)=>space==='ACEScg'?[.25,.5,.25]:[.2126,.7152,.0722],
  convertPixel:(rgb:RGB)=>rgb.map(v=>v*2),
}));

const ctx=(width:number,height:number,extra:Partial<RenderContext>={}):RenderContext&{warnings:string[]}=>{
  const warnings:string[]=[];
  return {width,height,frame:0,aux:{masks:{}} as AuxChannels,files:new Map(),workingLinear:'ACEScg',warn:m=>warnings.push(m),warnings,...extra};
};
const field=(w:number,h:number,values:number[])=>scalarField(w,h,Float32Array.from(values));
const at=(f:ScalarField,x:number,y:number)=>f.data[y*f.width+x];
const close=(a:number,b:number)=>expect(Math.abs(a-b)).toBeLessThan(1e-6);

describe('mask.depthRange@1',()=>{
  const p={near:.3,far:.6,feather:.1,invert:false};
  it('follows the normative smoothstep band at every edge',()=>{
    const ds=[0,.2,.25,.3,.45,.6,.65,.7,1];
    const out=depthRangeMask.evaluate({depth:field(ds.length,1,ds)},p,ctx(ds.length,1)) as ScalarField;
    ds.forEach((d,i)=>close(out.data[i],smoothstep(.2,.3,d)*(1-smoothstep(.6,.7,d))));
    [0,0,null,1,1,1,null,0,0].forEach((v,i)=>{if(v!==null)close(out.data[i],v);});
    close(out.data[2],.5);close(out.data[6],.5);
  });
  it('treats +Infinity and NaN as the farthest point and supports invert',()=>{
    const bg={near:.55,far:1,feather:.15,invert:false},d=field(3,1,[Infinity,NaN,0]);
    expect(Array.from((depthRangeMask.evaluate({depth:d},bg,ctx(3,1)) as ScalarField).data)).toEqual([1,1,0]);
    expect(Array.from((depthRangeMask.evaluate({depth:d},{...bg,invert:true},ctx(3,1)) as ScalarField).data)).toEqual([0,0,1]);
    const near={near:0,far:.6,feather:.12,invert:false};
    expect((depthRangeMask.evaluate({depth:field(1,1,[Infinity])},near,ctx(1,1)) as ScalarField).data[0]).toBe(0);
  });
  it('hard step with feather 0 and resamples to the context without NaN from sky',()=>{
    const out=depthRangeMask.evaluate({depth:field(2,1,[.4,Infinity])},{near:.3,far:.6,feather:0,invert:false},ctx(4,2)) as ScalarField;
    expect(out.width).toBe(4);expect(out.height).toBe(2);
    expect(out.data.every(Number.isFinite)).toBe(true);expect(at(out,0,0)).toBe(1);expect(at(out,3,1)).toBe(0);
  });
  it('rejects a missing or wrongly typed depth input',()=>{
    expect(()=>depthRangeMask.evaluate({},p,ctx(1,1))).toThrow(BuckError);
    const img:ImageBuf={kind:'image',width:1,height:1,data:new Float32Array(4),space:'ACEScg'};
    expect(()=>depthRangeMask.evaluate({depth:img},p,ctx(1,1))).toThrow(/Skalarfeld/);
  });
});

describe('mask.gradient@1',()=>{
  it('linear: 0 at start, 1 at end, smoothstep between, widened by feather',()=>{
    const c=ctx(10,1),base={shape:'linear' as const,start:[.05,0] as [number,number],end:[.95,0] as [number,number],invert:false};
    const out=gradientMask.evaluate({},{...base,feather:0},c) as ScalarField;
    for(let x=0;x<10;x++)close(out.data[x],smoothstep(0,.9,(x+.5)/10-.05));
    expect(out.data[0]).toBe(0);expect(out.data[9]).toBe(1);close(out.data[4]+out.data[5],1);
    const wide=gradientMask.evaluate({},{...base,feather:.2},c) as ScalarField;
    expect(wide.data[0]).toBeGreaterThan(0);expect(wide.data[9]).toBeLessThan(1);
    const inv=gradientMask.evaluate({},{...base,feather:0,invert:true},c) as ScalarField;
    for(let x=0;x<10;x++)close(inv.data[x],1-out.data[x]);
  });
  it('linear measures y in image widths and projects onto the direction',()=>{
    // 4×8 frame: y runs 0…2; a vertical ramp from y=0 to y=2 has its midpoint at row 4.
    const out=gradientMask.evaluate({},{shape:'linear',start:[0,0],end:[0,2],feather:0,invert:false},ctx(4,8)) as ScalarField;
    for(let y=0;y<8;y++){close(at(out,0,y),smoothstep(0,2,(y+.5)/4));close(at(out,3,y),at(out,0,y));}
    const def=gradientMask.evaluate({},{shape:'linear',feather:0,invert:false},ctx(4,8)) as ScalarField;
    expect(Array.from(def.data)).toEqual(Array.from(out.data));
  });
  it('degenerate linear gradient warns and is empty',()=>{
    const c=ctx(3,3),out=gradientMask.evaluate({},{shape:'linear',start:[.5,.5],end:[.5,.5],feather:.1,invert:false},c) as ScalarField;
    expect(out.data.every(v=>v===0)).toBe(true);expect(c.warnings).toHaveLength(1);
  });
  it('radial: 1 inside the radius, smooth falloff, invert gives a vignette',()=>{
    const c=ctx(21,21),p={shape:'radial' as const,center:[.5,.5] as [number,number],radius:.2,feather:.1,invert:false};
    const out=gradientMask.evaluate({},p,c) as ScalarField;
    expect(at(out,10,10)).toBe(1);expect(at(out,0,0)).toBe(0);
    for(let x=0;x<21;x++)close(at(out,x,10),1-smoothstep(.2,.3,Math.abs((x+.5)/21-.5)));
    expect(at(out,10,3)).toBeCloseTo(at(out,3,10),6);
    const inv=gradientMask.evaluate({},{...p,invert:true},c) as ScalarField;
    expect(at(inv,10,10)).toBe(0);expect(at(inv,0,0)).toBe(1);
    const sharp=gradientMask.evaluate({},{...p,feather:0},c) as ScalarField;
    expect(sharp.data.every(v=>v===0||v===1)).toBe(true);
  });
});

describe('mask.luma@1',()=>{
  const img=(space:SpaceName,rgbs:RGB[]):ImageBuf=>({kind:'image',width:rgbs.length,height:1,space,data:Float32Array.from(rgbs.flatMap(c=>[...c,1]))});
  it('uses the weights of params.space with a soft window',()=>{
    const p={low:.3,high:.6,softness:.1,space:'ACEScg' as SpaceName},out=lumaMask.evaluate({image:img('ACEScg',[[.45,.45,.45],[0,.5,0],[.8,.8,.8],[1,0,0],[0,.4,.4]])},p,ctx(5,1)) as ScalarField;
    expect(out.data[0]).toBe(1);close(out.data[1],smoothstep(.2,.3,.25));expect(out.data[2]).toBe(0);
    close(out.data[3],smoothstep(.2,.3,.25));close(out.data[4],1);
  });
  it('converts pixels that are not in params.space',()=>{
    const p={low:.5,high:.7,softness:0,space:'ACEScg' as SpaceName};
    // The fake conversion doubles every channel: 0.3 → 0.6 lies inside the window only after conversion.
    expect((lumaMask.evaluate({image:img('lin_rec709_srgb',[[.3,.3,.3]])},p,ctx(1,1)) as ScalarField).data[0]).toBe(1);
    expect((lumaMask.evaluate({image:img('ACEScg',[[.3,.3,.3]])},p,ctx(1,1)) as ScalarField).data[0]).toBe(0);
  });
  it('maps non-finite pixels to 0 and rejects non-image input',()=>{
    const out=lumaMask.evaluate({image:img('ACEScg',[[NaN,0,0]])},{low:0,high:1,softness:0,space:'ACEScg'},ctx(1,1)) as ScalarField;
    expect(out.data[0]).toBe(0);
    expect(()=>lumaMask.evaluate({image:field(1,1,[0])},{low:0,high:1,softness:0,space:'ACEScg'},ctx(1,1))).toThrow(BuckError);
  });
});

describe('mask.input@1',()=>{
  it('reads a declared mask by $name, clamps and resamples it',()=>{
    const c=ctx(4,4,{aux:{masks:{subject:field(2,2,[-1,2,.5,NaN])}}}),out=inputMask.evaluate({},{input:'$subject',channel:'luma'},c) as ScalarField;
    expect(out.width).toBe(4);expect(at(out,0,0)).toBe(0);expect(at(out,3,0)).toBe(1);expect(at(out,0,3)).toBe(.5);expect(at(out,3,3)).toBe(0);
    expect(out.data.every(v=>v>=0&&v<=1)).toBe(true);
  });
  it('throws BuckError when the mask is missing',()=>{
    expect(()=>inputMask.evaluate({},{input:'$roto',channel:'a'},ctx(1,1))).toThrow(/„roto“/);
  });
});

describe('mask.image@1',()=>{
  const files=(png:PngImage,opts?:Parameters<typeof encodePng>[1])=>new Map([['masks/m.png',encodePng(png,opts)]]);
  const run=(f:Map<string,Uint8Array>,fit:'stretch'|'contain'|'cover',w:number,h:number)=>imageMask.evaluate({},{file:'masks/m.png',fit},ctx(w,h,{files:f})) as ScalarField;
  it('decodes 8-bit and 16-bit gray exactly at native size',()=>{
    expect(Array.from(run(files({width:2,height:1,data:Uint8Array.from([0,255]),channels:1,depth:8}),'stretch',2,1).data)).toEqual([0,1]);
    const v16=run(files({width:2,height:1,data:Uint16Array.from([32768,65535]),channels:1,depth:16}),'stretch',2,1);
    close(v16.data[0],32768/65535);expect(v16.data[1]).toBe(1);
  });
  it('turns color into Rec.709 luma and multiplies by alpha',()=>{
    const rgb=run(files({width:3,height:1,data:Uint8Array.from([255,0,0,0,255,0,0,0,255]),channels:3,depth:8}),'stretch',3,1);
    close(rgb.data[0],.2126);close(rgb.data[1],.7152);close(rgb.data[2],.0722);
    const rgba=run(files({width:2,height:1,data:Uint8Array.from([255,255,255,255,255,255,255,0]),channels:4,depth:8}),'stretch',2,1);
    expect(Array.from(rgba.data)).toEqual([1,0]);
    const ga=run(files({width:1,height:1,data:Uint16Array.from([65535,32768]),channels:2,depth:16}),'stretch',1,1);
    close(ga.data[0],32768/65535);
  });
  it('supports palette and packed sub-byte grayscale',()=>{
    const pal=run(files({width:2,height:1,data:Uint8Array.from([1,0]),channels:1,depth:8,palette:[[0,0,0],[255,255,255]]}),'stretch',2,1);
    expect(Array.from(pal.data)).toEqual([1,0]);
    // 1-bit, 10 px wide: two bytes per row, MSB first.
    const bits=run(files({width:10,height:1,data:Uint8Array.from([0b10100000,0b01000000]),channels:1,depth:1}),'stretch',10,1);
    expect(Array.from(bits.data)).toEqual([1,0,1,0,0,0,0,0,0,1]);
    const two=run(files({width:4,height:1,data:Uint8Array.from([0b00011011]),channels:1,depth:2}),'stretch',4,1);
    expect(Array.from(two.data).map(v=>Math.round(v*3))).toEqual([0,1,2,3]);
  });
  it('fits stretch, contain and cover',()=>{
    const f=files({width:2,height:1,data:Uint8Array.from([0,255]),channels:1,depth:8});
    const stretch=run(f,'stretch',4,4);expect(at(stretch,0,0)).toBe(0);expect(at(stretch,3,3)).toBe(1);
    const contain=run(f,'contain',4,4);
    expect([0,3].map(y=>at(contain,3,y))).toEqual([0,0]);expect(at(contain,3,1)).toBe(1);expect(at(contain,0,2)).toBe(0);
    const cover=run(f,'cover',4,4);
    // cover scales the 2:1 image by 4 and crops a quarter left and right: u = (x+0.5+2)/4 image pixels.
    [.125,.375,.625,.875].forEach((v,x)=>{close(at(cover,x,0),v);close(at(cover,x,3),v);});
  });
  it('rejects missing, non-PNG, corrupt and oversized files',()=>{
    expect(()=>run(new Map(),'stretch',1,1)).toThrow(/fehlt/);
    expect(()=>run(new Map([['masks/m.png',new Uint8Array(40)]]),'stretch',1,1)).toThrow(/kein PNG/);
    const good=encodePng({width:2,height:2,data:new Uint8Array(4),channels:1,depth:8}),bad=new Uint8Array(good);bad[bad.length-20]^=0xff;
    expect(()=>run(new Map([['masks/m.png',bad]]),'stretch',1,1)).toThrow(BuckError);
    const big=new Uint8Array(good);new DataView(big.buffer).setUint32(16,LIMITS.imageSide+1);
    expect(()=>run(new Map([['masks/m.png',big]]),'stretch',1,1)).toThrow(/höchstens 4096/);
  });
});

describe('mask.combine@1',()=>{
  const a=field(4,1,[0,.5,1,.25]),b=field(4,1,[1,.5,.5,.75]);
  it.each([
    ['multiply',[0,.25,.5,.1875]],['max',[1,.5,1,.75]],['min',[0,.5,.5,.25]],['subtract',[0,0,.5,0]],['screen',[1,.75,1,.8125]],
  ] as const)('%s',(op,expected)=>{
    const out=combineMask.evaluate({a,b},{op},ctx(4,1)) as ScalarField;
    expected.forEach((v,i)=>close(out.data[i],v));
  });
  it('sanitizes and resamples inputs of other sizes',()=>{
    const out=combineMask.evaluate({a:field(1,1,[Infinity]),b:field(2,2,[NaN,2,-1,.5])},{op:'max'},ctx(2,2)) as ScalarField;
    expect(Array.from(out.data)).toEqual([1,1,1,1]);
    expect(()=>combineMask.evaluate({a},{op:'min'},ctx(4,1))).toThrow(/„b“/);
  });
});

describe('mask.refine@1',()=>{
  const brute=(d:Float32Array,w:number,h:number,r:number,dilate:boolean)=>{
    const out=new Float32Array(d.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){let v=dilate?-Infinity:Infinity;for(let j=Math.max(0,y-r);j<=Math.min(h-1,y+r);j++)for(let i=Math.max(0,x-r);i<=Math.min(w-1,x+r);i++)v=dilate?Math.max(v,d[j*w+i]):Math.min(v,d[j*w+i]);out[y*w+x]=v;}
    return out;
  };
  // Deterministic pseudo-pattern without randomness.
  const pattern=(w:number,h:number)=>field(w,h,Array.from({length:w*h},(_,i)=>((i*7919)%101)/100));
  it('grow dilates and erodes exactly like a brute-force square max/min filter',()=>{
    for(const [w,h,grow] of [[17,11,3/17],[17,11,-3/17],[9,13,1/9],[20,7,-5/20],[24,5,6/24],[4,6,.25]] as const){
      const m=pattern(w,h),r=Math.round(Math.abs(grow)*w);
      const out=refineMask.evaluate({mask:m},{blur:0,grow,gamma:1},ctx(w,h)) as ScalarField;
      expect(Array.from(out.data)).toEqual(Array.from(brute(m.data,w,h,r,grow>0)));
    }
  });
  it('grow on a single dot gives a square of side 2r+1',()=>{
    const d=new Array(81).fill(0);d[40]=1;
    const out=refineMask.evaluate({mask:field(9,9,d)},{blur:0,grow:2/9,gamma:1},ctx(9,9)) as ScalarField;
    expect(out.data.reduce((s,v)=>s+v,0)).toBe(25);expect(at(out,2,2)).toBe(1);expect(at(out,1,2)).toBe(0);
  });
  it('blur preserves the mean, stays in 0…1 and is symmetric',()=>{
    const d=new Array(31).fill(0);d[15]=1;
    const out=refineMask.evaluate({mask:field(31,1,d)},{blur:2/31,grow:0,gamma:1},ctx(31,1)) as ScalarField;
    close(out.data.reduce((s,v)=>s+v,0),1);expect(out.data[15]).toBeLessThan(1);
    for(let i=0;i<15;i++)close(out.data[i],out.data[30-i]);
  });
  it('gamma raises the mask to the power and rejects non-positive values',()=>{
    const out=refineMask.evaluate({mask:field(3,1,[.25,.5,1])},{blur:0,grow:0,gamma:2},ctx(3,1)) as ScalarField;
    expect(Array.from(out.data)).toEqual([.0625,.25,1]);
    expect(()=>refineMask.evaluate({mask:field(1,1,[.5])},{blur:0,grow:0,gamma:0},ctx(1,1))).toThrow(BuckError);
  });
  it('caps extreme radii with a warning and never mutates its input',()=>{
    const m=pattern(8,8),copy=Array.from(m.data),c=ctx(8,8);
    refineMask.evaluate({mask:m},{blur:5,grow:-3,gamma:1},c);
    expect(c.warnings).toHaveLength(2);expect(Array.from(m.data)).toEqual(copy);
  });
});

describe('determinism',()=>{
  it('every mask returns bit-identical output on repeated evaluation',()=>{
    const depth=field(16,9,Array.from({length:144},(_,i)=>i%13===0?Infinity:(i%17)/16));
    const image:ImageBuf={kind:'image',width:16,height:9,space:'ACEScg',data:Float32Array.from({length:576},(_,i)=>((i*31)%97)/96)};
    const png=new Map([['masks/m.png',encodePng({width:5,height:3,data:Uint8Array.from({length:15},(_,i)=>i*17),channels:1,depth:8})]]);
    const runs=()=>{
      const c=ctx(16,9,{files:png,aux:{masks:{s:depth}}});
      const dr=depthRangeMask.evaluate({depth},{near:.2,far:.7,feather:.1,invert:false},c) as ScalarField;
      return [
        dr,
        gradientMask.evaluate({},{shape:'radial',center:[.4,.3],radius:.2,feather:.15,invert:true},c),
        gradientMask.evaluate({},{shape:'linear',start:[0,.1],end:[1,.4],feather:.05,invert:false},c),
        lumaMask.evaluate({image},{low:.2,high:.6,softness:.1,space:'ACEScg'},c),
        inputMask.evaluate({},{input:'$s',channel:'r'},c),
        imageMask.evaluate({},{file:'masks/m.png',fit:'cover'},c),
        combineMask.evaluate({a:dr,b:dr},{op:'screen'},c),
        refineMask.evaluate({mask:dr},{blur:.05,grow:.1,gamma:1.5},c),
      ].map(b=>Array.from(b.data));
    };
    const first=runs(),second=runs();
    expect(second).toEqual(first);
    for(const d of first){expect(d).toHaveLength(144);expect(d.every(v=>v>=0&&v<=1)).toBe(true);}
  });
});
