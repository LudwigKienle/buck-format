import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { colorValueToRGB } from '../src/buck/colorspace';
import { NODE_CATALOG, isAutoNode } from '../src/buck/editor/chain';
import { KELVIN_SLIDER, clampValue, describeKeyframes, formatNumber, fromLogPos, parseNumber, sliderStep, switchColorMode, toLogPos } from '../src/buck/editor/controls';
import { NodeInspector, applyMaskChoice, maskSources, newMask, zeroLuma } from '../src/buck/editor/NodeInspector';
import { NodeStack, addToStack, catalogGroups, moveInStack, removeFromStack, tidy, toggleEnabled } from '../src/buck/editor/NodeStack';
import { checkGraph } from '../src/buck/validate';
import type { BuckGraph, BuckNode } from '../src/buck/types';

const fixture=():BuckGraph=>JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8'));
const byId=(g:BuckGraph,id:string)=>g.nodes.find(n=>n.id===id)!;
const noop=()=>{};

describe('controls helpers',()=>{
  it('parses German and English decimals, rejects junk',()=>{
    expect(parseNumber('0,5')).toBe(.5);expect(parseNumber(' -1.25 ')).toBe(-1.25);expect(parseNumber('1e-3')).toBe(.001);expect(parseNumber(',5')).toBe(.5);
    for(const bad of ['','abc','1,2,3','1.2.3','--1','Infinity','NaN'])expect(parseNumber(bad)).toBeUndefined();
  });
  it('picks 1-2-5 steps and formats with a German comma',()=>{
    expect(sliderStep(-.3,.3)).toBe(.001);expect(sliderStep(0,1)).toBe(.001);expect(sliderStep(0,.05)).toBe(.0001);expect(sliderStep(-10,10)).toBe(.02);expect(sliderStep(1,1)).toBe(1);
    expect(formatNumber(.55,.001)).toBe('0,55');expect(formatNumber(3200,10)).toBe('3200');
  });
  it('clamps with exclusive minima and integers',()=>{
    expect(clampValue(-1,[0,16],{exclusiveMin:true,step:.02})).toBe(.02);expect(clampValue(20,[0,16])).toBe(16);
    expect(clampValue(7.6,[0,12],{integer:true})).toBe(8);expect(clampValue(.5,[0,1],{exclusiveMin:true})).toBe(.5);
  });
  it('maps log slider positions monotonically onto the range',()=>{
    const r:[number,number]=[.5,128];
    expect(toLogPos(.5,r)).toBe(0);expect(toLogPos(128,r)).toBe(1000);expect(fromLogPos(0,r)).toBe(.5);expect(fromLogPos(1000,r)).toBe(128);
    expect(Math.abs(fromLogPos(toLogPos(2.8,r),r)-2.8)/2.8).toBeLessThan(.01);
    expect(toLogPos(1e9,r)).toBe(1000);
  });
  it('switches color representation through the colorspace module',()=>{
    expect(switchColorMode({kelvin:3200},'rgb','ACEScg')).toEqual(colorValueToRGB({kelvin:3200},'ACEScg'));
    expect(switchColorMode([.5,.5,.5],'kelvin','ACEScg',4300)).toEqual({kelvin:4300});
    expect(switchColorMode({kelvin:5000},'kelvin','ACEScg')).toEqual({kelvin:5000});
    expect(KELVIN_SLIDER).toEqual([1800,12000]);
  });
  it('describes keyframes read-only',()=>expect(describeKeyframes({keys:[[0,1],[24,2]],interp:'smooth'})).toBe('animiert · 2 Schlüssel · weich'));
});

describe('stack edits',()=>{
  it('the fixture is valid and tidy is idempotent on it',()=>{
    const g=fixture();expect(checkGraph(g)).toEqual([]);
    const t=tidy(g);expect(tidy(t)).toEqual(t);expect(checkGraph(t)).toEqual([]);
  });
  it('groups the catalog in Farbe, Raum, Licht, Maske order and covers every type',()=>{
    const groups=catalogGroups();
    expect(groups.map(g=>g.group)).toEqual(['Farbe','Raum','Licht','Maske']);
    expect(groups.flatMap(g=>g.entries).length).toBe(NODE_CATALOG.length);
  });
  it('adds every catalog type into a valid graph',()=>{
    for(const {type} of NODE_CATALOG){
      const r=addToStack(fixture(),type);
      expect(byId(r.graph,r.id).type).toBe(type);
      expect(checkGraph(r.graph),type).toEqual([]);
    }
  });
  it('adds after the selected node',()=>{
    const r=addToStack(fixture(),'color.cdl@1','fargo');
    const chain=r.graph.nodes.map(n=>n.id);expect(chain.indexOf(r.id)).toBeGreaterThan(chain.indexOf('fargo'));
    expect(checkGraph(r.graph)).toEqual([]);
  });
  it('toggles enabled, re-deriving conversions, and drops the key when switching on',()=>{
    const off=toggleEnabled(fixture(),'fog');expect(byId(off,'fog').enabled).toBe(false);expect(checkGraph(off)).toEqual([]);
    const on=toggleEnabled(off,'fog');expect('enabled' in byId(on,'fog')).toBe(false);
  });
  it('moves and removes nodes, keeping the graph valid',()=>{
    const moved=moveInStack(fixture(),'bgMask',-1);
    const masks=moved.nodes.filter(n=>n.type.startsWith('mask.')).map(n=>n.id);expect(masks).toEqual(['bgMask','nearMask']);
    const removed=removeFromStack(fixture(),'bgMask');
    expect(removed.nodes.some(n=>n.id==='bgMask')).toBe(false);expect(byId(removed,'fog').inputs.mask).toBeUndefined();expect(checkGraph(removed)).toEqual([]);
  });
});

