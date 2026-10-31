import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import type { BuckGraph,NodeType } from '../src/buck/types';
import { BuckError,LIMITS } from '../src/buck/types';
import { checkGraph,PARAM_RANGES,parseGraph,topoOrder } from '../src/buck/validate';
type Obj=Record<string,unknown>;
type Schema=boolean|Obj;
const FIXTURE=readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8');
const SCHEMA=JSON.parse(readFileSync(new URL('../docs/schema/buck-1.0.schema.json',import.meta.url),'utf8')) as Obj;
const fixture=()=>JSON.parse(FIXTURE) as BuckGraph;
const node=(g:BuckGraph,id:string)=>g.nodes.find(n=>n.id===id)! as unknown as Obj&{params:Obj;inputs:Obj};
const params=(g:BuckGraph,id:string)=>node(g,id).params;
const mutate=(edit:(g:BuckGraph&Obj)=>void)=>{const g=fixture() as BuckGraph&Obj;edit(g);return g;};
const SHA='9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/** Minimal JSON Schema 2020-12 evaluator for exactly the keywords the schema uses; unknown keywords throw so nothing is silently skipped. */
const KEYWORDS=new Set(['$schema','$id','$comment','title','description','$defs','format','$ref','type','const','enum','properties','required','additionalProperties','patternProperties','propertyNames','items','prefixItems','minItems','maxItems','uniqueItems','minimum','maximum','exclusiveMinimum','minLength','maxLength','pattern','allOf','anyOf','oneOf','not','if','then','else','maxProperties']);
const isObj=(v:unknown):v is Obj=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function deref(ref:string):Schema{
  if(!ref.startsWith('#/'))throw new Error(`external $ref ${ref}`);
  return ref.slice(2).split('/').reduce<unknown>((s,part)=>(s as Obj)[part.replace(/~1/g,'/').replace(/~0/g,'~')],SCHEMA) as Schema;
}
function valid(s:Schema,v:unknown):boolean{
  if(s===true)return true;if(s===false)return false;
  for(const k of Object.keys(s))if(!KEYWORDS.has(k))throw new Error(`unsupported keyword ${k}`);
  if(typeof s.$ref==='string'&&!valid(deref(s.$ref),v))return false;
  if(typeof s.type==='string'){
    const t=s.type,ok=t==='object'?isObj(v):t==='array'?Array.isArray(v):t==='string'?typeof v==='string':t==='boolean'?typeof v==='boolean':t==='integer'?Number.isInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):false;
    if(!ok)return false;
  }
  if('const' in s&&!same(s.const,v))return false;
  if(Array.isArray(s.enum)&&!s.enum.some(e=>same(e,v)))return false;
  if(isObj(v)){
    const props=(s.properties??{}) as Obj,patterns=Object.entries((s.patternProperties??{}) as Obj);
    for(const [k,x] of Object.entries(v)){
      let matched=false;
      if(k in props){matched=true;if(!valid(props[k] as Schema,x))return false;}
      for(const [p,ps] of patterns)if(new RegExp(p,'u').test(k)){matched=true;if(!valid(ps as Schema,x))return false;}
      if(!matched&&'additionalProperties' in s&&!valid(s.additionalProperties as Schema,x))return false;
      if('propertyNames' in s&&!valid(s.propertyNames as Schema,k))return false;
    }
    if(Array.isArray(s.required)&&!s.required.every(k=>Object.prototype.hasOwnProperty.call(v,k as string)))return false;
    if(typeof s.maxProperties==='number'&&Object.keys(v).length>s.maxProperties)return false;
  }
  if(Array.isArray(v)){
    const prefix=(s.prefixItems??[]) as Schema[];
    for(let i=0;i<v.length;i++){
      if(i<prefix.length){if(!valid(prefix[i],v[i]))return false;}
      else if('items' in s&&!valid(s.items as Schema,v[i]))return false;
    }
    if(typeof s.minItems==='number'&&v.length<s.minItems)return false;
    if(typeof s.maxItems==='number'&&v.length>s.maxItems)return false;
    if(s.uniqueItems===true&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)return false;
  }
  if(typeof v==='number'){
    if(typeof s.minimum==='number'&&v<s.minimum)return false;
    if(typeof s.maximum==='number'&&v>s.maximum)return false;
    if(typeof s.exclusiveMinimum==='number'&&v<=s.exclusiveMinimum)return false;
  }
  if(typeof v==='string'){
    const n=[...v].length;
    if(typeof s.minLength==='number'&&n<s.minLength)return false;
    if(typeof s.maxLength==='number'&&n>s.maxLength)return false;
    if(typeof s.pattern==='string'&&!new RegExp(s.pattern,'u').test(v))return false;
  }
  if(Array.isArray(s.allOf)&&!s.allOf.every(x=>valid(x as Schema,v)))return false;
  if(Array.isArray(s.anyOf)&&!s.anyOf.some(x=>valid(x as Schema,v)))return false;
  if(Array.isArray(s.oneOf)&&s.oneOf.filter(x=>valid(x as Schema,v)).length!==1)return false;
  if('not' in s&&valid(s.not as Schema,v))return false;
  if('if' in s){const cond=valid(s.if as Schema,v);if(cond&&'then' in s&&!valid(s.then as Schema,v))return false;if(!cond&&'else' in s&&!valid(s.else as Schema,v))return false;}
  return true;
}
const schemaValid=(g:unknown)=>valid(SCHEMA,g);

