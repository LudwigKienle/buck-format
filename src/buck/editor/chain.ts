import { DEFAULT_SETTINGS } from '../../color/engine';
import { NEUTRAL_LOOK } from '../../color/look';
import { DEFAULT_DEPTH_MODEL, INPAINT_MODEL, KNOWN_MODELS, depthSemantics } from '../depth/models';
import { skyPresetParams } from '../nodes/sky';
import { BuckError, LIMITS, LINEAR_SPACES, PORTS } from '../types';
import { topoOrder } from '../validate';
import type { BuckGraph, BuckNode, ColorManagement, InputDecl, ModelPin, NodeParamMap, NodeType, Ref, SpaceName } from '../types';
import type { NodeCatalogEntry } from './types';
/**
 * Pure graph edits for the editor (docs/BUCK_FORMAT.md §4.3, §5, §6, §8). Model: image nodes form one linear chain in array
 * order ($source → … → output); mask nodes stand apart and only reference `$inputs`, `$source` or other masks. Opened files are
 * brought into that form by openForEditing; a file whose image nodes do not form such a chain keeps its wiring untouched. The editor
 * owns every color.convert@1 whose id starts with "auto-": ensureConversions rebuilds them, so the writer always emits the
 * explicit conversions the reader requires (§8: a reader never inserts conversions itself).
 */
/** Catalog group: the shared NodeCatalogEntry groups plus „Optik“ (lens and film nodes). */
export type CatalogGroup=NodeCatalogEntry['group']|'Optik';
export type CatalogEntry=Omit<NodeCatalogEntry,'group'>&{group:CatalogGroup};
export const NODE_CATALOG:CatalogEntry[]=[
  {type:'color.look@1',label:'Look',group:'Farbe',description:'Buckswood-Farblook (Tönung, Kontrast, Sättigung, Hautschutz), display-bezogen.'},
  {type:'color.cdl@1',label:'ASC CDL',group:'Farbe',description:'Slope, Offset, Power je Kanal und Sättigung nach ASC CDL.'},
  {type:'color.lut3d@1',label:'3D-LUT',group:'Farbe',description:'Eingebettete .cube-LUT, tetraedrisch interpoliert.'},
  {type:'color.convert@1',label:'Farbraum-Konvertierung',group:'Farbe',description:'Wechselt zwischen zwei Farbräumen; einziger Ort für Raumwechsel im Graphen.'},
  {type:'atmos.fog@1',label:'Nebel',group:'Raum',description:'Tiefenbasierter Nebel bzw. Atmosphäre im linearen Arbeitsraum.'},
  {type:'lens.dof@1',label:'Tiefenschärfe',group:'Optik',description:'Unschärfe nach Tiefe mit Fokus, Blende und Bokeh-Form.'},
  {type:'lens.vignette@1',label:'Vignette',group:'Optik',description:'Abfall zum Bildrand, als Faktor oder in Blendenstufen, rund oder dem Bildformat folgend.'},
  {type:'film.halation@1',label:'Halation & Bloom',group:'Optik',description:'Rötlicher Lichthof um helle Spitzlichter wie bei Farbnegativfilm, optional neutrales Glühen.'},
  {type:'film.grain@1',label:'Filmkorn',group:'Optik',description:'Deterministisches Filmkorn, stärker in Mitten und Schatten, monochrom oder farbig, je Frame neu.'},
  {type:'fill.inpaint@1',label:'Retusche (Platte)',group:'Licht',description:'Setzt eine vorbereitete, retuschierte Platte ein (Bild-Eingabe $plate), etwa aus „Motiv entfernen“ unter Masken & Retusche.'},
  {type:'sky.replace@1',label:'Himmel ersetzen',group:'Raum',description:'Ersetzt den Himmel (ungültige oder ferne Tiefe) durch einen prozeduralen Himmel oder ein PNG.'},
  {type:'light.relight@1',label:'Relight',group:'Licht',description:'Zusätzliches Licht aus einer Richtung über Normalen.'},
  {type:'light.practicals@1',label:'Lampen & Lichtfarbe',group:'Licht',description:'Erkennt helle Lichtquellen im Bild, lässt sie leuchten (Glühen, Raumlicht) und färbt ihr Licht um.'},
  {type:'mask.depthRange@1',label:'Tiefenbereich',group:'Maske',description:'Maske für einen Tiefenbereich (Vorder-, Mittel-, Hintergrund).'},
  {type:'mask.gradient@1',label:'Verlauf',group:'Maske',description:'Linearer oder radialer Verlauf, z. B. Himmel, Vignette, Höhennebel.'},
  {type:'mask.luma@1',label:'Luminanz',group:'Maske',description:'Maske nach Helligkeit, begrenzt Lichter oder Schatten.'},
  {type:'mask.input@1',label:'Eingabemaske',group:'Maske',description:'Vom Host gelieferte Maske, z. B. eine Rotomaske.'},
  {type:'mask.image@1',label:'Maskenbild',group:'Maske',description:'Statische Formmaske aus einem PNG im Archiv.'},
  {type:'mask.combine@1',label:'Masken verknüpfen',group:'Maske',description:'Verknüpft zwei Masken (Multiplizieren, Maximum, Minimum, Abziehen, Screen).'},
  {type:'mask.refine@1',label:'Maske verfeinern',group:'Maske',description:'Weichzeichnen, Erweitern oder Schrumpfen und Gamma einer Maske.'},
];

