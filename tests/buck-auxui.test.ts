import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { AuxPanel, aspectMismatch, auxFromBuckaux, auxMeta, decodeDepthMap, depthFromMap, depthInput, estimateModels, estimateToDepth, adoptRegistryPin, modelTrust, normalizeOpts, pinDifferences, pinStatus, registryPin, resampleDepth, switchToDefaultModel, withPinnedHash } from '../src/buck/editor/AuxPanel';
import { BuckViewer, DEFAULT_NORMALS_SMOOTHING, INVALID_RGB, NORMALS_PREVIEW_SIDE, depthPreview, isMaskSelected, normalsPreview, normalsSmoothing, viewerNormals } from '../src/buck/editor/BuckViewer';
import { writeExr } from '../src/buck/aux/exr';
import { exportBuckaux, importBuckaux } from '../src/buck/aux/cache';
import { KNOWN_MODELS, DEFAULT_DEPTH_MODEL } from '../src/buck/depth/models';
import { scalarField, vectorField, imageBuf } from '../src/buck/field';
import { addNode } from '../src/buck/editor/chain';
import type { BuckGraph, ModelPin } from '../src/buck/types';
import type { AuxState, EditorState } from '../src/buck/editor/types';

/** AuxPanel and BuckViewer: pure helpers plus server-rendered markup (no DOM; jsdom is not installed). */
const fixture=():BuckGraph=>JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8'));
const SHA='a'.repeat(64);
const emptyAux=():AuxState=>({channels:{masks:{}},depthSource:'none',busy:false});
const noop=()=>{};