describe('buck graph validator: valid graphs',()=>{
  it('accepts the §13 fixture through checkGraph, parseGraph and the JSON schema',()=>{
    expect(checkGraph(fixture())).toEqual([]);
    expect(parseGraph(FIXTURE).nodes).toHaveLength(7);
    expect(schemaValid(fixture())).toBe(true);
  });
  it('accepts vendor extensions, a pinned hash, keyframes and an optional unknown node',()=>{
    const g=mutate(g=>{
      g['x-acme']={anything:[1,2]};params(g,'fog')['x-acme-note']='frei';
      g.models['vda-small-rel@1'].weightsSha256=SHA;
      params(g,'fog').density={keys:[[0,1],[24,2.5]],interp:'smooth'};
      g.nodes.splice(5,0,{id:'grain',type:'film.grain@2',optional:true,inputs:{image:'fog'},params:{size:.3}} as never);
      node(g,'toDisplay').inputs.image='grain';
    });
    expect(checkGraph(g)).toEqual([]);expect(schemaValid(g)).toBe(true);
  });
  it('accepts an empty graph whose output is $source',()=>{
    const g=mutate(g=>{g.nodes=[];g.output='$source';delete g.fallback;});
    expect(checkGraph(g)).toEqual([]);expect(schemaValid(g)).toBe(true);
  });
});

describe('topoOrder',()=>{
  it('keeps the array order of the already sorted fixture',()=>{
    expect(topoOrder(fixture()).map(n=>n.id)).toEqual(['toLinear','nearMask','warmKey','bgMask','fog','toDisplay','fargo']);
  });
  it('breaks ties by array position (Kahn, lowest ready index first)',()=>{
    const g=mutate(g=>{const order=['fargo','bgMask','toDisplay','nearMask','fog','warmKey','toLinear'];g.nodes=order.map(id=>g.nodes.find(n=>n.id===id)!);});
    expect(topoOrder(g).map(n=>n.id)).toEqual(['bgMask','nearMask','toLinear','warmKey','fog','toDisplay','fargo']);
    expect(checkGraph(g)).toEqual([]);
  });
  it('throws BuckError on a cycle',()=>{
    const g=mutate(g=>{node(g,'toLinear').inputs.image='fargo';});
    expect(()=>topoOrder(g)).toThrow(BuckError);expect(()=>topoOrder(g)).toThrow(/Zyklus/);
  });
});

