import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { addNode, defaultNode, imageChain, isAutoNode, levelGroups, levelOf, moveNode, openForEditing } from '../src/buck/editor/chain';
import { NodeStack, setTimeOfDay } from '../src/buck/editor/NodeStack';
import { TIME_OF_DAY_OPTIONS, TOD_KEY, applyTimeOfDay, emptyGraph, isTimeOfDayNode, promptToGraph, removeTimeOfDay, timeOfDayOf } from '../src/buck/prompt';
import { skyPresetParams } from '../src/buck/nodes/sky';
import { checkGraph } from '../src/buck/validate';
import { BuckError } from '../src/buck/types';
import type { BuckGraph, BuckNode, NodeOf, NodeType } from '../src/buck/types';

const FIXTURE=readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8');
const fixture=()=>JSON.parse(FIXTURE) as BuckGraph;
const valid=(g:BuckGraph)=>{expect(checkGraph(g)).toEqual([]);return g;};
const ids=(g:BuckGraph)=>imageChain(g).filter(n=>!isAutoNode(n)).map(n=>n.id);
const byId=(g:BuckGraph,id:string)=>g.nodes.find(n=>n.id===id)!;
const ofType=<T extends NodeType>(g:BuckGraph,t:T)=>g.nodes.filter((n):n is NodeOf<T>=>n.type===t);
const noop=()=>{};

describe('levels',()=>{
  it('assigns light, atmosphere, optics and grade; CDL by its space; conversions and masks have none',()=>{
    const lv=(t:NodeType)=>levelOf(defaultNode(t,'x'));
    expect(['light.relight@1','light.practicals@1'].map(t=>lv(t as NodeType))).toEqual(['light','light']);
    expect(['sky.replace@1','atmos.fog@1'].map(t=>lv(t as NodeType))).toEqual(['atmosphere','atmosphere']);
    expect(['lens.dof@1','lens.vignette@1','film.halation@1','film.grain@1'].map(t=>lv(t as NodeType))).toEqual(['optics','optics','optics','optics']);
    expect(['color.look@1','color.lut3d@1'].map(t=>lv(t as NodeType))).toEqual(['grade','grade']);
    const cdl=defaultNode('color.cdl@1','c') as NodeOf<'color.cdl@1'>;
    expect(levelOf(cdl)).toBe('grade');expect(levelOf({...cdl,params:{...cdl.params,space:'ACEScg'}})).toBe('light');
    expect(lv('color.convert@1')).toBeUndefined();expect(lv('mask.gradient@1')).toBeUndefined();
  });
  it('groups the fixture into the four levels in order, conversions with their neighbours',()=>{
    const {ordered,groups}=levelGroups(fixture());
    expect(ordered).toBe(true);
    expect(groups.map(g=>[g.level,g.nodes.map(n=>n.id)])).toEqual([['light',['toLinear','warmKey']],['atmosphere',['fog']],['optics',[]],['grade',['toDisplay','fargo']]]);
  });
  it('marks a deviating order without reordering the file',()=>{
    // A look before the fog: valid, but against light → atmosphere → optics → grade.
    let g=fixture();for(let i=0;i<2;i++)g=moveNode(g,'fargo',-1);
    valid(g);const chain=imageChain(g).map(n=>n.id),opened=openForEditing(g).graph;
    expect(imageChain(opened).map(n=>n.id)).toEqual(chain);
    const r=levelGroups(g);expect(r.ordered).toBe(false);
    expect(r.groups.some(x=>x.outOfOrder&&x.level==='atmosphere')).toBe(true);
    expect(r.groups.flatMap(x=>x.nodes.map(n=>n.id))).toEqual(chain);
    const html=renderToStaticMarkup(createElement(NodeStack,{graph:g,onSelect:noop,updateGraph:noop}));
    expect(html).toContain('außerhalb der Reihenfolge');expect(html).toContain('weicht von Licht → Atmosphäre → Optik → Grade ab');
  });
});