describe('AuxPanel helpers',()=>{
  it('finds the depth input and its estimate models',()=>{
    const g=fixture(),d=depthInput(g)!;
    expect(d.name).toBe('depth');expect(estimateModels(d.decl)).toEqual(['vda-small-rel@1']);
    expect(estimateModels(undefined)).toEqual([]);
    expect(registryPin('da2-small-rel@1')).toBe(KNOWN_MODELS['da2-small-rel@1']);
    expect(registryPin('constructor')).toBeUndefined();expect(registryPin('__proto__')).toBeUndefined();
    expect(g.models['vda-small-rel@1']).toBeDefined();
  });
  it('compares hashes with the pin',()=>{
    const pinned=KNOWN_MODELS['da2-small-rel@1'] as ModelPin;
    expect(pinStatus(pinned,pinned.weightsSha256)).toBe('match');
    expect(pinStatus(pinned,pinned.weightsSha256.toUpperCase())).toBe('match');
    expect(pinStatus(pinned,SHA)).toBe('mismatch');
    expect(pinStatus({...pinned,weightsSha256:''},SHA)).toBe('unpinned');
  });
  it('trusts only the local registry, never the pin inside the file (§6.3, §11.6)',()=>{
    const id='da2-small-rel@1',reg=KNOWN_MODELS[id],evil=switchToDefaultModel(fixture(),'depth');
    evil.models[id]={...structuredClone(reg),name:'Fremd',weightsSha256:'e'.repeat(64),preprocess:{...reg.preprocess,longSide:4088}};
    const t=modelTrust(evil,id);
    expect(t.pin).toBe(reg);expect(t.unknown).toBe(false);expect(t.differs).toEqual(['SHA-256','Vorverarbeitung']);
    expect(pinStatus(t.pin!,'e'.repeat(64))).toBe('mismatch');expect(pinStatus(t.pin!,reg.weightsSha256)).toBe('match');
    expect(pinDifferences(structuredClone(reg),reg)).toEqual([]);
    // Same values in another key order are not a difference.
    const reordered={...structuredClone(reg),preprocess:{std:reg.preprocess.std,mean:reg.preprocess.mean,inputSpace:reg.preprocess.inputSpace,resize:reg.preprocess.resize,multipleOf:reg.preprocess.multipleOf,longSide:reg.preprocess.longSide}};
    expect(pinDifferences(reordered,reg)).toEqual([]);
    expect(adoptRegistryPin(evil,id).models[id]).toEqual(reg);
    const unknown={...evil,models:{'evil@1':evil.models[id]},inputs:{...evil.inputs,depth:{...evil.inputs.depth,sources:[{type:'estimate' as const,model:'evil@1'}]}}};
    expect(modelTrust(unknown,'evil@1')).toEqual({unknown:true,differs:[]});
    // An unpinned registry entry runs only with a hash confirmed in this session; the file's hash does not count.
    const vda=fixture();vda.models['vda-small-rel@1'].weightsSha256=SHA;
    expect(modelTrust(vda,'vda-small-rel@1').pin!.weightsSha256).toBe('');
    expect(modelTrust(vda,'vda-small-rel@1',SHA).pin!.weightsSha256).toBe(SHA);
  });
  it('pins a confirmed hash without touching the registry',()=>{
    const g=fixture(),out=withPinnedHash(g,'vda-small-rel@1',SHA);
    expect(out.models['vda-small-rel@1']).toEqual({...KNOWN_MODELS['vda-small-rel@1'],weightsSha256:SHA});
    expect(g.models['vda-small-rel@1'].weightsSha256).not.toBe(SHA);
    const reg=withPinnedHash({...g,models:{}},'da2-small-rel@1',SHA);
    expect(reg.models['da2-small-rel@1'].weightsSha256).toBe(SHA);
    expect(KNOWN_MODELS['da2-small-rel@1'].weightsSha256).not.toBe(SHA);
    expect(()=>withPinnedHash(g,'nope',SHA)).toThrow(/lokalen Modellregister/);
    expect(()=>withPinnedHash(g,'vda-small-rel@1','xyz')).toThrow(/SHA-256/);
  });
  it('switches the estimate source to the default model',()=>{
    const g=switchToDefaultModel(fixture(),'depth');
    expect(g.inputs.depth.sources.filter(s=>s.type==='estimate')).toEqual([{type:'estimate',model:DEFAULT_DEPTH_MODEL}]);
    expect(Object.keys(g.models)).toEqual([DEFAULT_DEPTH_MODEL]);
    expect(g.inputs.depth.sources[0]).toEqual({type:'host-clip',clip:'Depth'});
    const f=fixture();expect(switchToDefaultModel(f,'missing')).toBe(f);
  });
  it('uses the §6.2 normalization defaults',()=>{
    expect(normalizeOpts(undefined)).toEqual({mode:'shot-percentile',low:2,high:98});
    expect(normalizeOpts(depthInput(fixture())!.decl)).toEqual({mode:'shot-percentile',low:2,high:98});
  });
  it('resamples depth without smearing +Infinity into NaN',()=>{
    const f=scalarField(2,1,new Float32Array([.25,Infinity])),same=resampleDepth(f,2,1);
    expect(Array.from(same.data)).toEqual([.25,Infinity]);expect(same.data).not.toBe(f.data);
    const up=resampleDepth(f,4,1);
    expect(up.data.every(v=>!Number.isNaN(v))).toBe(true);
    expect(up.data[0]).toBeCloseTo(.25);expect(up.data[3]).toBe(Infinity);
  });
  it('decodes 8/16-bit grayscale PNG and single-channel EXR',()=>{
    const p16=decodeDepthMap(encodePng({width:2,height:1,data:new Uint16Array([0,65535]),depth:16,channels:1}));
    expect(p16.format).toBe('PNG 16 Bit');expect(Array.from(p16.values)).toEqual([0,1]);
    const p8=decodeDepthMap(encodePng({width:2,height:1,data:new Uint8Array([51,51,51,255,255,255]),depth:8,channels:3}));
    expect(p8.values[0]).toBeCloseTo(.2,6);expect(p8.values[1]).toBe(1);
    const ga=decodeDepthMap(encodePng({width:2,height:1,data:new Uint8Array([10,0,20,255]),depth:8,channels:2}));
    expect(ga.values[0]).toBe(Infinity);expect(ga.values[1]).toBeCloseTo(20/255,6);
    expect(()=>decodeDepthMap(encodePng({width:1,height:1,data:new Uint8Array([1,2,3]),depth:8,channels:3}))).toThrow(/farbig/);
    const exr=decodeDepthMap(writeExr(scalarField(2,1,new Float32Array([.5,Infinity])),{channels:['Z']}));
    expect(exr.format).toBe('OpenEXR');expect(Array.from(exr.values)).toEqual([.5,Infinity]);
    expect(()=>decodeDepthMap(writeExr(vectorField(1,1),{channels:['N.X','N.Y','N.Z']}))).toThrow(/drei Kanäle/);
    expect(()=>decodeDepthMap(new Uint8Array([1,2,3,4,5,6,7,8,9]))).toThrow(/Unbekanntes Format/);
    expect(()=>decodeDepthMap(encodePng({width:4097,height:1,data:new Uint8Array(4097),depth:8,channels:1}))).toThrow(/höchstens 4096/);
  });
  it('maps depth maps to 0 = near … 1 = far',()=>{
    const map={values:new Float32Array([0,.25,.5,1]),width:4,height:1,format:'x'};
    expect(Array.from(depthFromMap(map,{whiteNear:true,normalize:false}).data)).toEqual([1,.75,.5,0]);
    expect(Array.from(depthFromMap(map,{whiteNear:false,normalize:false}).data)).toEqual([0,.25,.5,1]);
    const inv=depthFromMap(map,{whiteNear:true,normalize:true}).data;
    expect(inv[0]).toBe(Infinity); // black = disparity 0 = infinitely far
    expect(inv[1]).toBeGreaterThan(inv[2]);expect(inv[2]).toBeGreaterThan(inv[3]);
    const rel=depthFromMap(map,{whiteNear:false,normalize:true}).data;
    expect(rel[0]).toBe(0);expect(rel[3]).toBe(1);
    const sized=depthFromMap(map,{whiteNear:false,normalize:false,width:8,height:2});
    expect([sized.width,sized.height]).toEqual([8,2]);
    const none={...depthInput(fixture())!.decl,normalize:{mode:'none' as const}};
    expect(depthFromMap(map,{whiteNear:false,normalize:true,decl:none}).data[3]).toBe(1);
  });
  it('normalizes a fake model output and labels its provenance',async()=>{
    const pin=KNOWN_MODELS['da2-small-rel@1'] as ModelPin,img=imageBuf(4,1,'sRGB - Display');
    const seen:unknown[]=[],ctrl=new AbortController();
    const fake=async(_i:unknown,_p:unknown,_w:unknown,o?:{onProgress?:(p:number)=>void;signal?:AbortSignal})=>{seen.push(o?.signal);o?.onProgress?.(.5);return {raw:scalarField(2,1,new Float32Array([4,1])),weightsSha256:SHA,backend:'wasm' as const};};
    const progress:number[]=[];
    const r=await estimateToDepth(img,pin,new ArrayBuffer(1),undefined,{signal:ctrl.signal,onProgress:p=>progress.push(p)},fake);
    expect(seen).toEqual([ctrl.signal]);expect(progress).toEqual([.5]);
    expect([r.depth.width,r.depth.height]).toEqual([4,1]);
    expect(r.depth.data[0]).toBe(0);expect(r.depth.data[3]).toBe(1); // high disparity = near
    expect(r.label).toBe(`${pin.name} · sha256 aaaaaaaa… · WASM`);expect(r.sha).toBe(SHA);
  });
  it('round-trips a .buckaux with untrusted meta',()=>{
    const g=fixture(),aux:AuxState={...emptyAux(),channels:{depth:scalarField(2,2,new Float32Array([0,.5,1,Infinity])),masks:{}},depthSource:'upload',depthLabel:'Tiefenkarte „a.png“'};
    const src={name:'shot.png',image:imageBuf(2,2,'sRGB - Display'),width:2,height:2};
    const meta=auxMeta(g,aux,src);
    expect(meta).toEqual(auxMeta(g,aux,src));
    expect(meta).toMatchObject({depthSource:'upload',source:{name:'shot.png',width:2,height:2},normalize:{mode:'shot-percentile',low:2,high:98},model:null});
    const back=auxFromBuckaux(importBuckaux(exportBuckaux(aux.channels,meta)));
    expect(back.depthSource).toBe('upload');expect(back.depthLabel).toBe('Tiefenkarte „a.png“ · aus .buckaux');
    expect(Array.from(back.channels.depth!.data)).toEqual([0,.5,1,Infinity]);
    expect(auxFromBuckaux({aux:aux.channels,meta:{depthSource:'evil',depthLabel:'x'.repeat(500)}})).toMatchObject({depthSource:'upload',depthLabel:'x'.repeat(160)+' · aus .buckaux'});
    expect(auxFromBuckaux({aux:{masks:{}},meta:{depthSource:'estimate'}})).toEqual({channels:{masks:{}},depthSource:'none',depthLabel:undefined});
    const est=auxMeta(g,{...aux,depthSource:'estimate'});expect(est.model).toMatchObject({id:'vda-small-rel@1'});
  });
  it('detects aspect ratio mismatches',()=>{
    expect(aspectMismatch({width:1920,height:1080},{width:960,height:540})).toBe(false);
    expect(aspectMismatch({width:1000,height:1000},{width:1920,height:1080})).toBe(true);
  });
});