const INVALID:[string,(g:BuckGraph&Obj)=>void,RegExp][]=[
  ['wrong format',g=>{g.format='lut' as never;},/„format“ muss „buck“/],
  ['unknown MAJOR',g=>{g.formatVersion='2.0';},/Formatversion „2\.0“ wird nicht unterstützt/],
  ['minReaderVersion above reader',g=>{g.minReaderVersion='1.1';},/Readerversion „1\.1“/],
  ['malformed version',g=>{g.formatVersion='1';},/MAJOR\.MINOR/],
  ['unknown top-level field',g=>{g.foo=1;},/unbekanntes Feld „foo“/],
  ['unknown param field',g=>{params(g,'fog').haze=.2;},/Knoten „fog“\.params: unbekanntes Feld „haze“/],
  ['missing required param',g=>{delete params(g,'fog').density;},/Pflichtfeld „density“ fehlt/],
  ['param out of range',g=>{params(g,'fog').density=25;},/„density“ muss zwischen 0 und 20 liegen, ist aber 25/],
  ['look tint beyond ±0.3',g=>{(params(g,'fargo').look as Obj).shadows=[.31,0,0];},/„look\.shadows“\[0\] muss zwischen -0,3 und 0,3/],
  ['wrong param type',g=>{params(g,'nearMask').invert='nein';},/„invert“ muss true oder false/],
  ['unsorted keyframes',g=>{params(g,'fog').density={keys:[[10,1],[5,2]],interp:'linear'};},/streng aufsteigend/],
  ['keyframe interp enum',g=>{params(g,'fog').density={keys:[[0,1]],interp:'cubic'};},/interp muss einer der Werte/],
  ['keyframe value out of range',g=>{params(g,'fog').maxOpacity={keys:[[0,.5],[10,1.5]],interp:'hold'};},/keys\[1\] \(Wert\) muss zwischen 0 und 1/],
  ['empty keyframes',g=>{params(g,'fog').density={keys:[],interp:'linear'};},/1 bis 1000 Keyframes/],
  ['unknown color space',g=>{params(g,'toLinear').to='Rec.2020';},/„to“ muss einer der Werte/],
  ['display space as working linear',g=>{(g.colorManagement.working as Obj).linear='sRGB - Display';},/working\.linear muss einer der Werte/],
  ['wrong OCIO config',g=>{g.colorManagement.config='studio-config';},/colorManagement\.config/],
  ['duplicate node id',g=>{node(g,'bgMask').id='nearMask';},/„nearMask“ kommt mehrfach vor/],
  ['invalid node id',g=>{node(g,'fargo').id='fargo look';g.output='fargo look';},/Knoten-ID „fargo look“ muss/],
  ['undeclared $input',g=>{node(g,'fog').inputs.depth='$zdepth';},/nicht deklarierte Eingabe „\$zdepth“/],
  ['unknown node reference',g=>{node(g,'fog').inputs.mask='skyMask';},/unbekannten Knoten „skyMask“/],
  ['image into scalar port',g=>{node(g,'fog').inputs.depth='toLinear';},/Eingang „depth“ erwartet ein Skalarfeld, „toLinear“ liefert aber ein Bild/],
  ['vector into scalar port',g=>{node(g,'nearMask').inputs.depth='$normals';},/erwartet ein Skalarfeld, „\$normals“ liefert aber ein Vektorfeld/],
  ['required port not connected',g=>{delete node(g,'fog').inputs.depth;},/Pflichteingang „depth“ ist nicht verbunden/],
  ['unknown port',g=>{node(g,'fog').inputs.extra='bgMask';},/hat keinen Eingang „extra“/],
  ['cycle',g=>{node(g,'toLinear').inputs.image='fargo';},/Zyklus/],
  ['self reference',g=>{node(g,'bgMask').inputs.depth='bgMask';},/Zyklus|erwartet/],
  ['output missing',g=>{g.output='nichts';},/„output“ verweist auf den unbekannten Knoten/],
  ['output is a mask',g=>{g.output='bgMask';},/„output“ muss ein Bild liefern/],
  ['too many nodes',g=>{for(let i=0;i<LIMITS.nodes;i++)g.nodes.push({id:`m${i}`,type:'mask.combine@1',inputs:{a:'nearMask',b:'bgMask'},params:{op:'max'}} as never);},/höchstens 64/],
  ['path traversal in bakedLut',g=>{params(g,'fargo').bakedLut='luts/../../etc/x.cube';},/bakedLut“ verweist auf/],
  ['URL as fallback cube',g=>{g.fallback!.cube='https://example.com/x.cube';},/fallback\.cube verweist auf/],
  ['absolute thumbnail path',g=>{g.meta.thumbnails!.before='/Users/me/still.jpg';},/thumbnails\.before verweist auf/],
  ['mask image outside masks/',g=>{g.nodes.push({id:'vig',type:'mask.image@1',inputs:{},params:{file:'luts/vig.png',fit:'cover'}} as never);},/„file“ verweist auf „luts\/vig\.png“/],
  ['broken weights hash',g=>{g.models['vda-small-rel@1'].weightsSha256='1234abcd';},/kein gültiger SHA-256/],
  ['uppercase weights hash',g=>{g.models['vda-small-rel@1'].weightsSha256=SHA.toUpperCase();},/kein gültiger SHA-256/],
  ['ModelPin unknown field',g=>{(g.models['vda-small-rel@1'] as unknown as Obj).weightsUrl='https://x';},/unbekanntes Feld „weightsUrl“/],
  ['longSide not multiple',g=>{g.models['vda-small-rel@1'].preprocess.longSide=520;},/Vielfaches von „multipleOf“/],
  ['unknown required node type',g=>{g.nodes.push({id:'grain',type:'film.scratches@1',inputs:{image:'fargo'},params:{}} as never);},/Unbekannter Knotentyp „film\.scratches@1“/],
  ['invalid type name',g=>{g.nodes.push({id:'x',type:'Grain!',optional:true,inputs:{},params:{}} as never);},/kein gültiger Knotentypname/],
  ['estimate with undeclared model',g=>{(g.inputs.depth.sources[2] as Obj).model='depth-pro@1';},/nicht deklarierte Modell „depth-pro@1“/],
  ['derive from a non-depth input',g=>{(g.inputs.normals.sources[2] as Obj).from='normals';},/deklarierte Tiefen-Eingabe/],
  ['semantics on normals',g=>{(g.inputs.normals as unknown as Obj).semantics='metric';},/„semantics“ ist nur bei Tiefe erlaubt/],
  ['required without fail',g=>{g.inputs.depth.required=true;},/„onMissing“: „fail“/],
  ['relative depth without normalization',g=>{g.inputs.depth.normalize={mode:'none'};},/Relative Tiefe muss normiert werden/],
  ['reserved input name',g=>{g.inputs.source=g.inputs.depth;},/Eingabe „source“/],
  ['display image into linear node',g=>{node(g,'warmKey').inputs.image='$source';},/linearen Arbeitsraum „ACEScg“ arbeiten, bekommt aber „Rec\.1886 Rec\.709 - Display“/],
  ['convert from wrong space',g=>{params(g,'toDisplay').from='lin_rec709_srgb';},/erwartet ein Bild in „lin_rec709_srgb“, bekommt aber „ACEScg“/],
  ['output space mismatch',g=>{g.colorManagement.output='sRGB - Display';},/colorManagement\.output verlangt aber „sRGB - Display“/],
  ['look in a linear space',g=>{params(g,'fargo').space='ACEScg';},/display-bezogen/],
  ['depthRange feather below §9.2 minimum',g=>{params(g,'nearMask').feather=.01;},/„feather“ muss zwischen 0,02/],
  ['near above far',g=>{params(g,'bgMask').near=1.2;params(g,'bgMask').far=.9;},/„near“ muss höchstens „far“ sein/],
  ['linear fog without end',g=>{params(g,'fog').model='linear';},/Modus „linear“ ist der Parameter „end“ Pflicht/],
  ['kelvin outside Planckian approximation',g=>{params(g,'warmKey').color={kelvin:800};},/„color\.kelvin“ muss zwischen 1667 und 25000/],
  ['relight reshape not in v1',g=>{params(g,'warmKey').mode='reshape';},/„mode“ muss einer der Werte „add“/],
  ['dof physical on relative depth',g=>{g.nodes.splice(5,0,{id:'dof',type:'lens.dof@1',inputs:{image:'fog',depth:'$depth'},params:{mode:'physical',focusDistance:3,fNumber:2.8,focalLength:50,sensorWidth:36,maxBlur:.02,blades:0,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0}} as never);node(g,'toDisplay').inputs.image='dof';},/„physical“ braucht metrische Tiefe/],
  ['dof with 3 blades',g=>{g.nodes.splice(5,0,{id:'dof',type:'lens.dof@1',inputs:{image:'fog',depth:'$depth'},params:{mode:'artistic',focus:.3,focusRange:.1,blurNear:.01,blurFar:.01,maxBlur:.02,blades:3,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0}} as never);node(g,'toDisplay').inputs.image='dof';},/„blades“ muss 0 \(Kreis\) oder 5 bis 12/],
  ['mask.input on a depth input',g=>{g.nodes.push({id:'roto',type:'mask.input@1',inputs:{},params:{input:'$depth',channel:'r'}} as never);},/Art „mask“/],
  ['gradient feather zero',g=>{g.nodes.push({id:'grad',type:'mask.gradient@1',inputs:{},params:{shape:'radial',center:[.5,.28],radius:.4,feather:0,invert:false}} as never);},/„feather“ muss größer als 0/],
  ['amount above 1',g=>{node(g,'fog').amount=1.5;},/„amount“ muss zwischen 0 und 1/],
  ['timecode without rate',g=>{g.timing={reference:'timecode'};},/„rate“ Pflicht/],
  ['bad created timestamp',g=>{g.meta.created='30.10.2026';},/RFC 3339/],
  ['name too long',g=>{g.meta.name='x'.repeat(101);},/meta\.name muss 1 bis 100 Zeichen/],
  ['fallback covers unknown node',g=>{g.fallback!.covers=['grade'];},/unbekannten Knoten „grade“/],
  ['fallback lists a node twice',g=>{g.fallback!.omits=['fargo'];},/mehrfach in „covers“\/„omits“/],
  ['non-finite number',g=>{params(g,'fog').density=Infinity;},/nicht endliche Zahl/],
  ['graph too large',g=>{g['x-pad']='x'.repeat(LIMITS.graphBytes);},/Bytes groß/],
];

