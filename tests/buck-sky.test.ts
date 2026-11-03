import { describe, expect, it } from 'vitest';
import { autoHorizon, cleanSkyMask, fbm, hash3, rawSkyMask, skyMatte, skyNode, skyPresetParams, SKY_PRESET_LABELS } from '../src/buck/nodes/sky';
import { imageBuf, scalarField } from '../src/buck/field';
import { lumaWeights } from '../src/buck/colorspace';
import { promptToGraph, detectTimeOfDay } from '../src/buck/prompt';
import { checkGraph } from '../src/buck/validate';
import { missingFiles } from '../src/buck/container';
import { SKY_PRESETS } from '../src/buck/types';
import type { BuckGraph, ImageBuf, NodeOf, NodeType, RenderContext, Resolved, SkyParams, SkyPreset } from '../src/buck/types';

type P=Resolved<SkyParams>;
const ctx=(w:number,h:number):RenderContext=>({width:w,height:h,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}});
/** Upper `skyRows` rows have invalid depth (sky), the rest depth 0.3; the image is a flat grey (or `fill(x, y)`). */
function scene(w:number,h:number,skyRows:number,fill:(x:number,y:number)=>[number,number,number]=()=>[.3,.3,.3]){
  const img=imageBuf(w,h,'ACEScg'),d=scalarField(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,c=fill(x,y);img.data.set([...c,1],i*4);d.data[i]=y<skyRows?Infinity:.3;}
  return {img,d};
}
const params=(preset:SkyPreset,patch:Partial<P>={}):P=>({...skyPresetParams(preset,'ACEScg'),...patch} as P);
const run=(img:ImageBuf,d:ReturnType<typeof scalarField>,p:P)=>skyNode.evaluate({image:img,depth:d},p,ctx(img.width,img.height)) as ImageBuf;
const lum=(o:ImageBuf,i:number)=>{const w=lumaWeights('ACEScg');return w[0]*o.data[i*4]+w[1]*o.data[i*4+1]+w[2]*o.data[i*4+2];};
const meanLum=(o:ImageBuf,rows:[number,number])=>{let s=0,n=0;for(let y=rows[0];y<rows[1];y++)for(let x=0;x<o.width;x++){s+=lum(o,y*o.width+x);n++;}return s/n;};
const types=(g:BuckGraph)=>g.nodes.map(n=>n.type);
const node=<T extends NodeType>(g:BuckGraph,type:T)=>g.nodes.find((n):n is NodeOf<T>=>n.type===type);
const build=(t:string)=>{const r=promptToGraph(t);expect(checkGraph(r.graph)).toEqual([]);return r;};