describe('AuxPanel markup',()=>{
  it('shows status, missing inputs and the unavailable-model switch, without links',()=>{
    const html=renderToStaticMarkup(h(AuxPanel,{graph:fixture(),aux:emptyAux(),setAux:noop,updateGraph:noop}));
    expect(html).toContain('Hilfskanäle');expect(html).toContain('Fehlende Eingaben');
    expect(html).toContain('abhängige Knoten werden überbrückt');
    expect(html).toContain('https://github.com/DepthAnything/Video-Depth-Anything');expect(html).not.toContain('<a ');
    expect(html).toContain('Lizenz');expect(html).toContain('Apache-2.0');
    expect(html).toContain('umstellen');expect(html).toContain('Diesen Hash als Modell festlegen?');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Tiefe schätzen/); // no source, unavailable model
    expect(html).toContain('aria-pressed="true"');expect(html).toContain('Weiß = nah');
  });
  it('enables estimation for a pinned, available model with a source',()=>{
    const g=switchToDefaultModel(fixture(),'depth'),src={name:'a.png',image:imageBuf(2,2,'sRGB - Display'),width:2,height:2};
    const html=renderToStaticMarkup(h(AuxPanel,{graph:g,source:src,aux:{...emptyAux(),channels:{depth:scalarField(1,1),masks:{}},depthSource:'heuristic',depthLabel:'Behelf: Bildheuristik',busy:true,progress:.4,error:'Fehler X'},setAux:noop,updateGraph:noop}));
    expect(html).not.toContain('umstellen');expect(html).toContain('afb6a5c28f3b6bf1');
    expect(html).toContain('role="alert"');expect(html).toContain('Fehler X');expect(html).toContain('40 %');expect(html).toContain('Abbrechen');
    expect(html).toContain('1 × 1 px (wird auf Bildgröße skaliert)');expect(html).toContain('werden aus der Tiefe abgeleitet');
  });
  it('refuses models outside the registry and flags a deviating file pin',()=>{
    const src={name:'a.png',image:imageBuf(2,2,'sRGB - Display'),width:2,height:2},g=switchToDefaultModel(fixture(),'depth');
    const evil={...g,inputs:{...g.inputs,depth:{...g.inputs.depth,sources:[{type:'estimate' as const,model:'evil@1'}]}},models:{'evil@1':{...g.models['da2-small-rel@1'],name:'Böse'}}};
    const html=renderToStaticMarkup(h(AuxPanel,{graph:evil,source:src,aux:emptyAux(),setAux:noop,updateGraph:noop}));
    expect(html).toContain('nicht im lokalen Modellregister');expect(html).not.toContain('Tiefe schätzen (ONNX');expect(html).not.toContain('Böse');
    const changed={...g,models:{'da2-small-rel@1':{...g.models['da2-small-rel@1'],weightsSha256:'e'.repeat(64)}}};
    const html2=renderToStaticMarkup(h(AuxPanel,{graph:changed,source:src,aux:emptyAux(),setAux:noop,updateGraph:noop}));
    expect(html2).toContain('weicht vom lokalen Register ab (SHA-256)');expect(html2).toContain('afb6a5c28f3b6bf1');
  });
  it('explains a graph without depth',()=>{
    const g={...fixture(),inputs:{},models:{},nodes:[]};
    expect(renderToStaticMarkup(h(AuxPanel,{graph:g,aux:emptyAux(),setAux:noop,updateGraph:noop}))).toContain('deklariert keine Tiefe');
  });
});