describe('buck graph validator: invalid graphs',()=>{
  it.each(INVALID)('rejects %s',(_,edit,message)=>{
    const g=mutate(edit),problems=checkGraph(g);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(message);
    // parseGraph reports the first problem as BuckError (round trip through text where JSON can carry the value).
    if(problems[0]!=='graph.json enthält eine nicht endliche Zahl.')expect(()=>parseGraph(JSON.stringify(g))).toThrow(BuckError);
  });
  it('reports every problem, not only the first, in a stable order',()=>{
    const g=mutate(g=>{g.format='lut' as never;params(g,'fog').density=25;g.output='nichts';});
    const a=checkGraph(g),b=checkGraph(mutate(g=>{g.format='lut' as never;params(g,'fog').density=25;g.output='nichts';}));
    expect(a.length).toBeGreaterThanOrEqual(3);expect(a).toEqual(b);
    expect(()=>parseGraph(JSON.stringify(g))).toThrow(a[0]);
  });
  it('rejects raw text problems before JSON.parse',()=>{
    expect(()=>parseGraph('{"format": "buck",')).toThrow(/kein gültiges JSON/);
    expect(()=>parseGraph(FIXTURE.replace('"format": "buck"','"format": "buck", "format": "buck"'))).toThrow(/Schlüssel „format“ mehrfach/);
    expect(()=>parseGraph('['.repeat(17)+']'.repeat(17))).toThrow(/tiefer als 16 Ebenen/);
    expect(()=>parseGraph('['.repeat(200000))).toThrow(/tiefer als 16 Ebenen/);
    expect(()=>parseGraph(FIXTURE.replace('"density": 2.2','"density": 1e400'))).toThrow(/nicht endliche Zahl/);
    expect(()=>parseGraph(' '.repeat(LIMITS.graphBytes+1))).toThrow(/Bytes groß/);
    expect(()=>parseGraph('"buck"')).toThrow(/JSON-Objekt/);
    // Escaped key spellings that decode to the same name are duplicates too.
    expect(()=>parseGraph(FIXTURE.replace('"format": "buck"','"format": "buck", "\\u0066ormat": "buck"'))).toThrow(/mehrfach/);
    // A key-like string inside a value is not a key.
    expect(()=>parseGraph(FIXTURE.replace('"prompt": "Fargo-Look"','"prompt": "\\"space\\": \\"x\\""'))).not.toThrow();
  });
  it('does not resolve inherited object properties as declared inputs',()=>{
    expect(checkGraph(mutate(g=>{node(g,'fog').inputs.depth='$toString';})).join('\n')).toMatch(/nicht deklarierte Eingabe „\$toString“/);
  });
});