const AUTO='auto-',DISPLAY:SpaceName='Rec.1886 Rec.709 - Display';
const ID_BASE:Record<NodeType,string>={
  'color.convert@1':'convert','color.look@1':'look','color.cdl@1':'cdl','color.lut3d@1':'lut',
  'atmos.fog@1':'fog','lens.dof@1':'dof','light.relight@1':'relight','sky.replace@1':'sky','light.practicals@1':'practicals',
  'mask.depthRange@1':'depthMask','mask.gradient@1':'gradientMask','mask.luma@1':'lumaMask','mask.input@1':'inputMask',
  'mask.image@1':'imageMask','mask.combine@1':'combineMask','mask.refine@1':'refineMask',
  'lens.vignette@1':'vignette','film.grain@1':'grain','film.halation@1':'halation','fill.inpaint@1':'inpaint',
};
type Template<T extends NodeType>={inputs:Record<string,Ref>;params:NodeParamMap[T]};
/** Masks default to "no restriction" or identity; image placeholders get wired by addNode. */
const DEFAULTS:{[T in NodeType]:()=>Template<T>}={
  'color.convert@1':()=>({inputs:{image:'$source'},params:{from:DISPLAY,to:'ACEScg'}}),
  'color.look@1':()=>({inputs:{image:'$source'},params:{space:DISPLAY,look:{...NEUTRAL_LOOK,shadows:[...NEUTRAL_LOOK.shadows],midtones:[...NEUTRAL_LOOK.midtones],highlights:[...NEUTRAL_LOOK.highlights]},skinProtection:DEFAULT_SETTINGS.skin}}),
  // ASC CDL identity (OCIO CDLTransform defaults); noClampFwd so adding the node changes no pixel, not even out-of-range ones.
  'color.cdl@1':()=>({inputs:{image:'$source'},params:{slope:[1,1,1],offset:[0,0,0],power:[1,1,1],saturation:1,style:'noClampFwd',space:DISPLAY}}),
  'color.lut3d@1':()=>({inputs:{image:'$source'},params:{file:'luts/eigene.cube',inputSpace:DISPLAY,outputSpace:DISPLAY}}),
  // Values of tests/fixtures/buck/fargo-fog-warm.json (spec §13).
  'atmos.fog@1':()=>({inputs:{image:'$source',depth:'$depth'},params:{model:'exponential',start:.55,density:2.2,color:[.78,.84,.92],luminance:1.6,maxOpacity:.75,skyProtect:.3}}),
  // Bokeh extras off: straight blades, no cat-eye, no highlight boost.
  'lens.dof@1':()=>({inputs:{image:'$source',depth:'$depth'},params:{mode:'artistic',focus:.3,focusRange:.1,blurNear:.006,blurFar:.012,maxBlur:.02,blades:7,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0}}),
  'light.relight@1':()=>({inputs:{image:'$source',normals:'$normals'},params:{azimuth:-70,elevation:20,color:{kelvin:3200},intensity:.8,softness:.6,mode:'add',preserveHighlights:.7}}),
  // Night preset in ACEScg (the default working space); horizon automatic.
  'sky.replace@1':()=>({inputs:{image:'$source',depth:'$depth'},params:skyPresetParams('night','ACEScg')}),
  // Warm tungsten practicals (2700 K), detection of bright compact sources between 0.2 % and 4 % of the image width.
  'light.practicals@1':()=>({inputs:{image:'$source',depth:'$depth'},params:{threshold:.9,softness:.3,contrast:2,minSize:.002,maxSize:.04,intensity:1.5,glow:1,glowRadius:.012,throw:.12,falloff:1,color:{kelvin:2700},recolor:.5}}),
  // feather 0.02 is the §9.2 minimum; [0, 1] covers the whole normalized depth, so the mask is 1 everywhere.
  'mask.depthRange@1':()=>({inputs:{depth:'$depth'},params:{near:0,far:1,feather:.02,invert:false}}),
  // Top→bottom ramp of a 16:9 frame (y = H/W = 0.5625 at the bottom edge).
  'mask.gradient@1':()=>({inputs:{},params:{shape:'linear',start:[.5,0],end:[.5,.5625],feather:.05,invert:false}}),
  'mask.luma@1':()=>({inputs:{image:'$source'},params:{low:0,high:1,softness:.1,space:DISPLAY}}),
  'mask.input@1':()=>({inputs:{},params:{input:'$mask',channel:'luma'}}),
  'mask.image@1':()=>({inputs:{},params:{file:'masks/maske.png',fit:'stretch'}}),
  'mask.combine@1':()=>({inputs:{},params:{op:'multiply'}}),
  'mask.refine@1':()=>({inputs:{},params:{blur:0,grow:0,gamma:1}}),
  // Optics start values (editorial): a soft vignette of −0.8 EV at the corners following the frame, fine 35 mm grain
  // (≈ 1.3 px at 1920 px) and a subtle red halation above linear 0.8 without bloom.
  'lens.vignette@1':()=>({inputs:{image:'$source'},params:{exposure:-.8,radius:.3,softness:.45,roundness:.3}}),
  'film.grain@1':()=>({inputs:{image:'$source'},params:{size:.0007,intensity:.08,response:.8,chroma:.2,seed:0,animate:true}}),
  'film.halation@1':()=>({inputs:{image:'$source'},params:{threshold:.8,knee:1.5,radius:.006,intensity:.5,color:[1,.22,.04],bloom:0}}),
  // The plate input is created by the aux panel ("Motiv entfernen"); a node added by hand points at `$plate`.
  'fill.inpaint@1':()=>({inputs:{image:'$source',plate:'$plate'},params:{}}),
};
/** A fresh node with default parameters. Image nodes start at `$source`; addNode wires them into the chain. */
export function defaultNode(type:NodeType,id:string):BuckNode{
  const t=DEFAULTS[type]();return {id,type,inputs:t.inputs,params:t.params} as BuckNode;
}