describe('sky.replace@1 mask',()=>{
  it('takes invalid depth as sky and adds depths from skyDepth on',()=>{
    expect(Array.from(rawSkyMask(Float32Array.from([Infinity,NaN,.2,.9,1]),2))).toEqual([1,1,0,0,0]);
    expect(Array.from(rawSkyMask(Float32Array.from([Infinity,.2,.9,1]),.85))).toEqual([1,0,1,1]);
  });
  it('replaces only the sky; the scene under it stays bit-identical with spill 0',()=>{
    const {img,d}=scene(32,24,8),o=run(img,d,params('night',{spill:0,edge:0}));
    for(let i=8*32;i<32*24;i++)for(let c=0;c<4;c++)expect(o.data[i*4+c]).toBe(img.data[i*4+c]);
    expect(meanLum(o,[0,8])).toBeLessThan(.05);
    for(let i=0;i<32*24;i++)expect(o.data[i*4+3]).toBe(1);
  });
  it('honours skyDepth: far finite depth becomes sky only below the threshold',()=>{
    const {img,d}=scene(16,8,0);for(let i=0;i<16*4;i++)d.data[i]=.95;
    const keep=run(img,d,params('night',{spill:0,edge:0})),swap=run(img,d,params('night',{spill:0,edge:0,skyDepth:.9}));
    expect(Array.from(keep.data)).toEqual(Array.from(img.data));
    expect(lum(swap,0)).toBeLessThan(.1);expect(swap.data[16*7*4]).toBe(img.data[16*7*4]);
  });
  it('without any sky returns the input unchanged (e.g. interiors)',()=>{
    const {img,d}=scene(8,8,0);expect(Array.from(run(img,d,params('golden-hour')).data)).toEqual(Array.from(img.data));
  });
  it('keeps a narrow soft edge at the depth boundary where colors do not separate',()=>{
    const raw=rawSkyMask(scene(64,32,16).d.data,2),flat=new Float32Array(64*32*4).fill(.3),m=skyMatte(flat,raw,64,32,4/64,lumaWeights('ACEScg'));
    const col=(y:number)=>m.alpha[y*64+32];
    expect(col(15)).toBeGreaterThan(.5);expect(col(15)).toBeLessThan(1);expect(col(16)).toBeGreaterThan(0);expect(col(16)).toBeLessThan(.5);
    expect(col(2)).toBe(1);expect(col(30)).toBe(0);
    for(let y=1;y<32;y++)expect(col(y)).toBeLessThanOrEqual(col(y-1)+1e-6);
    // edge 0 is the hard (cleaned) depth mask.
    expect(Array.from(skyMatte(flat,raw,64,32,0,lumaWeights('ACEScg')).alpha)).toEqual(Array.from(raw));
  });
  it('drops sky islands below the sky (reflections in water), keeps enclosed holes above it',()=>{
    // Sky rows 0…9; an enclosed hole at rows 4…5 inside a foreground block (x 20…29, rows 2…12); a reflection at rows 20…23.
    const W=48,H=32,raw=new Float32Array(W*H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const block=x>=20&&x<30&&y>=2&&y<13,hole=x>=23&&x<26&&y>=4&&y<6;raw[y*W+x]=y<10&&!block||hole||y>=20&&y<24&&x>=5&&x<15?1:0;}
    const c=cleanSkyMask(raw,W,H);
    expect(c[4*W+24]).toBe(1);expect(c[0]).toBe(1);expect(c[21*W+8]).toBe(0);expect(c[11*W+24]).toBe(0);
  });
  it('follows the color edge, not the depth edge, when sky and scene differ (unmixing)',()=>{
    // True edge at row 18; the depth mask stops at row 15 (3 rows of old sky with finite depth = halo).
    const blue:[number,number,number]=[.3,.5,.9],brown:[number,number,number]=[.3,.2,.1];
    const {img,d}=scene(48,32,15,(_x,y)=>y<18?blue:brown),o=run(img,d,params('night',{spill:0,edge:5/48}));
    const halo=lum(o,16*48+24),sky=lum(o,4*48+24);
    expect(Math.abs(halo-sky)).toBeLessThan(.02);
    expect(Array.from(o.data.subarray((26*48+24)*4,(26*48+24)*4+3))).toEqual(Array.from(img.data.subarray((26*48+24)*4,(26*48+24)*4+3)));
  });
  it('finds the horizon at the lowest sky row',()=>{
    const {d}=scene(64,32,10);expect(autoHorizon(rawSkyMask(d.data,2),64,32)).toBeCloseTo(10/64,12);
    expect(autoHorizon(new Float32Array(64*32),64,32)).toBeCloseTo(.25,12);
  });
});

describe('sky.replace@1 determinism and resolution independence',()=>{
  it('renders bit-identically twice',()=>{
    const {img,d}=scene(40,30,20);
    for(const p of ['starry-night','storm','aurora','moonrise'] as SkyPreset[])expect(Array.from(run(img,d,params(p)).data)).toEqual(Array.from(run(img,d,params(p)).data));
  });
  it('uses pure integer hashing and value noise',()=>{
    expect(hash3(3,-7,1)).toBe(hash3(3,-7,1));expect(hash3(3,-7,1)).not.toBe(hash3(3,-7,2));
    for(let i=0;i<50;i++){const v=fbm(i*.37,i*.11,5,11);expect(v).toBeGreaterThanOrEqual(0);expect(v).toBeLessThan(1);}
  });
  it('places the same stars at the same normalized positions at half resolution',()=>{
    const p=params('starry-night',{milkyWay:0,glow:0,spill:0,edge:0,stars:1,horizonY:1});
    // A point source gets dimmer per pixel at lower resolution (same flux, larger pixels), so peaks are found relative to the brightest.
    const peaks=(w:number)=>{
      const h=w/2,{img,d}=scene(w,h,h),o=run(img,d,p),out:[number,number][]=[];
      let top=0;for(let i=0;i<w*h;i++)top=Math.max(top,lum(o,i));
      for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
        const v=lum(o,y*w+x);if(v<.25*top)continue;
        let max=true;for(let j=-1;j<=1&&max;j++)for(let i=-1;i<=1;i++)if((i||j)&&lum(o,(y+j)*w+x+i)>v){max=false;break;}
        if(max)out.push([(x+.5)/w,(y+.5)/w]);
      }
      return out;
    };
    const full=peaks(1024),half=peaks(512);
    expect(full.length).toBeGreaterThan(10);
    // Every bright star found at half resolution has a partner within 2 half-res pixels at full resolution.
    let matched=0;for(const [x,y] of half)if(full.some(([u,v])=>Math.hypot(u-x,v-y)<2/512))matched++;
    expect(matched/half.length).toBeGreaterThan(.8);
  });
});