describe('JSON schema docs/schema/buck-1.0.schema.json',()=>{
  it('declares draft 2020-12',()=>{expect(SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');});
  it.each([
    ['unknown top-level field',(g:BuckGraph&Obj)=>{g.foo=1;}],
    ['unknown param field',(g:BuckGraph&Obj)=>{params(g,'fog').haze=.2;}],
    ['param out of range',(g:BuckGraph&Obj)=>{params(g,'fog').density=25;}],
    ['keyframe value out of range',(g:BuckGraph&Obj)=>{params(g,'fog').maxOpacity={keys:[[0,1.5]],interp:'hold'};}],
    ['unknown required node type',(g:BuckGraph&Obj)=>{g.nodes.push({id:'grain',type:'film.scratches@1',inputs:{image:'fargo'},params:{}} as never);}],
    ['missing required port',(g:BuckGraph&Obj)=>{delete node(g,'fog').inputs.depth;}],
    ['broken weights hash',(g:BuckGraph&Obj)=>{g.models['vda-small-rel@1'].weightsSha256='1234abcd';}],
    ['path traversal',(g:BuckGraph&Obj)=>{params(g,'fargo').bakedLut='luts/../x.cube';}],
    ['unknown MAJOR',(g:BuckGraph&Obj)=>{g.formatVersion='2.0';}],
    ['dof blades 3',(g:BuckGraph&Obj)=>{g.nodes.push({id:'dof',type:'lens.dof@1',inputs:{image:'fog',depth:'$depth'},params:{mode:'artistic',focus:.3,focusRange:.1,blurNear:.01,blurFar:.01,maxBlur:.02,blades:3,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0}} as never);}],
  ])('rejects %s structurally',(_,edit)=>{expect(schemaValid(mutate(edit))).toBe(false);});
  it('mirrors PARAM_RANGES for every numeric parameter',()=>{
    const resolve=(s:unknown):Obj=>{let x=s as Obj;while(typeof x.$ref==='string')x=deref(x.$ref) as Obj;return x;};
    const child=(s:Obj,seg:string):Obj|undefined=>{
      const r=resolve(s);if(isObj(r.properties)&&seg in r.properties)return r.properties[seg] as Obj;
      // Lists of objects (light.practicals@1 points): ranges are named after the item field, e.g. points.x.
      if(isObj(r.items)){const c=child(r.items as Obj,seg);if(c)return c;}
      for(const k of ['anyOf','allOf','oneOf'])for(const b of (r[k]??[]) as Obj[]){const c=child(b,seg);if(c)return c;}
    };
    // Bounds reachable without crossing into named properties (keyframe frames carry none).
    const bounds=(s:unknown,lo:Set<number>,hi:Set<number>)=>{
      if(!isObj(s))return;const r=resolve(s);
      if(typeof r.minimum==='number')lo.add(r.minimum);if(typeof r.exclusiveMinimum==='number')lo.add(r.exclusiveMinimum);if(typeof r.maximum==='number')hi.add(r.maximum);
      for(const k of ['anyOf','allOf','oneOf','prefixItems'])for(const b of (r[k]??[]) as unknown[])bounds(b,lo,hi);
      if(isObj(r.items))bounds(r.items,lo,hi);
    };
    let checked=0;
    for(const [type,ranges] of Object.entries(PARAM_RANGES) as [NodeType,Record<string,[number,number]>][])for(const [path,[min,max]] of Object.entries(ranges)){
      const s=path.split('.').reduce<Obj|undefined>((x,seg)=>x&&child(x,seg),(SCHEMA.$defs as Obj)[`params:${type}`] as Obj);
      expect(s,`${type} ${path}`).toBeDefined();
      const lo=new Set<number>(),hi=new Set<number>();bounds(s,lo,hi);
      expect([[...lo],[...hi]],`${type} ${path}`).toEqual([[min],[max]]);checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('optics nodes and relight skinProtect (§5.3.3, §5.3.6–§5.3.8)',()=>{
  // Vignette, halation and grain between the fog and the display conversion, all in ACEScg; relight with skin protection.
  const optics=(edit:(n:Record<string,Obj>)=>void=()=>{})=>mutate(g=>{
    const nodes:Record<string,Obj>={
      vignette:{id:'vignette',type:'lens.vignette@1',inputs:{image:'fog'},params:{exposure:-1,radius:.3,softness:.45,roundness:.3}},
      halation:{id:'halation',type:'film.halation@1',inputs:{image:'vignette',mask:'bgMask'},params:{threshold:.8,knee:1.5,radius:.006,intensity:.6,color:{kelvin:2000},bloom:.2,bloomRadius:.012}},
      grain:{id:'grain',type:'film.grain@1',inputs:{image:'halation'},params:{size:.0007,intensity:{keys:[[0,.1],[24,.2]],interp:'linear'},response:.8,chroma:.3,seed:12,animate:true}},
    };
    edit(nodes);
    g.nodes.splice(5,0,...Object.values(nodes) as never[]);node(g,'toDisplay').inputs.image='grain';params(g,'warmKey').skinProtect=.8;
  });
  it('accepts them through checkGraph and the JSON schema',()=>{
    const g=optics();expect(checkGraph(g)).toEqual([]);expect(schemaValid(g)).toBe(true);
    const s=optics(n=>{delete (n.vignette.params as Obj).exposure;(n.vignette.params as Obj).strength=-.3;(n.vignette.params as Obj).center=[.5,.3];});
    expect(checkGraph(s)).toEqual([]);expect(schemaValid(s)).toBe(true);
  });
  it.each([
    ['vignette with strength and exposure',(n:Record<string,Obj>)=>{(n.vignette.params as Obj).strength=.3;},/Genau einer/],
    ['vignette without falloff amount',(n:Record<string,Obj>)=>{delete (n.vignette.params as Obj).exposure;},/Genau einer/],
    ['grain size below the lattice limit',(n:Record<string,Obj>)=>{(n.grain.params as Obj).size=.0001;},/„size“ muss zwischen 0,0002 und 0,01/],
    ['grain seed not an integer',(n:Record<string,Obj>)=>{(n.grain.params as Obj).seed=1.5;},/„seed“ muss eine ganze Zahl/],
    ['grain without animate',(n:Record<string,Obj>)=>{delete (n.grain.params as Obj).animate;},/Pflichtfeld „animate“/],
    ['halation radius too large',(n:Record<string,Obj>)=>{(n.halation.params as Obj).radius=.2;},/„radius“ muss zwischen 0 und 0,1/],
    ['optics on a depth port',(n:Record<string,Obj>)=>{(n.grain.inputs as Obj).depth='$depth';},/hat keinen Eingang „depth“/],
  ])('rejects %s (reader and schema)',(_,edit,re)=>{
    const g=optics(edit);expect(checkGraph(g).join('\n')).toMatch(re);expect(schemaValid(g)).toBe(false);
  });
  it('rejects optics in a display space (they work linear)',()=>{
    const g=mutate(g=>{g.nodes.push({id:'grain',type:'film.grain@1',inputs:{image:'fargo'},params:{size:.0007,intensity:.15,response:.8,chroma:.3,seed:0,animate:true}} as never);g.output='grain';});
    expect(checkGraph(g).join()).toMatch(/linearen Arbeitsraum/);
  });
  it('rejects relight skinProtect outside 0…1 in both',()=>{
    const g=mutate(g=>{params(g,'warmKey').skinProtect=1.2;});
    expect(checkGraph(g).join()).toMatch(/„skinProtect“ muss zwischen 0 und 1/);expect(schemaValid(g)).toBe(false);
  });
});