const known=(n:BuckNode)=>Object.prototype.hasOwnProperty.call(PORTS,n.type);
/** Unknown optional nodes count as image nodes when they have an `image` port, like the validator's bypass rule. */
const isImage=(n:BuckNode)=>known(n)?PORTS[n.type].output==='image':'image' in n.inputs;
export const isAutoNode=(n:BuckNode)=>n.type==='color.convert@1'&&n.id.startsWith(AUTO);
export const imageChain=(graph:BuckGraph)=>graph.nodes.filter(isImage);
export const maskNodes=(graph:BuckGraph)=>graph.nodes.filter(n=>!isImage(n));

function freshId(taken:Set<string>,base:string){let id=base,i=2;while(taken.has(id)||id==='source')id=`${base}-${i++}`;taken.add(id);return id;}
/** `base`, or `base-2`, `base-3`, … if taken. */
export const uniqueId=(graph:BuckGraph,base:string)=>freshId(new Set(graph.nodes.map(n=>n.id)),base);
const find=(graph:BuckGraph,id:string)=>{const n=graph.nodes.find(x=>x.id===id);if(!n)throw new BuckError(`Knoten „${id}“ gibt es nicht.`);return n;};
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

/** Space a node needs on its image input and the space it outputs (spec §8, PORTS.space). Undefined = passes through. */
function spaceRule(n:BuckNode,cm:ColorManagement):{needs?:SpaceName;gives?:SpaceName}{
  switch(n.type){
    case 'color.convert@1':return {needs:n.params.from,gives:n.params.to};
    case 'color.lut3d@1':return {needs:n.params.inputSpace,gives:n.params.outputSpace};
    case 'color.look@1':case 'color.cdl@1':return {needs:n.params.space,gives:n.params.space};
  }
  const rule=known(n)?PORTS[n.type].space:'any',s=rule==='linear'?cm.working.linear:rule==='display'?cm.working.display:undefined;
  return {needs:s,gives:s};
}
/** Space leaving each image node, assuming the conversions are in place. */
function outSpaces(graph:BuckGraph){
  const out=new Map<string,SpaceName>();let space=graph.colorManagement.input;
  for(const n of imageChain(graph)){const {needs,gives}=spaceRule(n,graph.colorManagement);space=n.enabled===false?needs??space:gives??space;out.set(n.id,space);}
  return out;
}

