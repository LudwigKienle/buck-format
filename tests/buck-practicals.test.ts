import { describe, expect, it } from 'vitest';
import { detectPracticals, practicalsNode } from '../src/buck/nodes/practicals';
import { imageBuf, scalarField } from '../src/buck/field';
import { lumaWeights } from '../src/buck/colorspace';
import { promptToGraph } from '../src/buck/prompt';
import { checkGraph } from '../src/buck/validate';
import { defaultNode } from '../src/buck/editor/chain';
import type { BuckGraph, ImageBuf, NodeOf, NodeType, PracticalsParams, RenderContext, Resolved } from '../src/buck/types';

type P=Resolved<PracticalsParams>;
const base=defaultNode('light.practicals@1','p').params as P;
const ctx=(w:number,h:number):RenderContext=>({width:w,height:h,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}});
const wt=lumaWeights('ACEScg');
/** Dark room (0.05) with one bright warm lamp disc of radius r (image widths) at (cx, cy), optional big bright window on the left. */
function room(w:number,h:number,lamp={cx:.6,cy:.2,r:.012},window=false){
  const img=imageBuf(w,h,'ACEScg');
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const u=(x+.5)/w,v=(y+.5)/w,i=(y*w+x)*4,inLamp=Math.hypot(u-lamp.cx,v-lamp.cy)<lamp.r,inWin=window&&u<.3;
    img.data.set(inLamp?[3,2,1,1]:inWin?[2,2,2,1]:[.05,.05,.05,1],i);
  }
  return img;
}
const run=(img:ImageBuf,p:Partial<P>={},extra:Record<string,unknown>={})=>practicalsNode.evaluate({image:img,...extra} as never,{...base,...p},ctx(img.width,img.height)) as ImageBuf;
const Y=(o:ImageBuf,i:number)=>wt[0]*o.data[i*4]+wt[1]*o.data[i*4+1]+wt[2]*o.data[i*4+2];
const lumField=(img:ImageBuf)=>{const n=img.width*img.height,y=new Float32Array(n);for(let i=0;i<n;i++)y[i]=Y(img,i);return y;};
const at=(img:ImageBuf,u:number,v:number)=>Math.floor(v*img.width)*img.width+Math.floor(u*img.width);
const types=(g:BuckGraph)=>g.nodes.map(n=>n.type);
const node=<T extends NodeType>(g:BuckGraph,type:T)=>g.nodes.find((n):n is NodeOf<T>=>n.type===type);
const build=(t:string)=>{const r=promptToGraph(t);expect(checkGraph(r.graph)).toEqual([]);return r;};

describe('light.practicals@1 detection',()=>{
  it('finds a compact bright lamp and ignores a large bright window',()=>{
    const img=room(256,144,undefined,true),m=detectPracticals(lumField(img),256,144,base);
    expect(m[at(img,.6,.2)]).toBeGreaterThan(.9);
    expect(m[at(img,.1,.2)]).toBe(0);
    expect(m[at(img,.45,.4)]).toBe(0);
  });
  it('drops sources outside the size band',()=>{
    const img=room(256,144,{cx:.6,cy:.2,r:.012}),y=lumField(img);
    expect(detectPracticals(y,256,144,{...base,maxSize:.005})[at(img,.6,.2)]).toBe(0);
    expect(detectPracticals(y,256,144,{...base,minSize:.02})[at(img,.6,.2)]).toBe(0);
  });
  it('is resolution independent (same lamp found at the same normalized place)',()=>{
    for(const w of [128,256,512]){
      const img=room(w,w*9/16),m=detectPracticals(lumField(img),w,w*9/16,base);
      expect(m[at(img,.6,.2)],String(w)).toBeGreaterThan(.9);expect(m[at(img,.6,.3)],String(w)).toBe(0);
    }
  });
});