describe('adding nodes by level',()=>{
  it('puts each optics node between atmosphere and grade in lens → film order, whatever the insertion order',()=>{
    let g=fixture();
    for(const t of ['film.grain@1','lens.vignette@1','film.halation@1','lens.dof@1'] as NodeType[])g=valid(addNode(g,t).graph);
    expect(ids(g)).toEqual(['toLinear','warmKey','fog','dof','vignette','halation','grain','toDisplay','fargo']);
    expect(g.nodes.some(isAutoNode)).toBe(false);
  });
  it('adds light before the atmosphere, sky before fog and CDL to the grade',()=>{
    expect(ids(valid(addNode(fixture(),'light.practicals@1').graph))).toEqual(['toLinear','warmKey','practicals','fog','toDisplay','fargo']);
    expect(ids(valid(addNode(fixture(),'sky.replace@1').graph))).toEqual(['toLinear','warmKey','sky','fog','toDisplay','fargo']);
    expect(ids(valid(addNode(fixture(),'color.cdl@1').graph))).toEqual(['toLinear','warmKey','fog','toDisplay','fargo','cdl']);
  });
  it('honours the selected node only inside the same level',()=>{
    expect(ids(addNode(fixture(),'atmos.fog@1','fog').graph)).toEqual(['toLinear','warmKey','fog','fog-2','toDisplay','fargo']);
    expect(ids(addNode(fixture(),'light.relight@1','fargo').graph)).toEqual(['toLinear','warmKey','relight','fog','toDisplay','fargo']);
    expect(ids(addNode(fixture(),'color.convert@1','warmKey').graph)).toEqual(['toLinear','warmKey','convert','fog','toDisplay','fargo']);
  });
});