describe('sky.replace@1 presets',()=>{
  const {img,d}=scene(48,32,16);
  const skyLum=(p:SkyPreset)=>meanLum(run(img,d,{...params(p,{spill:0,edge:0,stars:0,aurora:0}),moon:undefined}),[0,14]);
  // Moon, stars and aurora are switched off: they are bright on purpose and not part of the base sky.
  it('night skies are darker than day skies',()=>{
    for(const n of ['night','starry-night','aurora','neon-night'] as SkyPreset[])for(const day of ['clear-day','golden-hour','overcast','sandstorm'] as SkyPreset[])expect(skyLum(n)).toBeLessThan(skyLum(day)/4);
    expect(skyLum('blue-hour')).toBeLessThan(skyLum('clear-day'));expect(skyLum('twilight')).toBeLessThan(skyLum('blue-hour'));
  });
  it('golden hour is warm at the horizon, clear day blue at the zenith',()=>{
    const g=skyPresetParams('golden-hour','lin_rec709_srgb').horizon as number[],c=skyPresetParams('clear-day','lin_rec709_srgb').zenith as number[];
    expect(g[0]).toBeGreaterThan(g[2]);expect(c[2]).toBeGreaterThan(c[0]);
  });
  it('every preset is a valid parameter set with a German label',()=>{
    for(const p of SKY_PRESETS){
      expect(SKY_PRESET_LABELS[p].label.length).toBeGreaterThan(2);
      const g=promptToGraph('Nebel').graph;
      g.nodes.splice(1,0,{id:'sky',type:'sky.replace@1',inputs:{image:g.nodes[0].id,depth:'$depth'},params:skyPresetParams(p,'ACEScg')});
      g.nodes[2]={...g.nodes[2],inputs:{...g.nodes[2].inputs,image:'sky'}};
      expect(checkGraph(g),p).toEqual([]);
    }
  });
});

describe('sky.replace@1 validation',()=>{
  const graph=(patch:Record<string,unknown>)=>{
    const g=build('Nacht').graph,n=node(g,'sky.replace@1')!;
    (n as unknown as {params:Record<string,unknown>}).params={...n.params,...patch};return g;
  };
  it('accepts the prompt graph and rejects wrong values',()=>{
    expect(checkGraph(graph({}))).toEqual([]);
    expect(checkGraph(graph({stars:1.5})).join()).toMatch(/stars/);
    expect(checkGraph(graph({preset:'sunny'})).join()).toMatch(/preset/);
    expect(checkGraph(graph({moon:{x:.5,height:.1,radius:.5,intensity:1}})).join()).toMatch(/moon\.radius/);
    expect(checkGraph(graph({moon:{x:.5,height:.1,radius:.02}})).join()).toMatch(/intensity/);
    expect(checkGraph(graph({source:'image'})).join()).toMatch(/file/);
    expect(checkGraph(graph({source:'image',file:'masks/a.png'})).join()).toMatch(/skies/);
    expect(checkGraph(graph({source:'image',file:'skies/abend.png'}))).toEqual([]);
    expect(checkGraph(graph({edge:.2})).join()).toMatch(/edge/);
  });
  it('lists a missing sky image as missing file',()=>{
    expect(missingFiles(graph({source:'image',file:'skies/abend.png'}),new Map())).toEqual(['skies/abend.png']);
  });
});