describe('light.practicals@1 rendering',()=>{
  it('intensity 0 without recolor and points is the identity',()=>{
    const img=room(96,54),o=run(img,{intensity:0,recolor:0});
    expect(Array.from(o.data)).toEqual(Array.from(img.data));
  });
  it('recoloring keeps the luminance of the source pixels',()=>{
    const img=room(128,72),o=run(img,{intensity:0,recolor:1,color:[0,.8,.75]}),i=at(img,.6,.2);
    expect(Y(o,i)).toBeCloseTo(Y(img,i),5);
    expect(o.data[i*4+1]).toBeGreaterThan(o.data[i*4]);
  });
  it('lights the lamp, its glow and the room around it, falling off with distance',()=>{
    const img=room(128,72),o=run(img),near=at(img,.6,.26),far=at(img,.95,.5);
    expect(Y(o,at(img,.6,.2))).toBeGreaterThan(Y(img,at(img,.6,.2)));
    expect(Y(o,near)).toBeGreaterThan(Y(img,near)*1.2);
    expect(Y(o,near)-Y(img,near)).toBeGreaterThan(Y(o,far)-Y(img,far));
  });
  it('is deterministic and keeps alpha',()=>{
    const img=room(96,54);expect(Array.from(run(img).data)).toEqual(Array.from(run(img).data));
    const o=run(img);for(let i=3;i<o.data.length;i+=4)expect(o.data[i]).toBe(1);
  });
  it('depth similarity keeps the light off surfaces at another depth',()=>{
    const img=room(128,72),d=scalarField(128,72);for(let i=0;i<d.data.length;i++)d.data[i]=(i%128)<96?.3:.95;
    const o=run(img,{},{depth:d}),plain=run(img),p=at(img,.85,.25);
    expect(Y(o,p)-Y(img,p)).toBeLessThan((Y(plain,p)-Y(img,p))*.5);
  });
  it('manual points add a lamp where none is detected; more than 8 points are refused',()=>{
    const img=room(96,54,{cx:2,cy:2,r:.01}),o=run(img,{points:[{x:.3,y:.2,radius:.02,intensity:3}]});
    expect(Y(o,at(img,.3,.2))).toBeGreaterThan(1);
    expect(()=>run(img,{points:Array.from({length:9},()=>({x:.5,y:.2,radius:.01,intensity:1}))})).toThrow(/8/);
  });
  it('an image without lamps stays unchanged',()=>{
    const img=room(96,54,{cx:2,cy:2,r:.01});expect(Array.from(run(img).data)).toEqual(Array.from(img.data));
  });
});

describe('light.practicals@1 validation and prompt',()=>{
  const graph=(patch:Record<string,unknown>)=>{
    const g=build('Lampen leuchten').graph,n=node(g,'light.practicals@1')!;
    (n as unknown as {params:Record<string,unknown>}).params={...n.params,...patch};return g;
  };
  it('rejects wrong values',()=>{
    expect(checkGraph(graph({}))).toEqual([]);
    expect(checkGraph(graph({recolor:2})).join()).toMatch(/recolor/);
    expect(checkGraph(graph({minSize:.05,maxSize:.01})).join()).toMatch(/minSize/);
    expect(checkGraph(graph({points:Array.from({length:9},()=>({x:.5,y:.2,radius:.01,intensity:1}))})).join()).toMatch(/höchstens 8/);
    expect(checkGraph(graph({points:[{x:.5,y:.2,radius:.01}]})).join()).toMatch(/intensity/);
    expect(checkGraph(graph({points:[{x:.5,y:.2,radius:.01,intensity:1,color:{kelvin:2700}}]}))).toEqual([]);
  });
  it('understands lamp prompts in German and English',()=>{
    const cases:[string,string][]=[['Lampen an','warm 2700 K'],['Lichter an','warm 2700 K'],['Praktikabel leuchten','warm 2700 K'],['warmes Lampenlicht','warm 2700 K'],
      ['Kerzenlicht','Kerzenlicht 1900 K'],['kaltes Neonlicht','kalt 6500 K'],['Lampen in Türkis','Türkis'],['Lampen in Rot','Rot'],['Lampen blau','Blau'],
      ['lamps on','warm 2700 K'],['glowing lamps','warm 2700 K'],['practical lights','warm 2700 K']];
    for(const [t,label] of cases){
      const {graph,understood}=build(t);
      expect(types(graph),t).toEqual(['color.convert@1','light.practicals@1','color.convert@1']);
      expect(understood,t).toContain(`Lampen leuchten · ${label}`);
    }
    const teal=node(build('Lampen in Türkis').graph,'light.practicals@1')!;
    expect(teal.params.recolor).toBeGreaterThan(.8);expect(Array.isArray(teal.params.color)).toBe(true);
    expect(types(build('Neon-Look').graph)).toEqual(['color.look@1']);
  });
  it('"Nacht, Lampen leuchten warm": night grade, practicals before the sky, threshold follows the night exposure',()=>{
    const {graph,understood}=build('Nacht, Lampen leuchten warm'),t=types(graph);
    expect(t.indexOf('color.cdl@1')).toBeLessThan(t.indexOf('light.practicals@1'));
    expect(t.indexOf('light.relight@1')).toBeLessThan(t.indexOf('light.practicals@1'));
    expect(t.indexOf('light.practicals@1')).toBeLessThan(t.indexOf('sky.replace@1'));
    const p=node(graph,'light.practicals@1')!;
    expect(p.params.color).toEqual({kelvin:2700});expect(p.params.threshold).toBeLessThan(.3);expect(p.inputs.depth).toBe('$depth');
    expect(understood).toContain('Lampen leuchten · warm 2700 K');expect(understood[0]).toBe('Tageszeit · Nacht · Himmel ersetzt');
  });
});
