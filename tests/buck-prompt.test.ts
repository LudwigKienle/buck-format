import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BuckGraph, BuckNode, NodeOf, NodeType } from '../src/buck/types';
import { emptyGraph, promptToGraph } from '../src/buck/prompt';
import { checkGraph, parseGraph } from '../src/buck/validate';
import { parseLookPrompt } from '../src/color/prompt';
import { DEFAULT_DEPTH_MODEL, KNOWN_MODELS } from '../src/buck/depth/models';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8')) as BuckGraph;
const types=(g:BuckGraph)=>g.nodes.map(n=>n.type);
const node=<T extends NodeType>(g:BuckGraph,type:T)=>g.nodes.find((n):n is NodeOf<T>=>n.type===type);
const nodesOf=<T extends NodeType>(g:BuckGraph,type:T)=>g.nodes.filter((n):n is NodeOf<T>=>n.type===type);
const build=(text:string,base?:BuckGraph)=>{const r=promptToGraph(text,base);expect(checkGraph(r.graph)).toEqual([]);return r;};
/** The node feeding `port` of `n`, so wiring can be compared independent of ids. */
const feed=(g:BuckGraph,n:BuckNode,port:string)=>{const ref=n.inputs[port];return ref?.startsWith('$')?ref:g.nodes.find(x=>x.id===ref)?.type;};

describe('promptToGraph – §13 example', ()=>{
  const prompt='Fargo-Look, Nebel im Hintergrund, warmes Licht von links';
  const {graph,understood}=build(prompt);
  it('matches the fixture structure (types, order, wiring)', ()=>{
    expect(types(graph)).toEqual(types(fixture));
    expect(graph.nodes[0].id).toBe('auto-toLinear');
    expect(graph.nodes[5].id).toBe('auto-toDisplay');
    graph.nodes.forEach((n,i)=>{
      const f=fixture.nodes[i];
      expect(Object.keys(n.inputs).sort()).toEqual(Object.keys(f.inputs).sort());
      for(const port of Object.keys(f.inputs))expect(feed(graph,n,port)).toBe(feed(fixture,f,port));
    });
    expect(node(graph,'color.look@1')!.id).toBe(graph.output);
    expect(graph.colorManagement).toEqual(fixture.colorManagement);
  });
  it('uses the fixture parameters for convert, masks, relight and fog', ()=>{
    for(const i of [0,1,2,3,4,5])expect(graph.nodes[i].params).toEqual(fixture.nodes[i].params);
  });
  it('look values equal parseLookPrompt of the remaining text', ()=>{
    const look=node(graph,'color.look@1')!,ref=parseLookPrompt('Fargo-Look');
    expect(look.params.look).toEqual(ref.look);
    expect(look.params.prompt).toBe('Fargo-Look');
    expect(look.params.understood).toEqual(ref.understood);
    expect(look.params.skinProtection).toBe(.6);
    expect(look.label).toBe('Fargo · kalte Winterpalette, sauberes Schnee-Weiß');
    const f=node(fixture,'color.look@1')!.params.look;
    for(const k of ['shadows','midtones','highlights'] as const)look.params.look[k].forEach((v,i)=>expect(v).toBeCloseTo(f[k][i],6));
    expect({...look.params.look,shadows:0,midtones:0,highlights:0}).toEqual({...f,shadows:0,midtones:0,highlights:0});
  });
  it('declares depth and normals like the fixture with the default model pin', ()=>{
    const id=DEFAULT_DEPTH_MODEL;
    expect(graph.models).toEqual({[id]:KNOWN_MODELS[id]});
    const depth=structuredClone(fixture.inputs.depth);depth.sources[2]={type:'estimate',model:id};depth.semantics=KNOWN_MODELS[id].output;
    expect(graph.inputs).toEqual({depth,normals:fixture.inputs.normals});
  });
  it('meta and understood chips', ()=>{
    expect(graph.meta.prompt).toBe(prompt);
    expect(graph.meta.name).toBe(prompt);
    expect(graph.meta.created).toBeUndefined();
    expect(understood).toEqual(['Basis: Fargo · kalte Winterpalette, sauberes Schnee-Weiß','Licht · von links · warm 3200 K','Nebel · im Hintergrund']);
  });
  it('is deterministic and parses through the strict reader', ()=>{
    expect(JSON.stringify(promptToGraph(prompt).graph)).toBe(JSON.stringify(graph));
    expect(parseGraph(JSON.stringify(graph))).toEqual(graph);
  });
});

