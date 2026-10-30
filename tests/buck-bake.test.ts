import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyLook, NEUTRAL_LOOK } from '../src/color/look';
import type { RGB } from '../src/color/spaces';
import { bakeColorCube, bakeLookCube, cubeGrid, serializeBuckCube } from '../src/buck/bake';
import { parseCube } from '../src/buck/nodes/color';
import { BuckError, OFX_CONFIG } from '../src/buck/types';
import type { BuckGraph, BuckNode, LookParams, NodeOf, SpaceName } from '../src/buck/types';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8')) as BuckGraph;
const DISPLAY:SpaceName='Rec.1886 Rec.709 - Display';
function graph(nodes:BuckNode[],output:string,cm?:Partial<BuckGraph['colorManagement']>):BuckGraph {
  return {format:'buck',formatVersion:'1.0',minReaderVersion:'1.0',meta:{name:'Test'},
    colorManagement:{config:OFX_CONFIG,input:DISPLAY,output:DISPLAY,working:{linear:'ACEScg',display:DISPLAY},...cm},
    inputs:{depth:{kind:'depth',semantics:'relative-inverse',required:true,sources:[{type:'cache'}],onMissing:'fail'}},models:{},nodes,output};
}
const convert=(id:string,image:string,from:SpaceName,to:SpaceName):NodeOf<'color.convert@1'>=>({id,type:'color.convert@1',inputs:{image},params:{from,to}});
const fog=(id:string,image:string):NodeOf<'atmos.fog@1'>=>({id,type:'atmos.fog@1',inputs:{image,depth:'$depth'},params:{model:'exponential',start:.2,density:3,color:[.8,.85,.9],luminance:1,maxOpacity:.9,skyProtect:0}});
const cdl=(id:string,image:string,mask?:string):NodeOf<'color.cdl@1'>=>({id,type:'color.cdl@1',inputs:mask?{image,mask}:{image},params:{slope:[1.2,1,.8],offset:[.02,0,-.01],power:[1,1.1,1],saturation:.9,style:'v1.2_Fwd',space:DISPLAY}});
const gradient=(id:string):NodeOf<'mask.gradient@1'>=>({id,type:'mask.gradient@1',inputs:{},params:{shape:'linear',start:[0,0],end:[1,0],feather:.1,invert:false}});
const gridPoint=(i:number,n:number):RGB=>[i%n/(n-1),Math.floor(i/n)%n/(n-1),Math.floor(i/(n*n))/(n-1)];
const decode=(v:number)=>Math.sign(v)*Math.abs(v)**2.4;
const maxDiff=(a:Float32Array,b:ArrayLike<number>)=>{let m=0;for(let i=0;i<a.length;i++)m=Math.max(m,Math.abs(a[i]-b[i]));return m;};
const identity=(n:number)=>{const d=new Float32Array(n**3*3);for(let i=0;i<n**3;i++)d.set(gridPoint(i,n),i*3);return d;};

describe('cubeGrid', () => {
  it('lays the grid out in cube row order with red fastest', () => {
    const g=cubeGrid(3,DISPLAY);
    expect([g.width,g.height,g.space]).toEqual([9,3,DISPLAY]);
    expect(Array.from(g.data.slice(4,8))).toEqual([.5,0,0,1]);
    expect(Array.from(g.data.slice(12,16))).toEqual([0,.5,0,1]);
    expect(Array.from(g.data.slice(9*4,9*4+4))).toEqual([0,0,.5,1]);
    expect(()=>cubeGrid(1,DISPLAY)).toThrow(BuckError);
    expect(()=>cubeGrid(257,DISPLAY)).toThrow(BuckError);
    expect(()=>cubeGrid(16.5,DISPLAY)).toThrow(BuckError);
  });
});