/**
 * The four levels of the image chain (recommendation 2): light → atmosphere → optics → grade, the order in which light
 * reaches the picture. An editor convention, not part of the format: files keep any order, the editor only shows it.
 */
export type Level='light'|'atmosphere'|'optics'|'grade';
export const LEVELS:{id:Level;label:string;description:string}[]=[
  {id:'light',label:'Licht',description:'Licht in der Szene, linear: Szenenbelichtung, zusätzliches Licht, Lampen.'},
  {id:'atmosphere',label:'Atmosphäre',description:'Was zwischen Szene und Kamera liegt: neuer Himmel, Nebel, Dunst.'},
  {id:'optics',label:'Optik',description:'Objektiv und Film: Tiefenschärfe, Vignette, Halation, Korn.'},
  {id:'grade',label:'Grade',description:'Farbgebung im Display-Raum: Look, CDL, 3D-LUT.'},
];
const LEVEL_INDEX:Record<Level,number>={light:0,atmosphere:1,optics:2,grade:3};
/** Order inside a level: lens before film, sky before fog, exposure before added light (10 per level). */
// Retouching comes before everything (rank −1): every later node, scene exposure included, must also act on the plate.
const SUB_RANK:Partial<Record<NodeType,number>>={'fill.inpaint@1':-1,'light.relight@1':1,'light.practicals@1':2,'sky.replace@1':10,'atmos.fog@1':11,
  'lens.dof@1':20,'lens.vignette@1':21,'film.halation@1':22,'film.grain@1':23};
/**
 * Level of an image node: color.cdl@1 in a linear space is scene exposure (light), in a display space grade; look and 3D-LUT
 * are grade. Conversions, masks and unknown nodes have no level.
 */
export function levelOf(n:BuckNode):Level|undefined{
  switch(n.type){
    case 'color.cdl@1':return LINEAR_SPACES.includes(n.params.space)?'light':'grade';
    case 'color.look@1':case 'color.lut3d@1':return 'grade';
  }
  const r=SUB_RANK[n.type];return r===undefined?undefined:LEVELS[Math.max(0,Math.floor(r/10))].id;
}
/** Fine rank for insertion: level·10 + position inside the level; undefined without a level. */
export function levelRank(n:BuckNode):number|undefined{
  const l=levelOf(n);if(!l)return undefined;
  return SUB_RANK[n.type]??LEVEL_INDEX[l]*10;
}
/**
 * Array index for a new image node of rank `rank`: before the first user image node of rank ≥ rank (`start`) or > rank
 * (`end`), else at the chain end; then back over masks and over conversions whose output space is not the space the new node
 * needs, so a linear node lands before a „to display“ conversion and a display node after it.
 */
export function levelIndex(graph:BuckGraph,rank:number,needs:SpaceName|undefined,edge:'start'|'end'):number{
  const nodes=graph.nodes;let i=nodes.length;
  for(let k=0;k<nodes.length;k++){
    const n=nodes[k];if(!isImage(n)||isAutoNode(n))continue;
    const r=levelRank(n);if(r!==undefined&&(edge==='start'?r>=rank:r>rank)){i=k;break;}
  }
  while(i>0){
    const p=nodes[i-1];
    if(!isImage(p)||(p.type==='color.convert@1'&&needs!==undefined&&p.params.to!==needs)){i--;continue;}
    break;
  }
  return i;
}
export interface LevelGroup {level:Level;nodes:BuckNode[];/** A run that comes after a run of a later level (only when the chain is not ordered). */outOfOrder:boolean;}
/**
 * Image chain grouped for display. Nodes without a level join the level of the next node that has one (else the previous one,
 * else grade). An ordered chain yields all four levels in order, empty ones included; otherwise the runs in chain order, and
 * each run that steps back to an earlier level is marked. Nothing is reordered.
 */
export function levelGroups(graph:BuckGraph):{ordered:boolean;groups:LevelGroup[]}{
  const chain=imageChain(graph),own=chain.map(levelOf),levels:Level[]=[];
  for(let k=0;k<chain.length;k++){
    let l=own[k];
    for(let j=k+1;!l&&j<chain.length;j++)l=own[j];
    levels.push(l??levels[k-1]??'grade');
  }
  const runs:LevelGroup[]=[];
  chain.forEach((n,k)=>{const last=runs[runs.length-1];if(last&&last.level===levels[k])last.nodes.push(n);else runs.push({level:levels[k],nodes:[n],outOfOrder:false});});
  let max=-1,ordered=true;
  for(const r of runs){const i=LEVEL_INDEX[r.level];if(i<max){r.outOfOrder=true;ordered=false;}max=Math.max(max,i);}
  if(!ordered)return {ordered,groups:runs};
  return {ordered,groups:LEVELS.map(l=>({level:l.id,nodes:runs.find(r=>r.level===l.id)?.nodes??[],outOfOrder:false}))};
}