describe('BuckViewer',()=>{
  it('draws depth bright = near with magenta for invalid and stretches metric values',()=>{
    const d=depthPreview(scalarField(3,1,new Float32Array([0,1,Infinity])));
    expect(Array.from(d.data)).toEqual([255,255,255,255,0,0,0,255,...INVALID_RGB,255]);expect(d.stretched).toBe(false);
    const m=depthPreview(scalarField(2,1,new Float32Array([2,10])));
    expect(m.stretched).toBe(true);expect([m.data[0],m.data[4]]).toEqual([255,0]);
    expect(depthPreview(scalarField(1,1,new Float32Array([NaN]))).data[0]).toBe(INVALID_RGB[0]);
  });
  it('draws normals as n·0.5+0.5',()=>{
    const n=normalsPreview(vectorField(2,1,new Float32Array([0,0,1,0,0,0])));
    expect(Array.from(n.data)).toEqual([128,128,255,255,...INVALID_RGB,255]);
  });
  it('derives preview normals with the declared smoothing and a size cap',()=>{
    expect(normalsSmoothing(fixture())).toBe(.002);
    expect(normalsSmoothing({...fixture(),inputs:{}})).toBe(DEFAULT_NORMALS_SMOOTHING);
    const big=scalarField(2048,8,new Float32Array(2048*8).fill(.5)),r=viewerNormals({depth:big,masks:{}},.002)!;
    expect(r.derived).toBe(true);expect(r.field.width).toBe(NORMALS_PREVIEW_SIDE);expect(r.field.height).toBe(4);
    expect(r.field.data[2]).toBeCloseTo(1);
    const own=vectorField(1,1);expect(viewerNormals({normals:own,masks:{}},.002)).toEqual({field:own,derived:false});
    expect(viewerNormals({masks:{}},.002)).toBeUndefined();
  });
  it('offers the mask view only for a selected mask node',()=>{
    const {graph,id}=addNode(fixture(),'mask.gradient@1');
    expect(isMaskSelected(graph,id)).toBe(true);expect(isMaskSelected(graph,'fog')).toBe(false);expect(isMaskSelected(graph)).toBe(false);
    const state=(over:Partial<EditorState>):EditorState=>({graph,files:new Map(),aux:emptyAux(),view:'result',frame:0,...over});
    expect(renderToStaticMarkup(h(BuckViewer,{state:state({}),busy:false,onView:noop}))).not.toContain('>Maske<');
    const html=renderToStaticMarkup(h(BuckViewer,{state:state({selected:id}),busy:false,onView:noop}));
    expect(html).toContain('>Maske<');expect(html).toContain('Bitte ein Ausgangsbild laden.');expect(html).toContain('aria-pressed="true"');
  });
  it('shows split, dimensions, render time and the busy status',()=>{
    const src={name:'a.png',image:imageBuf(4,2,'sRGB - Display'),width:4,height:2};
    const result={jobId:1,width:4,height:2,preview:new Uint8ClampedArray(32),warnings:[],bypassed:['fog'],ms:12.4};
    const html=renderToStaticMarkup(h(BuckViewer,{state:{graph:fixture(),files:new Map(),aux:emptyAux(),view:'split',frame:0,source:src},result:result,busy:true,onView:noop}));
    expect(html).toContain('type="range"');expect(html).toContain('Vergleichstrenner');
    expect(html).toContain('4 × 2 px · Renderzeit 12 ms');expect(html).toContain('Wird berechnet …');expect(html).toContain('role="status"');
    const dhtml=renderToStaticMarkup(h(BuckViewer,{state:{graph:fixture(),files:new Map(),aux:{...emptyAux(),channels:{depth:scalarField(4,2),masks:{}}},view:'depth',frame:0,source:src},busy:false,onView:noop}));
    expect(dhtml).toContain('hell = nah');expect(dhtml).toContain('Tiefenkarte als Graustufen');
  });
});