describe('promptToGraph – variants', ()=>{
  it('English wording gives the same graph structure', ()=>{
    const en=build('Fargo look, fog in the background, warm light from the left').graph,de=build('Fargo-Look, Nebel im Hintergrund, warmes Licht von links').graph;
    expect(types(en)).toEqual(types(de));
    expect(node(en,'light.relight@1')!.params).toEqual(node(de,'light.relight@1')!.params);
    expect(node(en,'atmos.fog@1')!.params).toEqual(node(de,'atmos.fog@1')!.params);
  });
  it('connectors and fog everywhere: no mask, start 0', ()=>{
    const {graph}=build('Matrix mit dichtem Nebel überall und kaltem Licht von rechts oben');
    const fog=node(graph,'atmos.fog@1')!,light=node(graph,'light.relight@1')!;
    expect(fog.inputs.mask).toBeUndefined();
    expect(fog.params).toMatchObject({start:0,density:4.4,maxOpacity:.9});
    expect(light.params).toMatchObject({azimuth:70,elevation:60,color:{kelvin:7500}});
    expect(node(graph,'color.look@1')!.params.look).toEqual(parseLookPrompt('Matrix').look);
  });
  it('fog color words and Kelvin', ()=>{
    expect(node(build('leichter blaugrauer Dunst').graph,'atmos.fog@1')!.params).toMatchObject({color:[.78,.84,.92],density:1.1,maxOpacity:.5});
    expect(node(build('warmer Nebel hinten').graph,'atmos.fog@1')!.params).toMatchObject({color:{kelvin:3200},start:.55});
    expect(node(build('haze 9000K').graph,'atmos.fog@1')!.params.color).toEqual({kelvin:9000});
    expect(node(build('light grey mist').graph,'atmos.fog@1')!.params).toMatchObject({density:1.1});
    const grey=node(build('neutraler Nebel').graph,'atmos.fog@1')!.params.color as number[];
    expect(grey[0]).toBe(grey[1]);expect(grey[1]).toBe(grey[2]);expect(grey[0]).toBeCloseTo(.83,2);
  });
  it('modifier-only clauses attach to the neighbouring effect', ()=>{
    expect(node(build('Nebel hinten, dicht').graph,'atmos.fog@1')!.params).toMatchObject({density:4.4,start:.55});
    const g=build('Nebel hinten, hartes, warmes Licht von links').graph;
    expect(node(g,'light.relight@1')!.params).toMatchObject({softness:.15,color:{kelvin:3200}});
    expect(node(g,'atmos.fog@1')!.params.density).toBe(2.2);
    expect(node(build('Fargo, leicht').graph,'color.look@1')!.params.look).toEqual(parseLookPrompt('Fargo, leicht').look);
  });
  it('fog only: depth but no normals, conversions back to display, no look', ()=>{
    const {graph}=build('Nebel im Hintergrund');
    expect(types(graph)).toEqual(['color.convert@1','mask.depthRange@1','atmos.fog@1','color.convert@1']);
    expect(graph.output).toBe('auto-toDisplay');
    expect(Object.keys(graph.inputs)).toEqual(['depth']);
  });
  it('depth of field: background blur, f-number and blades', ()=>{
    const {graph,understood}=build('Hintergrund unscharf, f/1.4, Bokeh mit 6 Lamellen');
    const dof=node(graph,'lens.dof@1')!;
    expect(dof.params).toMatchObject({mode:'artistic',focus:.2,blurNear:0,blades:6});
    // Thin lens, 50 mm / 36 mm sensor / focus 2 m, background at infinity: f²/(N(s−f))/36.
    expect(dof.params.blurFar).toBeCloseTo(2500/(1.4*1950*36),4);
    expect(dof.params.maxBlur).toBeGreaterThanOrEqual(dof.params.blurFar as number);
    expect(Object.keys(graph.inputs)).toEqual(['depth']);
    expect(understood).toEqual(['Tiefenschärfe · Fokus vorn, Hintergrund unscharf · f/1,4 · 6 Lamellen']);
  });
  it('blur scales with 1/N', ()=>{
    const blur=(t:string)=>node(build(t).graph,'lens.dof@1')!.params.blurFar as number;
    expect(blur('shallow depth of field at f/2')/blur('shallow depth of field at f/8')).toBeCloseTo(4,2);
    expect(blur('Blende 2,8, Vordergrund scharf')).toBeCloseTo(blur('f2.8 background blur'),6);
    expect(blur('leichte Unschärfe im Hintergrund')).toBeLessThan(blur('starke Unschärfe im Hintergrund'));
  });
  it('focus on the background blurs the near side', ()=>{
    const dof=node(build('Vordergrund unscharf').graph,'lens.dof@1')!.params;
    expect(dof).toMatchObject({focus:.8,blurFar:0});
    expect(dof.blurNear).toBeGreaterThan(0);
    expect(node(build('focus on the background').graph,'lens.dof@1')!.params.focus).toBe(.8);
  });
  it('order relight → fog → dof → display → look', ()=>{
    const {graph}=build('Teal & Orange, Bokeh, Dunst überall, Gegenlicht');
    expect(types(graph)).toEqual(['color.convert@1','mask.depthRange@1','light.relight@1','atmos.fog@1','lens.dof@1','color.convert@1','color.look@1']);
    expect(node(graph,'light.relight@1')!.params).toMatchObject({azimuth:180,elevation:20});
    expect(node(graph,'color.look@1')!.params.look).toEqual(parseLookPrompt('Teal & Orange').look);
  });
  it('light directions, quality and target', ()=>{
    const p=(t:string)=>node(build(t).graph,'light.relight@1')!;
    expect(p('weiches Licht von oben').params).toMatchObject({azimuth:0,elevation:75,softness:.85});
    expect(p('hartes, starkes Licht von unten links').params).toMatchObject({azimuth:-70,elevation:-30,softness:.15,intensity:1.5});
    expect(p('backlight from the right, 5600K').params).toMatchObject({azimuth:135,color:{kelvin:5600}});
    expect(p('leichtes neutrales Licht von vorne').params).toMatchObject({azimuth:0,intensity:.4,color:[1,1,1]});
    const person=build('Licht auf die Person von links').graph;
    expect(node(person,'mask.depthRange@1')!.params).toMatchObject({near:0,far:.4});
    expect(node(build('Licht überall von rechts').graph,'light.relight@1')!.inputs.mask).toBeUndefined();
  });
  it('keeps meta and colorManagement of base', ()=>{
    const base=emptyGraph('Mein Look');base.meta.author='Ludwig';
    base.colorManagement={...base.colorManagement,input:'ACEScg',working:{linear:'ACEScg',display:'Rec.1886 Rec.709 - Display'}};
    const {graph}=build('Fargo, Nebel im Hintergrund',base);
    expect(graph.meta).toEqual({...base.meta,prompt:'Fargo, Nebel im Hintergrund'});
    expect(graph.colorManagement).toEqual(base.colorManagement);
    // Input already linear: no toLinear node.
    expect(graph.nodes.some(n=>n.id==='auto-toLinear')).toBe(false);
    expect(graph.nodes.map(n=>n.id)).toEqual(['bgMask','fog','auto-toDisplay','look']);
  });
});