/**
 * Drops references to nodes that no longer exist: an image node's mask port is disconnected, a mask's image port falls back
 * to `$source`, a mask whose required mask input vanished is removed (repeated until stable). Fallback lists are filtered.
 */
function prune(graph:BuckGraph):BuckGraph{
  let nodes=graph.nodes;
  for(let dropped=true;dropped;){
    dropped=false;const ids=new Set(nodes.map(n=>n.id));
    nodes=nodes.flatMap(n=>{
      let inputs:Record<string,Ref>|undefined;
      for(const [port,ref] of Object.entries(n.inputs)){
        if(ref.startsWith('$')||ids.has(ref))continue;
        if(port!=='image'&&!(port==='mask'&&isImage(n))){dropped=true;return [];}
        inputs??={...n.inputs};
        if(port==='image')inputs.image='$source';else delete inputs.mask;
      }
      return [inputs?{...n,inputs}:n];
    });
  }
  const ids=new Set(nodes.map(n=>n.id)),fb=graph.fallback;
  return {...graph,nodes,...fb?{fallback:{...fb,covers:fb.covers.filter(id=>ids.has(id)),omits:fb.omits.filter(id=>ids.has(id))}}:{}};
}

/**
 * True when the image nodes, in array order, form exactly the chain $source → … → output. Every graph the editor builds has
 * this form between edits; a foreign graph may not (side branches feeding mask.luma, or an array that is not in data-flow order).
 */
export function isLinearChain(graph:BuckGraph):boolean{
  let prev:Ref='$source';
  for(const n of imageChain(graph)){if(n.inputs.image!==prev)return false;prev=n.id;}
  return graph.output===prev;
}
/**
 * The editor may rebuild the image chain: it is linear, or it still has dangling references (an editor intermediate or a broken
 * graph; a validated foreign file never has them, so its wiring is always respected).
 */
function rebuildable(graph:BuckGraph):boolean{
  if(isLinearChain(graph))return true;
  const ids=new Set(graph.nodes.map(n=>n.id)),dangling=(r:Ref|undefined)=>r!==undefined&&!r.startsWith('$')&&!ids.has(r);
  return dangling(graph.output)||imageChain(graph).some(n=>dangling(n.inputs.image));
}
const IMAGE_LOCKED='Die Bildknoten dieses Looks bilden keine einfache Kette. Bildknoten lassen sich hier nicht hinzufügen, entfernen oder verschieben, damit sich das Ergebnis nicht unbemerkt ändert; Parameter und Masken bleiben bearbeitbar.';
/**
 * Nodes in topological order (array order on ties, spec §4.3), so array order equals data flow; the render is unchanged
 * because renderGraph evaluates in topoOrder anyway. `linear` tells whether the editor may rebuild the image chain.
 */
export function openForEditing(graph:BuckGraph):{graph:BuckGraph;linear:boolean}{
  const g={...graph,nodes:topoOrder(graph)};return {graph:g,linear:isLinearChain(g)};
}

/**
 * Leaves a graph that is not rebuildable (non-linear without dangling references) unchanged: rewiring it in array order would silently change its
 * result. Otherwise removes every auto conversion, wires the image chain in array order and inserts the minimal set of new auto conversions:
 * one before each node whose required space (PORTS.space) differs from the incoming one, and one after the last image node if
 * the chain does not end in colorManagement.output. Disabled nodes pass their (converted) input through, like the validator.
 */
