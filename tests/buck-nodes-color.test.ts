import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyLook, NEUTRAL_LOOK } from '../src/color/look';
import type { LookSpec } from '../src/color/look';
import { imageBuf } from '../src/buck/field';
import { BuckError } from '../src/buck/types';
import type { BuckGraph, Buf, CdlParams, ImageBuf, LookParams, RenderContext, RGB, SpaceName } from '../src/buck/types';

// Fake colorspace module: tests must not depend on the real one. Gamma 2.4 between Rec.1886 and lin_rec709_srgb;
// alpha is deliberately zeroed so the nodes' own alpha passthrough is exercised.
const DISPLAY:SpaceName='Rec.1886 Rec.709 - Display',LIN:SpaceName='lin_rec709_srgb';
vi.mock('../src/buck/colorspace',()=>({convertImage:(img:ImageBuf,to:SpaceName):ImageBuf=>{
  const pow=(v:number,e:number)=>Math.sign(v)*Math.abs(v)**e;
  const e=img.space===DISPLAY&&to===LIN?2.4:img.space===LIN&&to===DISPLAY?1/2.4:NaN;
  if(Number.isNaN(e))throw new Error(`fake: ${img.space} -> ${to}`);
  const data=new Float32Array(img.data.length);
  for(let i=0;i<data.length;i+=4){for(let c=0;c<3;c++)data[i+c]=pow(img.data[i+c],e);data[i+3]=0;}
  return {kind:'image',width:img.width,height:img.height,data,space:to};
}}));
const { cdl, cdlNode, convertNode, cubeFromBytes, lookNode, lut3dNode, parseCube, sampleParsedCube } = await import('../src/buck/nodes/color');

function ctx(files=new Map<string,Uint8Array>(),warnings:string[]=[]):RenderContext {
  return {width:4,height:4,frame:0,aux:{masks:{}},files,workingLinear:'ACEScg',warn:m=>{warnings.push(m);}};
}
/** Deterministic test image: an RGB grid plus out-of-range values and a varying alpha. */
function testImage(space:SpaceName,steps=9):ImageBuf {
  const w=steps*steps,h=steps+1,data=new Float32Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4,r=x%steps,g=Math.floor(x/steps);
    data[i]=r/(steps-1);data[i+1]=g/(steps-1);data[i+2]=y/(h-1);data[i+3]=((x+y)%5)/4;
  }
  data.set([-.2,1.3,.5,.7],0);data.set([1.6,-.05,2,.3],4);
  return imageBuf(w,h,space,data);
}
const asImage=(b:Buf)=>{if(b.kind!=='image')throw new Error('kein Bild');return b;};
const alphaOf=(img:ImageBuf)=>img.data.filter((_,i)=>i%4===3);
function cubeText(n:number,fn:(r:number,g:number,b:number)=>RGB,header=''){
  const rows:string[]=[];
  for(let b=0;b<n;b++)for(let g=0;g<n;g++)for(let r=0;r<n;r++)rows.push(fn(r/(n-1),g/(n-1),b/(n-1)).map(v=>v.toPrecision(17)).join(' '));
  return `${header}LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`;
}
const bytes=(s:string)=>new TextEncoder().encode(s);

describe('color.convert@1',()=>{
  it('is an exact copy for from === to and keeps alpha',()=>{
    const img=testImage(DISPLAY),out=asImage(convertNode.evaluate({image:img},{from:DISPLAY,to:DISPLAY},ctx()));
    expect(out.space).toBe(DISPLAY);expect(Array.from(out.data)).toEqual(Array.from(img.data));expect(out.data).not.toBe(img.data);
  });
  it('uses convertImage, tags the target space and passes alpha through',()=>{
    const img=testImage(DISPLAY),out=asImage(convertNode.evaluate({image:img},{from:DISPLAY,to:LIN},ctx()));
    expect(out.space).toBe(LIN);expect(out.data[8]).toBeCloseTo(img.data[8]**2.4,6);
    expect(alphaOf(out)).toEqual(alphaOf(img));
  });
  it('refuses an input in another space than params.from',()=>{
    expect(()=>convertNode.evaluate({image:testImage(LIN)},{from:DISPLAY,to:LIN},ctx())).toThrow(BuckError);
    expect(()=>convertNode.evaluate({},{from:DISPLAY,to:LIN},ctx())).toThrow(/fehlt/);
  });
});