describe('promptToGraph – look only and negatives', ()=>{
  it('look only declares no depth', ()=>{
    const {graph,understood}=build('Fargo, warme Lichter');
    expect(types(graph)).toEqual(['color.look@1']);
    expect(graph.inputs).toEqual({});expect(graph.models).toEqual({});
    expect(node(graph,'color.look@1')!.params.look).toEqual(parseLookPrompt('Fargo, warme Lichter').look);
    expect(understood).toEqual(parseLookPrompt('Fargo, warme Lichter').understood);
  });
  it('"Blade Runner" and "Moonlight" stay looks', ()=>{
    for(const t of ['Blade Runner 2049','Moonlight']){
      const {graph}=build(t);
      expect(types(graph)).toEqual(['color.look@1']);
      expect(node(graph,'color.look@1')!.params.look).toEqual(parseLookPrompt(t).look);
    }
  });
  it('light without direction is a look instruction, not relight', ()=>{
    const {graph}=build('warmes Licht');
    expect(types(graph)).toEqual(['color.look@1']);
  });
  it('unknown text and empty text give a valid identity graph', ()=>{
    for(const t of ['','Hallo Welt','   ']){
      const {graph,understood}=build(t);
      expect(understood).toEqual([]);
      expect(types(graph)).toEqual(['color.convert@1']);
      expect(graph.inputs).toEqual({});
    }
  });
  it('invalid blade counts and apertures are reported, not used', ()=>{
    const {graph,understood}=build('Bokeh mit 3 Lamellen, f/500');
    expect(node(graph,'lens.dof@1')!.params.blades).toBe(0);
    expect(understood.some(u=>u.includes('3 Lamellen nicht möglich'))).toBe(true);
    expect(understood.some(u=>u.includes('f/500'))).toBe(true);
  });
  it('clamps Kelvin and long prompts to the valid range', ()=>{
    expect(node(build('Licht von links, 1000K').graph,'light.relight@1')!.params.color).toEqual({kelvin:1667});
    expect(build('Nebel '.repeat(600)).graph.meta.prompt!.length).toBe(2000);
  });
  it('only creates each node once and keeps ids unique', ()=>{
    const {graph}=build('Nebel hinten, mehr Nebel, Dunst, Bokeh, Unschärfe');
    expect(nodesOf(graph,'atmos.fog@1')).toHaveLength(1);
    expect(nodesOf(graph,'lens.dof@1')).toHaveLength(1);
    expect(new Set(graph.nodes.map(n=>n.id)).size).toBe(graph.nodes.length);
  });
});

describe('emptyGraph', ()=>{
  it('is valid and passes the source through', ()=>{
    const g=emptyGraph('Leer');
    expect(checkGraph(g)).toEqual([]);
    expect(g.meta.name).toBe('Leer');
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({type:'color.convert@1',inputs:{image:'$source'}});
    expect(emptyGraph('').meta.name).toBe('Neuer Look');
    expect(emptyGraph('x'.repeat(300)).meta.name.length).toBe(100);
  });
});