export function ensureConversions(graph:BuckGraph):BuckGraph{
  return rebuildable(graph)?rebuildConversions(graph):graph;
}
function rebuildConversions(graph:BuckGraph):BuckGraph{
  const cm=graph.colorManagement,kept=graph.nodes.filter(n=>!isAutoNode(n)),taken=new Set(kept.map(n=>n.id));
  let lastImage=-1;kept.forEach((n,i)=>{if(isImage(n))lastImage=i;});
  const nodes:BuckNode[]=[];let space=cm.input,prev:Ref='$source';
  const convert=(to:SpaceName)=>{
    const id=freshId(taken,`${AUTO}to-${slug(to)}`);
    nodes.push({id,type:'color.convert@1',label:`Automatisch: ${space} → ${to}`,inputs:{image:prev},params:{from:space,to}});
    prev=id;space=to;
  };
  kept.forEach((n,i)=>{
    if(isImage(n)){
      const {needs,gives}=spaceRule(n,cm);
      if(needs&&needs!==space)convert(needs);
      nodes.push(n.inputs.image===prev?n:{...n,inputs:{...n.inputs,image:prev}});
      prev=n.id;if(n.enabled!==false&&gives)space=gives;
    }else nodes.push(n);
    if(i===lastImage&&space!==cm.output)convert(cm.output);
  });
  if(lastImage<0&&space!==cm.output)convert(cm.output);
  return prune({...graph,nodes,output:prev});
}

function depthDecl(pin:ModelPin|undefined):InputDecl{
  const semantics=pin?depthSemantics(pin):'relative-inverse';
  return {kind:'depth',semantics,required:false,
    sources:[{type:'host-clip',clip:'Depth'},{type:'cache'},...pin?[{type:'estimate' as const,model:DEFAULT_DEPTH_MODEL}]:[]],
    // §6.2: one scale/shift per shot from the 2 %/98 % percentiles; metric depth is not normalized.
    normalize:semantics==='metric'?{mode:'none'}:{mode:'shot-percentile',low:2,high:98},onMissing:'bypass-dependents'};
}
const normalsDecl=(from:string):InputDecl=>({kind:'normals',frame:'camera',required:false,
  sources:[{type:'host-clip',clip:'Normals'},{type:'cache'},{type:'derive',method:'normals-from-depth@1',from,params:{smoothing:.002}}],onMissing:'bypass-dependents'});
/** A plate referenced without a declaration: inpainted from `$subject` (editor/ml.ts keeps the same defaults). */
const plateDecl=():InputDecl=>({kind:'image',required:false,sources:[{type:'cache'},{type:'estimate',model:INPAINT_MODEL,hole:{input:'subject',grow:.006}}],onMissing:'bypass-dependents'});
const maskDecl=(name:string):InputDecl=>{
  const clip=name.replace(/[^A-Za-z0-9_]/g,'_').replace(/^[^A-Za-z]/,'M').slice(0,64);
  return {kind:'mask',required:false,sources:[{type:'host-clip',clip:clip.charAt(0).toUpperCase()+clip.slice(1)}],onMissing:'bypass-dependents'};
};

/**
 * Declares exactly the depth and normals inputs the nodes reference (normals derive from depth, so they keep it alive) and the
 * model pins their estimate sources name. Missing declarations follow the fixture; existing ones are kept verbatim. Declared
 * masks are added when referenced but never removed; image inputs (plates) live as long as a node references them. A declared
 * mask input named `sky` (sky segmentation, editor/ml.ts) is connected to the `sky` port of every sky.replace@1.
 */
export function ensureInputs(graph:BuckGraph):BuckGraph{
  const skyMask=graph.inputs.sky?.kind==='mask';
  if(skyMask&&graph.nodes.some(n=>n.type==='sky.replace@1'&&n.inputs.sky===undefined))
    graph={...graph,nodes:graph.nodes.map(n=>n.type==='sky.replace@1'&&n.inputs.sky===undefined?{...n,inputs:{...n.inputs,sky:'$sky'}}:n)};
  const used=new Map<string,InputDecl['kind']>();
  const use=(name:string,kind:InputDecl['kind'])=>{if(!used.has(name))used.set(name,kind);};
  for(const n of graph.nodes){
    for(const [port,ref] of Object.entries(n.inputs))if(ref.startsWith('$')&&ref!=='$source')use(ref.slice(1),port==='depth'?'depth':port==='normals'?'normals':port==='plate'?'image':'mask');
    if(n.type==='mask.input@1')use(n.params.input.replace(/^\$/,''),'mask');
  }
  const pin=KNOWN_MODELS[DEFAULT_DEPTH_MODEL],decls=new Map<string,InputDecl>();
  const need=(name:string,kind:InputDecl['kind'])=>{
    if(decls.has(name))return;
    const d=graph.inputs[name]??(kind==='depth'?depthDecl(pin):kind==='normals'?normalsDecl('depth'):kind==='image'?plateDecl():maskDecl(name));
    decls.set(name,d);
    for(const s of d.sources){if(s.type==='derive')need(s.from,'depth');if(s.type==='estimate'&&s.hole)need(s.hole.input,'mask');}
  };
  for(const [name,kind] of used)need(name,kind);
  for(const [name,d] of Object.entries(graph.inputs))if(d.kind==='mask')need(name,'mask');
  // Original key order first, new declarations after, so an unchanged graph serializes identically.
  const order=[...Object.keys(graph.inputs).filter(k=>decls.has(k)),...[...decls.keys()].filter(k=>!(k in graph.inputs))];
  const inputs:Record<string,InputDecl>={};for(const k of order)inputs[k]=decls.get(k)!;
  const wanted=new Set<string>();for(const d of Object.values(inputs))for(const s of d.sources)if(s.type==='estimate')wanted.add(s.model);
  const models:Record<string,ModelPin>={};
  for(const id of [...Object.keys(graph.models).filter(k=>wanted.has(k)),...[...wanted].filter(k=>!(k in graph.models))]){
    // Own-property lookups only: an id like "constructor" must not resolve to an Object.prototype member.
    const own=(o:Record<string,ModelPin>)=>Object.prototype.hasOwnProperty.call(o,id)?o[id]:undefined;
    const m=own(graph.models)??own(KNOWN_MODELS);if(m)models[id]=own(graph.models)??structuredClone(m);
  }
  return {...graph,inputs,models};
}