describe('color.look@1',()=>{
  const graph=JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8')) as BuckGraph;
  const fargo=graph.nodes.find(n=>n.type==='color.look@1');
  if(fargo?.type!=='color.look@1')throw new Error('Fixture ohne color.look@1');
  it('matches applyLook exactly for every pixel of the Fargo look (float32 storage)',()=>{
    const img=testImage(DISPLAY),out=asImage(lookNode.evaluate({image:img},fargo.params,ctx()));
    expect(out.space).toBe(DISPLAY);
    for(let i=0;i<img.data.length;i+=4){
      const ref=applyLook([img.data[i],img.data[i+1],img.data[i+2]],fargo.params.look,fargo.params.skinProtection);
      for(let c=0;c<3;c++)expect(out.data[i+c]).toBe(Math.fround(ref[c]));
      expect(out.data[i+3]).toBe(img.data[i+3]);
    }
  });
  it('is the identity for the neutral look',()=>{
    const img=testImage(DISPLAY),out=asImage(lookNode.evaluate({image:img},{space:DISPLAY,look:NEUTRAL_LOOK,skinProtection:0},ctx()));
    for(let i=0;i<img.data.length;i++)expect(out.data[i]).toBeCloseTo(img.data[i],6);
  });
  it('converts around the formula with a warning when params.space is not the display space',()=>{
    const warnings:string[]=[],img=testImage(LIN),look:LookSpec={...NEUTRAL_LOOK,saturation:-.5,key:.3};
    const p:LookParams={space:LIN,look,skinProtection:.2},out=asImage(lookNode.evaluate({image:img},p,ctx(new Map(),warnings)));
    expect(warnings).toHaveLength(1);expect(out.space).toBe(LIN);expect(alphaOf(out)).toEqual(alphaOf(img));
    const i=4*40,disp=[0,1,2].map(c=>Math.fround(Math.sign(img.data[i+c])*Math.abs(img.data[i+c])**(1/2.4))) as RGB;
    const ref=applyLook(disp,look,.2).map(v=>Math.sign(v)*Math.abs(Math.fround(v))**2.4);
    for(let c=0;c<3;c++)expect(out.data[i+c]).toBeCloseTo(ref[c],5);
  });
  it('refuses an input whose space differs from params.space',()=>{
    expect(()=>lookNode.evaluate({image:testImage(LIN)},fargo.params,ctx())).toThrow(BuckError);
  });
});

describe('color.cdl@1',()=>{
  const base:CdlParams={slope:[1.2,.9,1.1],offset:[-.05,.02,.1],power:[1.1,.95,1.3],saturation:.8,style:'v1.2_Fwd',space:DISPLAY};
  it('matches hand-derivable values',()=>{
    // (0.6*2-0.5)^2 = 0.49; saturation 0 gives Rec.709 luma in every channel.
    for(const v of cdl([.6,.6,.6],[2,2,2],[-.5,-.5,-.5],[2,2,2],1,'v1.2_Fwd'))expect(v).toBeCloseTo(.49,12);
    const y=cdl([1,0,0],[1,1,1],[0,0,0],[1,1,1],0,'noClampFwd');
    for(const v of y)expect(v).toBeCloseTo(.2126,12);
  });
  it('matches reference values (OpenColorIO CDLOpCPU semantics, computed independently in float64)',()=>{
    const a=cdl([.5,.2,.8],base.slope,base.offset,base.power,base.saturation,'v1.2_Fwd');
    [0.4815658996330807,0.2405076074564962,0.8463625592812637].forEach((v,i)=>expect(a[i]).toBeCloseTo(v,12));
    // noClampFwd: negatives bypass the power, nothing is clamped.
    const b=cdl([-.1,1.5,.3],[1,1,1],[0,0,0],[2,2,2],1.5,'noClampFwd');
    [-0.947219,2.577781,-0.662219].forEach((v,i)=>expect(b[i]).toBeCloseTo(v,12));
    // v1.2_Fwd clamps before the power and after saturation.
    expect(cdl([-.1,1.5,.3],[1,1,1],[0,0,0],[2,2,2],1.5,'v1.2_Fwd')).toEqual([0,1,0]);
  });
  it('maps NaN to 0 in both styles',()=>{
    expect(cdl([NaN,.5,.5],[1,1,1],[0,0,0],[1,1,1],1,'noClampFwd')[0]).toBeCloseTo(0,12);
    expect(cdl([NaN,.5,.5],[1,1,1],[0,0,0],[1,1,1],1,'v1.2_Fwd')[0]).toBe(0);
  });
  it('is the identity for neutral parameters in noClampFwd and keeps alpha',()=>{
    const img=testImage(DISPLAY),p:CdlParams={slope:[1,1,1],offset:[0,0,0],power:[1,1,1],saturation:1,style:'noClampFwd',space:DISPLAY};
    const out=asImage(cdlNode.evaluate({image:img},p,ctx()));
    for(let i=0;i<img.data.length;i++)expect(out.data[i]).toBeCloseTo(img.data[i],6);
    const clamped=asImage(cdlNode.evaluate({image:img},{...p,style:'v1.2_Fwd'},ctx()));
    expect(clamped.data[0]).toBe(0);expect(clamped.data[1]).toBe(1);expect(clamped.data[3]).toBeCloseTo(.7,6);
  });
  it('refuses a mismatching space',()=>{
    expect(()=>cdlNode.evaluate({image:testImage(LIN)},base,ctx())).toThrow(BuckError);
  });
});