describe('inspector edits',()=>{
  it('creates preset masks from the spec example and wires them',()=>{
    const bg=applyMaskChoice(fixture(),'fargo','new:background');
    const m=byId(bg.graph,bg.created!);
    expect(m.type).toBe('mask.depthRange@1');expect(m.params).toMatchObject({near:.55,far:1,feather:.15});
    expect(byId(bg.graph,'fargo').inputs.mask).toBe(bg.created);expect(checkGraph(bg.graph)).toEqual([]);
    const fg=newMask(fixture(),'foreground');expect(byId(fg.graph,fg.id).params).toMatchObject({near:0,far:.6,feather:.12});
    const top=applyMaskChoice(fixture(),'fog','new:top');
    expect(byId(top.graph,top.created!).params).toMatchObject({shape:'linear',start:[.5,.28125],end:[.5,0]});expect(checkGraph(top.graph)).toEqual([]);
  });
  it('disconnects and reconnects masks',()=>{
    const none=applyMaskChoice(fixture(),'fog','').graph;expect(byId(none,'fog').inputs.mask).toBeUndefined();
    const again=applyMaskChoice(none,'fog','nearMask').graph;expect(byId(again,'fog').inputs.mask).toBe('nearMask');
  });
  it('offers only acyclic mask sources',()=>{
    const r=addToStack(fixture(),'mask.refine@1','bgMask');
    expect(maskSources(r.graph,'bgMask').map(n=>n.id)).toEqual(['nearMask']);
    expect(maskSources(r.graph,r.id).map(n=>n.id)).toEqual(['nearMask','bgMask']);
  });
  it('removes the Rec.709 luma part of a tint',()=>{
    const t=zeroLuma([.1,.05,0],[-.3,.3]);
    expect(Math.abs(.2126*t[0]+.7152*t[1]+.0722*t[2])).toBeLessThan(1e-5);
    expect(zeroLuma([.3,.3,-.3],[-.3,.3]).every(v=>v>=-.3&&v<=.3)).toBe(true);
  });
});

describe('rendering',()=>{
  it('lists the chain and masks, marks auto conversions',()=>{
    const base=fixture(),g=tidy({...base,nodes:base.nodes.filter(n=>n.type!=='color.convert@1').map(n=>n.inputs.image==='toLinear'?{...n,inputs:{...n.inputs,image:'$source'}}:n)});
    const autos=g.nodes.filter(isAutoNode);expect(autos.length).toBeGreaterThan(0);
    const html=renderToStaticMarkup(createElement(NodeStack,{graph:g,selected:'fog',onSelect:noop,updateGraph:noop}));
    expect(html).toContain('Bildkette');expect(html).toContain('Masken');expect(html).toContain('automatisch');
    expect(html).toContain('aria-label="„Nebel im Hintergrund“ löschen"');
    for(const a of autos)expect(html).not.toContain(`„${a.label}“ löschen`);
    expect(html).toContain('aria-current="true"');expect(html).toContain('aria-expanded="false"');
  });
  it('renders a form for every node type without throwing',()=>{
    let g=fixture();const ids:string[]=[];
    for(const {type} of NODE_CATALOG){const r=addToStack(g,type);g=r.graph;ids.push(r.id);}
    for(const id of [...ids,...g.nodes.map(n=>n.id)]){
      const html=renderToStaticMarkup(createElement(NodeInspector,{graph:g,node:byId(g,id),updateNode:noop,updateGraph:noop}));
      expect(html).toContain('Knoteneigenschaften');
    }
  });
  it('shows keyframes as animated, Kelvin with the 1800–12000 slider and the linear hint',()=>{
    const g=fixture(),fog=byId(g,'fog') as Extract<BuckNode,{type:'atmos.fog@1'}>;
    const animated={...fog,params:{...fog.params,density:{keys:[[0,1],[48,3]] as [number,number][],interp:'linear' as const}}};
    const html=renderToStaticMarkup(createElement(NodeInspector,{graph:g,node:animated,updateNode:noop,updateGraph:noop}));
    expect(html).toContain('animiert · 2 Schlüssel · linear');expect(html).toContain('linear im Arbeitsraum (ACEScg)');
    const relight=renderToStaticMarkup(createElement(NodeInspector,{graph:g,node:byId(g,'warmKey'),updateNode:noop,updateGraph:noop}));
    expect(relight).toMatch(/min="1800" max="12000"/);expect(relight).toContain('Farbtemperatur');
    expect(renderToStaticMarkup(createElement(NodeInspector,{graph:g,updateNode:noop,updateGraph:noop}))).toContain('Kein Knoten ausgewählt');
  });
});