/** `image`: the edit rewired the image chain on purpose, so it is rebuilt in array order (callers checked rebuildable first). */
function finish(graph:BuckGraph,image=false):BuckGraph{
  const g=ensureInputs(image?rebuildConversions(graph):ensureConversions(graph));
  if(g.nodes.length>LIMITS.nodes)throw new BuckError(`Höchstens ${LIMITS.nodes} Knoten sind erlaubt (einschließlich automatischer Konvertierungen).`);
  return g;
}
const insertAt=(nodes:BuckNode[],index:number,node:BuckNode)=>[...nodes.slice(0,index),node,...nodes.slice(index)];

/**
 * Adds a node with default parameters. Image nodes with a level (levelOf) go to the end of their level (levelIndex), or right
 * after `afterId` when that image node is in the same level; `$source` puts any node at the chain start. Nodes without a level
 * (conversions) go after `afterId`, otherwise before the last color.look or at the end of the chain. Masks go after `afterId` if it is a mask, otherwise at the
 * end; combine/refine are fed from `afterId` or the last masks (a neutral gradient is created if there is none).
 */
export function addNode(graph:BuckGraph,type:NodeType,afterId?:string):{graph:BuckGraph;id:string}{
  const cm=graph.colorManagement,after=afterId&&afterId!=='$source'?find(graph,afterId):undefined;
  let node=defaultNode(type,uniqueId(graph,ID_BASE[type]));
  if(PORTS[type].output!=='image'){
    const masks=maskNodes(graph),anchor=after&&!isImage(after)?after:undefined;
    if((type==='mask.combine@1'||type==='mask.refine@1')&&!masks.length){
      const helper=addNode(graph,'mask.gradient@1');return addNode(helper.graph,type,helper.id);
    }
    const a=anchor??masks[masks.length-1],b=masks[masks.indexOf(a!)-1]??a;
    if(node.type==='mask.combine@1')node={...node,inputs:{a:a!.id,b:b!.id}};
    if(node.type==='mask.refine@1')node={...node,inputs:{mask:a!.id}};
    if(node.type==='mask.luma@1')node={...node,params:{...node.params,space:cm.input}};
    const index=anchor?graph.nodes.indexOf(anchor)+1:graph.nodes.length;
    return {graph:finish({...graph,nodes:insertAt(graph.nodes,index,node)}),id:node.id};
  }
  if(!rebuildable(graph))throw new BuckError(IMAGE_LOCKED);
  const nodes=graph.nodes,user=nodes.filter(n=>isImage(n)&&!isAutoNode(n)),looks=user.filter(n=>n.type==='color.look@1');
  // New CDL and LUT nodes work display-referred (grade); a CDL becomes scene exposure only when its space is set to linear.
  if(node.type==='color.cdl@1')node={...node,params:{...node.params,space:cm.working.display}};
  if(node.type==='color.lut3d@1')node={...node,params:{...node.params,inputSpace:cm.working.display,outputSpace:cm.working.display}};
  const level=levelOf(node),rank=levelRank(node);
  let index:number;
  if(afterId==='$source'){const first=nodes.findIndex(isImage);index=first<0?nodes.length:first;}
  else if(after&&isImage(after)&&(level===undefined||levelOf(after)===level))index=nodes.indexOf(after)+1;
  else if(rank!==undefined)index=levelIndex(graph,rank,spaceRule(node,cm).needs,'end');
  else if(looks.length)index=nodes.indexOf(looks[looks.length-1]);
  else if(user.length)index=nodes.indexOf(user[user.length-1])+1;
  else{const first=nodes.findIndex(isImage);index=first<0?nodes.length:first;}
  let prev:BuckNode|undefined;for(let i=index-1;i>=0&&!prev;i--)if(isImage(nodes[i]))prev=nodes[i];
  const incoming=prev?outSpaces(graph).get(prev.id)??cm.input:cm.input;
  if(node.type==='color.convert@1')node={...node,params:{from:incoming,to:LINEAR_SPACES.includes(incoming)?cm.working.display:cm.working.linear}};
  return {graph:finish({...graph,nodes:insertAt(nodes,index,node)},true),id:node.id};
}