describe('parseCube',()=>{
  const id=(r:number,g:number,b:number):RGB=>[r,g,b];
  it('reads title, comments, domain and red-fastest order',()=>{
    const text=`﻿# Input: Rec.709\nTITLE "Look # 1"\nDOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 1 1 1\n`+cubeText(2,(r,g,b)=>[r,g*2,b*3]).replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2 # Größe');
    const cube=parseCube(text);
    expect(cube.size).toBe(2);expect(cube.title).toBe('Look # 1');expect(cube.domainMin).toEqual([-1,-1,-1]);
    expect(Array.from(cube.data.slice(0,6))).toEqual([0,0,0,1,0,0]);expect(Array.from(cube.data.slice(21))).toEqual([1,2,3]);
  });
  it('accepts LUT_3D_INPUT_RANGE and CRLF line endings',()=>{
    const cube=parseCube(('LUT_3D_INPUT_RANGE 0 2\n'+cubeText(2,id)).replace(/\n/g,'\r\n'));
    expect(cube.domainMax).toEqual([2,2,2]);expect(cube.title).toBeUndefined();
  });
  const bad:[string,string,RegExp][]=[
    ['missing size','0 0 0\n',/LUT_3D_SIZE fehlt/],
    ['size too small','LUT_3D_SIZE 1\n0 0 0\n',/2 bis 256/],
    ['size too large','LUT_3D_SIZE 257\n',/2 bis 256/],
    ['non-integer size','LUT_3D_SIZE 2.0\n',/2 bis 256/],
    ['duplicate size',cubeText(2,id).replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nLUT_3D_SIZE 2'),/genau einmal/],
    ['too few rows',cubeText(2,id).split('\n').slice(0,8).join('\n'),/genau LUT_3D_SIZE³/],
    ['too many rows',cubeText(2,id)+'0 0 0\n',/mehr RGB-Zeilen/],
    ['two values',cubeText(2,id).replace('1.0000000000000000 1.0000000000000000 1.0000000000000000','1 1'),/ungültige RGB/],
    ['four values',cubeText(2,id).replace(/\n$/,' 1\n'),/ungültige RGB/],
    ['non-numeric',cubeText(2,id).replace(/\n$/,'x\n'),/ungültige RGB/],
    ['nan',cubeText(2,id).replace('0.0000000000000000 0.0000000000000000 0.0000000000000000','nan 0 0'),/ungültige RGB/],
    ['overflow',cubeText(2,id).replace('0.0000000000000000 0.0000000000000000 0.0000000000000000','1e999 0 0'),/nicht endliche/],
    ['unquoted title','TITLE Look\n'+cubeText(2,id),/Anführungszeichen/],
    ['1D lut','LUT_1D_SIZE 4\n',/1D/],
    ['late domain',cubeText(2,id).replace(/\n$/,'\nDOMAIN_MIN 0 0 0\n'),/Domain/],
    ['duplicate domain','DOMAIN_MIN 0 0 0\nDOMAIN_MIN 0 0 0\n'+cubeText(2,id),/Domain/],
    ['domain and range','DOMAIN_MIN 0 0 0\nLUT_3D_INPUT_RANGE 0 1\n'+cubeText(2,id),/INPUT_RANGE/],
    ['empty domain','DOMAIN_MIN 0 1 0\nDOMAIN_MAX 1 1 1\n'+cubeText(2,id),/positiven Bereich/],
    ['long line','# '+'x'.repeat(65536)+'\n'+cubeText(2,id),/64 KiB/],
    ['empty','',/genau LUT_3D_SIZE³/],
  ];
  for(const [name,text,msg] of bad)it(`rejects ${name}`,()=>{
    expect(()=>parseCube(text)).toThrow(BuckError);expect(()=>parseCube(text)).toThrow(msg);
  });
});

describe('color.lut3d@1',()=>{
  // Non-affine lattice: tetrahedral sampling must still hit every lattice value exactly.
  const lattice=(r:number,g:number,b:number):RGB=>[Math.sin(7*r+3*g)+b*b,r*g*b*4-1,Math.cos(5*b)*1.5+r];
  it('reproduces lattice points and corners exactly',()=>{
    const n=5,cube=parseCube(cubeText(n,lattice));
    for(let b=0;b<n;b++)for(let g=0;g<n;g++)for(let r=0;r<n;r++){
      const out=sampleParsedCube(cube,[r/(n-1),g/(n-1),b/(n-1)]),i=((b*n+g)*n+r)*3;
      for(let c=0;c<3;c++)expect(out[c]).toBe(cube.data[i+c]);
    }
    expect(sampleParsedCube(cube,[1,1,1])).toEqual(Array.from(cube.data.slice(-3)));
  });
  it('is exact for an affine cube in all six tetrahedra',()=>{
    const aff=(r:number,g:number,b:number):RGB=>[.8*r+.1*g-.05*b+.02,-.2*r+1.1*g+.3*b,.4*r-.3*g+.9*b-.1];
    const cube=parseCube(cubeText(3,aff));
    for(const p of [[.1,.25,.4],[.1,.4,.25],[.25,.1,.4],[.25,.4,.1],[.4,.1,.25],[.4,.25,.1],[.7,.7,.2],[.9,.6,.6]] as RGB[]){
      const out=sampleParsedCube(cube,p),ref=aff(...p);
      for(let c=0;c<3;c++)expect(out[c]).toBeCloseTo(ref[c],6);
    }
  });
  it('normalizes the domain, clamps outside it, leaves the output unclamped and maps NaN to the low edge',()=>{
    const cube=parseCube('DOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 3 3 3\n'+cubeText(2,(r,g,b)=>[4*r-1.5,4*g-1,4*b-1]));
    expect(sampleParsedCube(cube,[1,0,2])[0]).toBeCloseTo(.5,6);
    expect(sampleParsedCube(cube,[1,0,2])[2]).toBeCloseTo(2,6);
    expect(sampleParsedCube(cube,[9,-9,Infinity])).toEqual([2.5,-1,3]);
    expect(sampleParsedCube(cube,[NaN,0,0])[0]).toBe(-1.5);
  });
  it('renders through ctx.files with alpha passthrough, output space tag and identity accuracy',()=>{
    const img=testImage(DISPLAY),files=new Map([['luts/id.cube',bytes(cubeText(17,(r,g,b)=>[r,g,b]))]]);
    const out=asImage(lut3dNode.evaluate({image:img},{file:'luts/id.cube',inputSpace:DISPLAY,outputSpace:LIN},ctx(files)));
    expect(out.space).toBe(LIN);expect(alphaOf(out)).toEqual(alphaOf(img));
    for(let i=8;i<img.data.length;i+=4)for(let c=0;c<3;c++)expect(out.data[i+c]).toBeCloseTo(img.data[i+c],6);
    expect(Array.from(out.data.slice(0,3)).map(v=>+v.toFixed(6))).toEqual([0,1,.5]);
  });
  it('caches parsed cubes per bytes object, including failures',()=>{
    const b=bytes(cubeText(2,(r,g,b)=>[r,g,b])),broken=bytes('LUT_3D_SIZE 2\n');
    expect(cubeFromBytes(b)).toBe(cubeFromBytes(b));
    let first:unknown,second:unknown;
    try{cubeFromBytes(broken);}catch(e){first=e;}
    try{cubeFromBytes(broken);}catch(e){second=e;}
    expect(first).toBeInstanceOf(BuckError);expect(second).toBe(first);
  });
  it('fails for a missing file or a mismatching input space',()=>{
    expect(()=>lut3dNode.evaluate({image:testImage(DISPLAY)},{file:'luts/x.cube',inputSpace:DISPLAY,outputSpace:DISPLAY},ctx())).toThrow(/fehlt im Paket/);
    expect(()=>lut3dNode.evaluate({image:testImage(LIN)},{file:'luts/x.cube',inputSpace:DISPLAY,outputSpace:DISPLAY},ctx())).toThrow(BuckError);
  });
});