describe('bakeColorCube', () => {
  it('bakes an identity graph to the identity cube', () => {
    const r=bakeColorCube(graph([],'$source'),new Map(),9);
    expect(r.data).toEqual(identity(9));
    expect([r.covers,r.omits]).toEqual([[],[]]);
  });
  it('keeps converting round trips within 1e-5 and bypasses spatial nodes without aux', () => {
    for(const mid of ['lin_rec709_srgb','sRGB - Display','ACEScg','ACES2065-1'] as const){
      const g=graph([convert('in',`$source`,DISPLAY,mid),fog('fog','in'),convert('out','fog',mid,DISPLAY)],'out');
      if(mid==='sRGB - Display')g.nodes=[convert('in','$source',DISPLAY,mid),convert('out','in',mid,DISPLAY)];
      const r=bakeColorCube(g,new Map(),17),id=identity(17);
      expect(r.covers).toEqual(['in','out']);
      expect(r.omits).toEqual(mid==='sRGB - Display'?[]:['fog']);
      for(let i=0;i<id.length;i++){
        // The pure 2.4 encode has infinite slope at 0, so float32 rounding in the linear buffer (~1e-8) shows up as
        // ~1e-3 at exact-zero channels; in linear display light the round trip stays within 1e-6 everywhere.
        if(id[i]>0)expect(Math.abs(r.data[i]-id[i])).toBeLessThan(1e-5);
        expect(Math.abs(decode(r.data[i])-decode(id[i]))).toBeLessThan(1e-6);
      }
    }
  });
  it('bakes the fixture to applyLook at every grid point and lists covers/omits like its fallback', () => {
    const g=fixture(),n=17,r=bakeColorCube(g,new Map(),n),look=g.nodes.find(x=>x.id==='fargo') as NodeOf<'color.look@1'>;
    expect(r.covers).toEqual(['toLinear','toDisplay','fargo']);
    expect(r.omits).toEqual(g.fallback?.omits);
    let max=0,sum=0,maxInterior=0;
    for(let i=0;i<n**3;i++){
      const p=gridPoint(i,n),want=applyLook(p,look.params.look,look.params.skinProtection),interior=p.every(v=>v>0);
      for(let c=0;c<3;c++){const d=Math.abs(r.data[i*3+c]-want[c]);max=Math.max(max,d);sum+=d;if(interior)maxInterior=Math.max(maxInterior,d);}
    }
    expect(maxInterior).toBeLessThan(1e-5);
    // Grid points with a zero channel carry the ACEScg round-trip error above; still inside class A' (spec §7.2).
    expect(max).toBeLessThan(2/1023);
    expect(sum/(n**3*3)).toBeLessThan(1e-4);
    // The look node alone gives the same cube up to that round trip.
    expect(maxDiff(r.data,bakeLookCube(look.params,n))).toBeLessThan(2/1023);
  });
  it('omits masked color nodes, ignores disabled and unreachable ones, and never reads aux', () => {
    const disabled={...cdl('off','masked'),enabled:false};
    const g=graph([gradient('grad'),cdl('masked','$source','grad'),disabled,cdl('plain','off'),cdl('dead','$source'),fog('fog','plain')],'fog');
    const r=bakeColorCube(g,new Map(),5),only=bakeColorCube(graph([cdl('plain','$source')],'plain'),new Map(),5);
    expect(r.covers).toEqual(['plain']);
    expect(r.omits).toEqual(['masked','fog']);
    expect(r.data).toEqual(only.data);
    expect(maxDiff(r.data,identity(5))).toBeGreaterThan(.01);
  });
  it('is deterministic', () => {
    const g=fixture();
    expect(bakeColorCube(g,new Map(),9).data).toEqual(bakeColorCube(g,new Map(),9).data);
  });
  it('reproduces an embedded lut3d through serialize and parse', () => {
    const lp:LookParams={space:DISPLAY,look:{...NEUTRAL_LOOK,shadows:[.02,0,-.03],contrast:.3,saturation:-.2},skinProtection:.5};
    const n=9,data=bakeLookCube(lp,n),text=serializeBuckCube(data,n,'Test',DISPLAY,DISPLAY);
    const files=new Map([['luts/test.cube',new TextEncoder().encode(text)]]);
    const node:NodeOf<'color.lut3d@1'>={id:'lut',type:'color.lut3d@1',inputs:{image:'$source'},params:{file:'luts/test.cube',inputSpace:DISPLAY,outputSpace:DISPLAY}};
    const r=bakeColorCube(graph([node],'lut'),files,n);
    expect(r.covers).toEqual(['lut']);
    expect(maxDiff(r.data,data)).toBeLessThan(1e-7);
  });
  it('refuses graphs whose color part ends outside the declared output space', () => {
    expect(()=>bakeColorCube(graph([convert('lin','$source',DISPLAY,'ACEScg')],'lin'),new Map(),5)).toThrow(/color\.convert@1/);
    expect(()=>bakeColorCube(graph([],'$source'),new Map(),300)).toThrow(BuckError);
  });
});