/**
 * Inserts a ready-made image node (and the masks it uses, placed directly before it) at the start or end of its level and
 * rebuilds conversions and declarations. Used by the time-of-day switch. Throws on a chain the editor may not rebuild.
 */
export function insertByLevel(graph:BuckGraph,node:BuckNode,opts:{edge:'start'|'end';masks?:BuckNode[]}):BuckGraph{
  if(!rebuildable(graph))throw new BuckError(IMAGE_LOCKED);
  const rank=levelRank(node);if(rank===undefined)throw new BuckError(`„${node.type}“ gehört zu keiner Ebene der Bildkette.`);
  const index=levelIndex(graph,rank,spaceRule(node,graph.colorManagement).needs,opts.edge);
  const nodes=[...graph.nodes.slice(0,index),...opts.masks??[],node,...graph.nodes.slice(index)];
  return finish({...graph,nodes},true);
}
/** True when addNode, removeNode and insertByLevel may rewire the image chain of this graph. */
export const canRebuildChain=(graph:BuckGraph)=>rebuildable(graph);

/** Removes a node, rewires the chain and drops dangling mask references; masks fed by a removed combine/refine take its input. */
export function removeNode(graph:BuckGraph,id:string):BuckGraph{
  const node=find(graph,id),image=isImage(node);
  if(image&&!rebuildable(graph))throw new BuckError(IMAGE_LOCKED);
  const upstream=node.type==='mask.refine@1'?node.inputs.mask:node.type==='mask.combine@1'?node.inputs.a:undefined;
  const nodes=graph.nodes.filter(n=>n!==node).map(n=>{
    if(!upstream||isImage(n)||!Object.values(n.inputs).includes(id))return n;
    return {...n,inputs:Object.fromEntries(Object.entries(n.inputs).map(([port,ref])=>[port,ref===id?upstream:ref]))};
  });
  return finish(prune({...graph,nodes}),image);
}

/** Moves a node one step within its group (user image nodes or masks). Auto conversions and the ends of a group stay put. */
export function moveNode(graph:BuckGraph,id:string,dir:-1|1):BuckGraph{
  const node=find(graph,id);if(isAutoNode(node))return graph;
  const group=isImage(node)?graph.nodes.filter(n=>isImage(n)&&!isAutoNode(n)):maskNodes(graph),other=group[group.indexOf(node)+dir];
  if(!other)return graph;
  const image=isImage(node);if(image&&!rebuildable(graph))throw new BuckError(IMAGE_LOCKED);
  const i=graph.nodes.indexOf(node),j=graph.nodes.indexOf(other),nodes=[...graph.nodes];nodes[i]=other;nodes[j]=node;
  return finish({...graph,nodes},image);
}

/** Connects `maskId` (a mask node or `$name` of a declared mask input) to the mask port of an image node, or disconnects it. */
export function setMask(graph:BuckGraph,nodeId:string,maskId?:string):BuckGraph{
  const node=find(graph,nodeId);
  if(!isImage(node))throw new BuckError(`Knoten „${nodeId}“ ist kein Bildknoten und hat keinen Maskeneingang.`);
  if(isAutoNode(node))throw new BuckError('Automatische Konvertierungen bekommen keine Maske.');
  if(maskId!==undefined){
    const ok=maskId.startsWith('$')?graph.inputs[maskId.slice(1)]?.kind==='mask':!isImage(find(graph,maskId));
    if(!ok)throw new BuckError(`„${maskId}“ ist keine Maske.`);
  }
  const inputs=Object.fromEntries(Object.entries(node.inputs).filter(([port])=>port!=='mask'));if(maskId!==undefined)inputs.mask=maskId;
  return {...graph,nodes:graph.nodes.map(n=>n===node?{...n,inputs}:n)};
}