describe('time-of-day switch',()=>{
  it('offers "Wie aufgenommen" and the presets',()=>{
    expect(TIME_OF_DAY_OPTIONS[0]).toEqual({value:'as-shot',label:'Wie aufgenommen'});
    expect(TIME_OF_DAY_OPTIONS.map(o=>o.label)).toEqual(expect.arrayContaining(['Goldene Stunde','Mittag','Blaue Stunde','Nacht','Sternenhimmel','Mondaufgang','Bewölkt','Gewitter','Sandsturm']));
  });
  it('"Nacht" on the fixture: exposure, sky before fog, grade before the look, fog adapted, own relight kept',()=>{
    const {graph,understood}=applyTimeOfDay(fixture(),'night');valid(graph);
    expect(ids(graph)).toEqual(['toLinear','tod-exposure','warmKey','tod-sky','fog','toDisplay','tod-grade','fargo']);
    expect(ofType(graph,'light.relight@1').map(n=>n.id)).toEqual(['warmKey']);
    const fog=byId(graph,'fog') as NodeOf<'atmos.fog@1'>;
    expect(fog.params.luminance).toBeCloseTo(1.6-4.4,6);expect((fog as unknown as Record<string,unknown>)[TOD_KEY]).toEqual({params:{luminance:1.6},label:'Nebel im Hintergrund'});
    expect(timeOfDayOf(graph)).toBe('night');expect(understood[0]).toBe('Tageszeit · Nacht · Himmel ersetzt');
    expect(graph.nodes.filter(isTimeOfDayNode).every(n=>n.id.startsWith('tod-'))).toBe(true);
  });
  it('"Wie aufgenommen" restores the original graph exactly',()=>{
    const fx=fixture(),night=applyTimeOfDay(fx,'night').graph,back=applyTimeOfDay(night,'as-shot').graph;
    expect(back).toEqual(fx);expect(JSON.stringify(back)).toBe(JSON.stringify(fx));
    expect(timeOfDayOf(back)).toBe('as-shot');expect(removeTimeOfDay(fx)).toBe(fx);
  });
  it('switching presets replaces instead of stacking',()=>{
    let g=applyTimeOfDay(fixture(),'night').graph;g=applyTimeOfDay(g,'golden-hour').graph;g=valid(applyTimeOfDay(g,'blue-hour').graph);
    expect(ofType(g,'sky.replace@1')).toHaveLength(1);expect(ofType(g,'color.cdl@1')).toHaveLength(1);
    expect((byId(g,'fog') as NodeOf<'atmos.fog@1'>).params.luminance).toBeCloseTo(1.6-1.6,6);
    expect(timeOfDayOf(g)).toBe('blue-hour');
  });
  it('adds moonlight with its mask when the graph has no relight, a low sun for golden hour, dust for a sandstorm',()=>{
    const night=valid(applyTimeOfDay(emptyGraph('x'),'night').graph);
    expect(night.nodes.map(n=>n.type)).toEqual(['color.convert@1','color.cdl@1','mask.depthRange@1','light.relight@1','sky.replace@1','color.convert@1','color.look@1']);
    expect(Object.keys(night.inputs).sort()).toEqual(['depth','normals']);
    expect((byId(applyTimeOfDay(emptyGraph('x'),'golden-hour').graph,'tod-light') as NodeOf<'light.relight@1'>).params.color).toEqual({kelvin:2800});
    const sand=valid(applyTimeOfDay(emptyGraph('x'),'sandstorm').graph);expect(byId(sand,'tod-haze').type).toBe('atmos.fog@1');
    expect(ids(sand)).toEqual(['tod-sky','tod-haze','tod-grade']);
    // Noon: sky only, no grade, no exposure.
    expect(ids(valid(applyTimeOfDay(emptyGraph('x'),'clear-day').graph))).toEqual(['tod-sky']);
  });
  it('adapts an existing sky and practicals threshold, restoring them afterwards',()=>{
    let g=addNode(fixture(),'sky.replace@1').graph;g=addNode(g,'light.practicals@1').graph;
    const before=JSON.stringify(g),star=valid(applyTimeOfDay(g,'starry-night').graph);
    expect(ofType(star,'sky.replace@1').map(n=>n.id)).toEqual(['sky']);
    const sky=byId(star,'sky') as NodeOf<'sky.replace@1'>;expect(sky.params.preset).toBe('starry-night');expect(sky.params.moon).toBeUndefined();
    expect(sky.params.stars).toBe(skyPresetParams('starry-night','ACEScg').stars);
    expect((byId(star,'practicals') as NodeOf<'light.practicals@1'>).params.threshold).toBeLessThan(.3);
    expect(timeOfDayOf(star)).toBe('starry-night');
    expect(JSON.stringify(applyTimeOfDay(star,'as-shot').graph)).toBe(before);
  });
  it('refuses a chain the editor may not rebuild and works from the NodeStack helper',()=>{
    const g=fixture(),branch:BuckNode={id:'side',type:'color.cdl@1',inputs:{image:'toLinear'},params:{slope:[1,1,1],offset:[0,0,0],power:[1,1,1],saturation:1,style:'noClampFwd',space:'ACEScg'}};
    const odd={...g,nodes:[...g.nodes,branch]};valid(odd);
    expect(()=>applyTimeOfDay(odd,'night')).toThrow(BuckError);
    expect(timeOfDayOf(setTimeOfDay(fixture(),'overcast'))).toBe('overcast');
  });
  it('the prompt uses the same nodes as the switch',()=>{
    const p=promptToGraph('Blaue Stunde, Nebel im Hintergrund').graph,s=applyTimeOfDay(promptToGraph('Nebel im Hintergrund').graph,'blue-hour').graph;
    expect(p.nodes).toEqual(s.nodes);
  });
  it('NodeStack shows the switch and the four level headings',()=>{
    const html=renderToStaticMarkup(createElement(NodeStack,{graph:fixture(),onSelect:noop,updateGraph:noop}));
    expect(html).toContain('aria-label="Tageszeit"');expect(html).toMatch(/aria-checked="true"[^>]*>Wie aufgenommen/);
    for(const h of ['Licht','Atmosphäre','Optik','Grade'])expect(html).toContain(`aria-label="Ebene ${h}"`);
    expect(html).toContain('Keine Knoten.');expect(html).not.toContain('außerhalb der Reihenfolge');
    const night=renderToStaticMarkup(createElement(NodeStack,{graph:applyTimeOfDay(fixture(),'night').graph,onSelect:noop,updateGraph:noop}));
    expect(night).toMatch(/aria-checked="true"[^>]*>Nacht</);expect(night).toContain('von der Tageszeit angepasst');
  });
});