describe('bakeLookCube', () => {
  it('equals applyLook per (float32) grid point in Rec.1886', () => {
    const lp:LookParams={space:DISPLAY,look:{...NEUTRAL_LOOK,midtones:[.01,0,-.01],key:.3,whiteClean:.5,skinHue:.4},skinProtection:.7},n=11,d=bakeLookCube(lp,n);
    expect(d.length).toBe(n**3*3);
    for(let i=0;i<n**3;i++){const want=Float32Array.from(applyLook(gridPoint(i,n).map(Math.fround) as RGB,lp.look,lp.skinProtection));expect(Array.from(d.slice(i*3,i*3+3))).toEqual(Array.from(want));}
  });
  it('bakes in the declared space of the node', () => {
    const lp:LookParams={space:'sRGB - Display',look:{...NEUTRAL_LOOK,contrast:.4},skinProtection:0};
    expect(maxDiff(bakeLookCube(lp,9),bakeLookCube({...lp,space:DISPLAY},9))).toBeGreaterThan(1e-3);
    expect(()=>bakeLookCube({...lp,space:'Log' as SpaceName},9)).toThrow(BuckError);
  });
});

describe('serializeBuckCube', () => {
  it('writes an Iridas cube with OFX space names that parseCube reads back', () => {
    const n=5,data=bakeLookCube({space:DISPLAY,look:{...NEUTRAL_LOOK,saturation:.3},skinProtection:0},n);
    const text=serializeBuckCube(data,n,'Fargo "Winter"\n#1',DISPLAY,'ACEScg'),lines=text.split('\n');
    expect(lines.slice(0,4)).toEqual(['TITLE "Fargo  Winter  #1"','# Buckswood .buck fallback',`# Input: ${DISPLAY}`,'# Output: ACEScg']);
    expect(lines).toContain('LUT_3D_SIZE 5');
    expect(lines).toContain('DOMAIN_MIN 0.0 0.0 0.0');
    expect(lines).toContain('DOMAIN_MAX 1.0 1.0 1.0');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines.filter(l=>/^-?\d+\.\d{9} -?\d+\.\d{9} -?\d+\.\d{9}$/.test(l))).toHaveLength(n**3);
    const parsed=parseCube(text);
    expect([parsed.size,parsed.title]).toEqual([n,'Fargo  Winter  #1']);
    expect(maxDiff(parsed.data,data)).toBeLessThan(1e-7);
  });
  it('falls back to a default title and rejects invalid data', () => {
    const id=identity(2);
    expect(serializeBuckCube(id,2,' \r\n ',DISPLAY,DISPLAY).split('\n')[0]).toBe('TITLE "Buckswood Look"');
    expect(serializeBuckCube(id,2,'x'.repeat(300),DISPLAY,DISPLAY).split('\n')[0]).toBe(`TITLE "${'x'.repeat(100)}"`);
    expect(()=>serializeBuckCube(id,3,'t',DISPLAY,DISPLAY)).toThrow(BuckError);
    expect(()=>serializeBuckCube(id,2,'t','Rec.2020' as SpaceName,DISPLAY)).toThrow(BuckError);
    const bad=new Float32Array(id);bad[5]=NaN;
    expect(()=>serializeBuckCube(bad,2,'t',DISPLAY,DISPLAY)).toThrow(/endlich/);
    bad[5]=Infinity;
    expect(()=>serializeBuckCube(bad,2,'t',DISPLAY,DISPLAY)).toThrow(BuckError);
  });
});