describe('time of day in the prompt',()=>{
  it('detects German and English phrases',()=>{
    const cases:[string,SkyPreset][]=[['Nacht','night'],['nachts am Strand','night'],['day for night','night'],['Sonnenuntergang','golden-hour'],['golden hour','golden-hour'],
      ['zur blauen Stunde','blue-hour'],['Dämmerung','blue-hour'],['bewölkt','overcast'],['Sternenhimmel','starry-night'],['Sandsturm, Dune-Look','sandstorm'],
      ['Gewitterhimmel','storm'],['Polarlicht','aurora'],['Mondaufgang','moonrise'],['Neon-Nacht','neon-night'],['Zwielicht','twilight'],['sunset','golden-hour']];
    for(const [t,p] of cases)expect(detectTimeOfDay(t).preset,t).toBe(p);
    expect(detectTimeOfDay('Fargo-Look').preset).toBeUndefined();
    expect(detectTimeOfDay('Moonlight').preset).toBeUndefined();
    expect(detectTimeOfDay('Himmel ersetzen').preset).toBe('clear-day');
    expect(detectTimeOfDay('Fargo-Look bei Nacht, Nebel im Hintergrund').rest).toBe('Fargo-Look, Nebel im Hintergrund');
  });
  it('"Nacht" gives sky.replace, a night grade, day-for-night exposure and moonlight',()=>{
    const {graph,understood}=build('Nacht');
    expect(types(graph)).toEqual(['color.convert@1','color.cdl@1','mask.depthRange@1','light.relight@1','sky.replace@1','color.convert@1','color.look@1']);
    expect(node(graph,'sky.replace@1')!.params.preset).toBe('night');
    const look=node(graph,'color.look@1')!.params.look;
    expect(look.key).toBeLessThan(0);expect(look.saturation).toBeLessThanOrEqual(-.35);expect(look.shadows[2]).toBeGreaterThan(look.shadows[0]);
    expect(node(graph,'color.cdl@1')!.params.slope.every(v=>v<.5)).toBe(true);
    expect(understood[0]).toBe('Tageszeit · Nacht · Himmel ersetzt');
    expect(understood.some(u=>u.startsWith('Mondlicht'))).toBe(true);
    expect(graph.inputs.depth.kind).toBe('depth');expect(graph.inputs.normals.kind).toBe('normals');
  });
  it('"Fargo-Look bei Nacht, Nebel im Hintergrund" keeps Fargo as base and orders relight → sky → fog → look',()=>{
    const {graph,understood}=build('Fargo-Look bei Nacht, Nebel im Hintergrund'),order=types(graph);
    expect(order.indexOf('light.relight@1')).toBeLessThan(order.indexOf('sky.replace@1'));
    expect(order.indexOf('sky.replace@1')).toBeLessThan(order.indexOf('atmos.fog@1'));
    expect(order.indexOf('atmos.fog@1')).toBeLessThan(order.indexOf('color.look@1'));
    // The time-of-day grade is its own node (id "tod-grade") before the named look, which stays unchanged.
    const look=graph.nodes.find((n):n is NodeOf<'color.look@1'>=>n.type==='color.look@1'&&!n.id.startsWith('tod-'))!,grade=node(graph,'color.look@1')!;
    expect(look.label).toMatch(/Fargo/);expect(look.params.prompt).toBe('Fargo-Look');
    expect(look.params.look.whiteClean).toBe(.8);expect(grade.id).toBe('tod-grade');expect(grade.params.look.key).toBeLessThan(0);
    expect(order.indexOf('color.look@1')).toBe(order.lastIndexOf('color.look@1')-1);
    const fog=node(graph,'atmos.fog@1')!;expect(fog.params.luminance).toBeLessThan(0);expect(fog.inputs.mask).toBe('bgMask');
    expect(understood).toContain('Tageszeit · Nacht · Himmel ersetzt');expect(understood.some(u=>u.startsWith('Basis: Fargo'))).toBe(true);
  });
  it('"Sonnenuntergang" → golden hour with warm grade and low warm light',()=>{
    const {graph}=build('Sonnenuntergang');
    expect(node(graph,'sky.replace@1')!.params.preset).toBe('golden-hour');
    expect(node(graph,'light.relight@1')!.params.color).toEqual({kelvin:2800});
    expect(node(graph,'color.look@1')!.params.look.highlights[0]).toBeGreaterThan(0);
    expect(node(graph,'color.cdl@1')).toBeUndefined();
  });
  it('covers the further sky prompts',()=>{
    const cases:[string,SkyPreset][]=[['Dune-Look bei Nacht','night'],['Sternenhimmel','starry-night'],['Sandsturm, Dune-Look','sandstorm'],['Gewitterhimmel','storm'],['Polarlicht','aurora'],['Mondaufgang','moonrise'],['Neon-Nacht','neon-night']];
    for(const [t,p] of cases){const {graph}=build(t);expect(node(graph,'sky.replace@1')!.params.preset,t).toBe(p);}
    const sand=build('Sandsturm, Dune-Look').graph,fog=node(sand,'atmos.fog@1')!;
    expect(fog.params.density).toBeGreaterThan(3);expect(fog.inputs.mask).toBeUndefined();
    expect(sand.nodes.find(n=>n.type==='color.look@1'&&!n.id.startsWith('tod-'))!.label).toMatch(/Dune/);
    expect(node(build('Sternenhimmel').graph,'light.relight@1')).toBeUndefined();
  });
  it('an explicit light replaces the automatic moonlight; "Mondlicht von links" stays a relight',()=>{
    const {graph}=build('Nacht, warmes Licht von links');
    expect(graph.nodes.filter(n=>n.type==='light.relight@1')).toHaveLength(1);
    expect(node(graph,'light.relight@1')!.params.azimuth).toBe(-70);
    const moon=build('kaltes Mondlicht von links').graph;
    expect(node(moon,'sky.replace@1')!.params.preset).toBe('night');expect(node(moon,'light.relight@1')!.params.azimuth).toBe(-70);
  });
});
