import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { decode as decodePng } from 'fast-png';
import { Cpu, Download, FileUp, Trash2, Upload, Wand2, X } from 'lucide-react';
import { download, safeName } from '../../image';
import { exportBuckaux, importBuckaux } from '../aux/cache';
import { EXR_MAGIC, readExr } from '../aux/exr';
import { normalizeDepth } from '../aux/normalize';
import { sha256Hex } from '../container';
import { checkPin, estimateDepth } from '../depth/estimate';
import { HEURISTIC_LABEL, heuristicDepth, heuristicNormals } from '../depth/heuristic';
import { DEFAULT_DEPTH_MODEL, KNOWN_MODELS, MODEL_INFO, depthSemantics, isPinned } from '../depth/models';
import { resample, scalarField } from '../field';
import { hasPngMagic, sanitizePng } from '../png';
import { missingInputs } from '../render';
import { BuckError, LIMITS } from '../types';
import type { AuxChannels, BuckGraph, ImageBuf, InputDecl, ModelPin, ScalarField, SourceDecl } from '../types';
import { ensureInputs } from './chain';
import { analysisImage } from './ml';
import type { AuxState, DepthSourceKind, SourceImage, UpdateGraph } from './types';
/**
 * Aux channel panel of the .buck editor (spec §6). Never downloads anything: model weights, depth maps and caches
 * come only from files the user picks. Pure helpers are exported for tests.
 */
type Props={graph:BuckGraph;source?:SourceImage;aux:AuxState;setAux:(next:AuxState|((a:AuxState)=>AuxState))=>void;updateGraph:UpdateGraph};

export function depthInput(graph:BuckGraph):{name:string;decl:InputDecl}|undefined {
  const e=Object.entries(graph.inputs).find(([,d])=>d.kind==='depth');return e&&{name:e[0],decl:e[1]};
}
export const estimateModels=(decl?:InputDecl)=>[...new Set((decl?.sources??[]).flatMap(s=>s.type==='estimate'?[s.model]:[]))];
const own=<T,>(o:Record<string,T>,id:string)=>Object.prototype.hasOwnProperty.call(o,id)?o[id]:undefined;
/** The local registry entry (spec §6.3, §11.6): the only pin that is ever executed. Pins inside a .buck are untrusted data. */
export const registryPin=(id:string):ModelPin|undefined=>own(KNOWN_MODELS,id);
const sameValue=(a:unknown,b:unknown):boolean=>{
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>sameValue(x,b[i]));
  if(a&&b&&typeof a==='object'&&typeof b==='object'){const ka=Object.keys(a).sort(),kb=Object.keys(b).sort();return sameValue(ka,kb)&&ka.every(k=>sameValue((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));}
  return Object.is(a,b);
};
const PIN_FIELDS:[keyof ModelPin,string][]=[['weightsSha256','SHA-256'],['format','Format'],['output','Ausgabe'],['preprocess','Vorverarbeitung'],['temporal','Fensterung'],['postprocess','Nachverarbeitung']];
/** German names of the execution-relevant fields where the file's pin differs from the registry (the hash only if the registry has one). */
export function pinDifferences(filePin:ModelPin,reg:ModelPin):string[] {
  return PIN_FIELDS.filter(([k])=>(k!=='weightsSha256'||isPinned(reg))&&!sameValue(filePin[k],reg[k])).map(([,label])=>label);
}
export interface ModelTrust {
  /** Registry pin to execute; for an unpinned registry entry the hash the user confirmed in this session, if any. */
  pin?:ModelPin;
  /** The id is not in the local registry: nothing can run. */
  unknown:boolean;
  differs:string[];
}
export function modelTrust(graph:BuckGraph,id:string,confirmed?:string):ModelTrust {
  const reg=registryPin(id);if(!reg)return {unknown:true,differs:[]};
  const filePin=own(graph.models,id),pin=!isPinned(reg)&&confirmed?{...reg,weightsSha256:confirmed}:reg;
  return {pin,unknown:false,differs:filePin?pinDifferences(filePin,reg):[]};
}
export type PinStatus='match'|'mismatch'|'unpinned';
export const pinStatus=(pin:ModelPin,sha:string):PinStatus=>!isPinned(pin)?'unpinned':pin.weightsSha256===sha.toLowerCase()?'match':'mismatch';
/**
 * Writes the registry pin with the confirmed hash into the graph as provenance for the saved .buck. Execution never trusts it:
 * the hash counts only for this session (AuxPanel state) and is asked for again when the file is reopened.
 */
export function withPinnedHash(graph:BuckGraph,id:string,sha:string):BuckGraph {
  const reg=registryPin(id);if(!reg)throw new BuckError(`Modell „${id}“ steht nicht im lokalen Modellregister.`);
  if(!/^[0-9a-f]{64}$/.test(sha))throw new BuckError('Kein gültiger SHA-256-Wert.');
  return {...graph,models:{...graph.models,[id]:{...structuredClone(reg),weightsSha256:sha}}};
}
/** Replaces the file's pin by the registry entry (keeps a hash the registry lacks only if it came from withPinnedHash before). */
export function adoptRegistryPin(graph:BuckGraph,id:string):BuckGraph {
  const reg=registryPin(id);if(!reg)throw new BuckError(`Modell „${id}“ steht nicht im lokalen Modellregister.`);
  return {...graph,models:{...graph.models,[id]:structuredClone(reg)}};
}
/** Points every estimate source of the depth input at DEFAULT_DEPTH_MODEL; ensureInputs adds its pin and drops unused ones. */
export function switchToDefaultModel(graph:BuckGraph,inputName:string):BuckGraph {
  const decl=graph.inputs[inputName];if(!decl)return graph;
  const est:SourceDecl={type:'estimate',model:DEFAULT_DEPTH_MODEL},has=decl.sources.some(s=>s.type==='estimate');
  const sources=has?decl.sources.map(s=>s.type==='estimate'?est:s):[...decl.sources,est];
  return ensureInputs({...graph,inputs:{...graph.inputs,[inputName]:{...decl,sources}}});
}
/** Spec §6.2 defaults: shot-percentile with 2 % / 98 %. */
export function normalizeOpts(decl?:InputDecl){
  const n=decl?.normalize;return {mode:n?.mode??'shot-percentile',low:n?.low??2,high:n?.high??98};
}
/**
 * Bilinear resample (field.resample) that keeps invalid depth: values and validity are resampled separately and a pixel
 * whose valid weight is below one half becomes +Infinity (same threshold as prepareAux in ../render).
 */
export function resampleDepth(f:ScalarField,width:number,height:number):ScalarField {
  if(f.width===width&&f.height===height)return scalarField(width,height,new Float32Array(f.data));
  const n=f.data.length,vals=new Float32Array(n),ok=new Float32Array(n);
  for(let i=0;i<n;i++){const v=f.data[i];if(Number.isFinite(v)){vals[i]=v;ok[i]=1;}}
  const rv=resample(vals,f.width,f.height,1,width,height),rw=resample(ok,f.width,f.height,1,width,height),out=new Float32Array(width*height);
  for(let i=0;i<out.length;i++)out[i]=rw[i]>=.5?rv[i]/rw[i]:Infinity;
  return scalarField(width,height,out);
}

type Estimate=typeof estimateDepth;
/** Model run plus spec §6.2 normalization of the raw output (semantics = pin.output) to 0 = near … 1 = far. */
export async function estimateToDepth(image:ImageBuf,pin:ModelPin,weights:ArrayBuffer,decl:InputDecl|undefined,opts:{signal?:AbortSignal;onProgress?:(p:number)=>void},estimate:Estimate=estimateDepth){
  const r=await estimate(image,pin,weights,{signal:opts.signal,onProgress:opts.onProgress});
  const {mode,low,high}=normalizeOpts(decl),raw=resampleDepth(r.raw,image.width,image.height);
  const depth=normalizeDepth([raw],depthSemantics(pin),mode,low,high).frames[0];
  return {depth,sha:r.weightsSha256,label:`${pin.name} · sha256 ${r.weightsSha256.slice(0,8)}… · ${r.backend==='webgpu'?'WebGPU':'WASM'}`};
}

export interface DepthMap {values:Float32Array;width:number;height:number;format:string;}
/**
 * 8/16-bit grayscale PNG (RGB only when R = G = B) or a single-channel OpenEXR as values 0…1 (PNG: sample / (2^depth − 1),
 * PNG 3 §12.4). Depth is data: gAMA/sRGB/iCCP are ignored. Fully transparent PNG pixels count as invalid (+Infinity).
 */
export function decodeDepthMap(bytes:Uint8Array):DepthMap {
  if(bytes.length>=8&&new DataView(bytes.buffer,bytes.byteOffset,8).getInt32(0,true)===EXR_MAGIC){
    const f=readExr(bytes);
    if(f.kind!=='scalar')throw new BuckError('Die EXR-Datei hat drei Kanäle; erwartet wird ein einzelner Tiefenkanal.');
    checkSide(f.width,f.height);
    return {values:f.data,width:f.width,height:f.height,format:'OpenEXR'};
  }
  if(bytes.length<33||!hasPngMagic(bytes))throw new BuckError('Unbekanntes Format: erwartet wird PNG (8 oder 16 Bit) oder OpenEXR.');
  // IHDR size and decompressed volume are checked before fast-png inflates anything (png.ts).
  const clean=sanitizePng(bytes,'Tiefenkarte').png;
  let png;try{png=decodePng(clean,{checkCrc:true});}catch(e){throw new BuckError(`Die PNG-Datei ist beschädigt: ${e instanceof Error?e.message:String(e)}`);}
  if(png.palette||(png.depth!==8&&png.depth!==16))throw new BuckError('Bitte eine 8- oder 16-Bit-Graustufen-PNG verwenden (keine Palettenbilder).');
  const {width,height,channels:ch,data}=png,max=2**png.depth-1,n=width*height,values=new Float32Array(n),alpha=ch===2||ch===4,rgb=ch>=3;
  for(let i=0;i<n;i++){
    const o=i*ch,v=data[o];
    if(rgb&&(data[o+1]!==v||data[o+2]!==v))throw new BuckError('Die Tiefenkarte ist farbig (z. B. eine Farbskala). Bitte als Graustufenbild exportieren.');
    values[i]=alpha&&data[o+ch-1]===0?Infinity:v/max;
  }
  return {values,width,height,format:`PNG ${png.depth} Bit`};
}
function checkSide(w:number,h:number){
  if(!(w>=1&&h>=1&&w<=LIMITS.imageSide&&h<=LIMITS.imageSide))throw new BuckError(`Die Tiefenkarte ist ${w}×${h} Pixel groß, erlaubt sind höchstens ${LIMITS.imageSide}×${LIMITS.imageSide}.`);
}
/**
 * Depth map → normalized depth at the target size. normalize: percentile mapping of spec §6.2 with the declared mode
 * (single still, so 'none' falls back to per-frame); bright = near is treated as relative-inverse, so black (0) becomes
 * +Infinity (disparity 0 = infinitely far). Without normalize the values are taken as 0…1 (inverted for bright = near).
 */
export function depthFromMap(map:DepthMap,opts:{whiteNear:boolean;normalize:boolean;decl?:InputDecl;width?:number;height?:number}):ScalarField {
  const f=resampleDepth(scalarField(map.width,map.height,map.values as Float32Array<ArrayBuffer>),opts.width??map.width,opts.height??map.height);
  if(opts.normalize){
    const {mode,low,high}=normalizeOpts(opts.decl);
    return normalizeDepth([f],opts.whiteNear?'relative-inverse':'relative-depth',mode==='none'?'per-frame':mode,low,high).frames[0];
  }
  const out=f.data.map(v=>{if(!Number.isFinite(v))return Infinity;const d=opts.whiteNear?1-v:v;return d<0?0:d>1?1:d;});
  return scalarField(f.width,f.height,out);
}

const DEPTH_KINDS:DepthSourceKind[]=['none','estimate','upload','heuristic'];
/** aux.json meta (spec §6.4): provenance only, no timestamps, so equal channels give equal .buckaux bytes. */
export function auxMeta(graph:BuckGraph,aux:AuxState,source?:SourceImage,confirmed:Record<string,string>={}):Record<string,unknown> {
  const d=depthInput(graph),id=estimateModels(d?.decl)[0],pin=id?modelTrust(graph,id,own(confirmed,id)).pin:undefined;
  return {generator:'Buckswood Auto LUT · .buck-Editor',depthSource:aux.depthSource,depthLabel:aux.depthLabel??null,
    source:source?{name:source.name,width:source.image.width,height:source.image.height}:null,
    normalize:d?normalizeOpts(d.decl):null,model:aux.depthSource==='estimate'&&pin&&id?{id,name:pin.name,weightsSha256:pin.weightsSha256}:null};
}
/** Imported meta is untrusted data: only a known source kind and a shortened label string are taken over. */
export function auxFromBuckaux(r:{aux:AuxChannels;meta:Record<string,unknown>}):Pick<AuxState,'channels'|'depthSource'|'depthLabel'> {
  const kind=DEPTH_KINDS.find(k=>k===r.meta.depthSource),label=typeof r.meta.depthLabel==='string'?r.meta.depthLabel.slice(0,160):undefined;
  if(!r.aux.depth)return {channels:r.aux,depthSource:'none',depthLabel:undefined};
  return {channels:r.aux,depthSource:kind&&kind!=='none'?kind:'upload',depthLabel:`${label??'Tiefe'} · aus .buckaux`};
}
/** Aspect ratios differ by more than 1 % (aux channels would be stretched). */
export const aspectMismatch=(a:{width:number;height:number},b:{width:number;height:number})=>Math.abs(a.width/a.height-b.width/b.height)>.01*(b.width/b.height);

const KIND_LABEL:Record<DepthSourceKind,string>={none:'keine',estimate:'ML-Schätzung',upload:'Geladene Tiefenkarte',heuristic:'Behelf: Bildheuristik'};
const ON_MISSING:Record<InputDecl['onMissing'],string>={fail:'Rendern schlägt fehl','bypass-dependents':'abhängige Knoten werden überbrückt',constant:'Konstante als Ersatz'};
const describeSource=(s:SourceDecl)=>s.type==='host-clip'?`Host-Clip „${s.clip}“`:s.type==='cache'?'Analyse-Cache':s.type==='derive'?`abgeleitet aus „${s.from}“`:`Schätzung (${s.model})`;
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
// Layout essentials inline so the panel reads well even before buck.css styles these classes.
const BODY={display:'grid',gap:9,padding:'12px 15px 15px',fontSize:12} as const,ROW={display:'flex',flexWrap:'wrap',alignItems:'center',gap:8} as const;
const DL={display:'grid',gap:4,margin:0,fontSize:11} as const,DROW={display:'grid',gridTemplateColumns:'110px minmax(0,1fr)',gap:8} as const,DT={color:'var(--muted)'} as const,DD={margin:0,overflowWrap:'anywhere'} as const;
const H3={margin:'6px 0 0',fontSize:12,fontWeight:600} as const,NOTE={display:'block'} as const,BTN={justifySelf:'start'} as const;
const bytesDe=(n:number)=>`${n.toLocaleString('de-DE')} Byte`;

export function AuxPanel({graph,source,aux,setAux,updateGraph}:Props){
  const uid=useId(),depth=depthInput(graph),models=estimateModels(depth?.decl);
  const [modelChoice,setModelChoice]=useState<string>(),[whiteNear,setWhiteNear]=useState(true),[normalize,setNormalize]=useState(true);
  // Hashes the user confirmed for unpinned registry entries: a session-only extension of the local registry.
  const [confirmed,setConfirmed]=useState<Record<string,string>>({});
  const [hash,setHash]=useState<{name:string;size:number;sha:string;status:PinStatus}>(),[pending,setPending]=useState<{id:string;sha:string;weights:ArrayBuffer}>(),[notice,setNotice]=useState<string>();
  const onnxInput=useRef<HTMLInputElement>(null),mapInput=useRef<HTMLInputElement>(null),auxInput=useRef<HTMLInputElement>(null),dialog=useRef<HTMLDialogElement>(null);
  const controller=useRef<AbortController|undefined>(undefined),token=useRef(0);
  const modelId=modelChoice&&models.includes(modelChoice)?modelChoice:models[0],trust=modelId?modelTrust(graph,modelId,own(confirmed,modelId)):undefined;
  const pin=trust?.pin,info=modelId?own(MODEL_INFO,modelId):undefined;
  const ch=aux.channels,missing=missingInputs(graph,ch),hasChannels=!!(ch.depth||ch.normals||Object.keys(ch.masks).length);
  const normalsDerived=Object.values(graph.inputs).some(d=>d.kind==='normals'&&d.sources.some(s=>s.type==='derive'));

  useEffect(()=>()=>{token.current++;controller.current?.abort();},[]);
  useEffect(()=>{const d=dialog.current;if(!d)return;if(pending&&!d.open){d.returnValue='';d.showModal();}else if(!pending&&d.open)d.close();},[pending]);

  const fail=(e:unknown)=>setAux(a=>({...a,busy:false,progress:undefined,error:message(e)}));
  const begin=()=>{setNotice(undefined);setAux(a=>({...a,busy:true,progress:undefined,error:undefined}));return ++token.current;};
  const setDepth=(d:ScalarField,kind:DepthSourceKind,label:string)=>setAux(a=>({...a,channels:{...a.channels,depth:d,normals:kind==='heuristic'?heuristicNormals(d):undefined},depthSource:kind,depthLabel:label,busy:false,progress:undefined,error:undefined}));

  async function run(runPin:ModelPin,weights:ArrayBuffer){
    if(!source)return;
    const t=begin(),ctrl=new AbortController();controller.current=ctrl;
    setAux(a=>({...a,progress:0}));
    try{
      const r=await estimateToDepth(analysisImage(ch,source.image),runPin,weights,depth?.decl,{signal:ctrl.signal,onProgress:p=>{if(token.current===t)setAux(a=>({...a,progress:p}));}});
      if(token.current===t)setDepth(r.depth,'estimate',r.label);
    }catch(e){
      if(token.current!==t)return;
      if(ctrl.signal.aborted){setAux(a=>({...a,busy:false,progress:undefined}));setNotice('Tiefenschätzung abgebrochen.');}else fail(e);
    }finally{if(controller.current===ctrl)controller.current=undefined;}
  }
  async function onOnnx(file:File){
    if(!source||!pin||!modelId)return;
    const t=begin();
    try{
      const weights=await file.arrayBuffer(),sha=await sha256Hex(new Uint8Array(weights));
      if(token.current!==t)return;
      const status=pinStatus(pin,sha);setHash({name:file.name,size:file.size,sha,status});
      if(status==='mismatch')checkPin(sha,pin,false); // throws the German refusal with both hash prefixes
      if(status==='unpinned'){setAux(a=>({...a,busy:false}));setPending({id:modelId,sha,weights});return;}
      await run(pin,weights);
    }catch(e){if(token.current===t)fail(e);}
  }
  function accept(c:{id:string;sha:string;weights:ArrayBuffer}){
    setPending(undefined);
    const p=registryPin(c.id);if(!p)return;
    setConfirmed(m=>({...m,[c.id]:c.sha}));
    updateGraph(g=>withPinnedHash(g,c.id,c.sha));
    setHash(h=>h&&h.sha===c.sha?{...h,status:'match'}:h);
    void run({...p,weightsSha256:c.sha},c.weights);
  }
  async function onMap(file:File){
    const t=begin();
    try{
      if(file.size>LIMITS.entryBytes)throw new BuckError('Die Tiefenkarte ist größer als 64 MiB.');
      const map=decodeDepthMap(new Uint8Array(await file.arrayBuffer()));await tick();
      const d=depthFromMap(map,{whiteNear,normalize,decl:depth?.decl,width:source?.image.width,height:source?.image.height});
      if(token.current===t)setDepth(d,'upload',`Tiefenkarte „${file.name}“ · ${map.format} · ${whiteNear?'Weiß = nah':'Weiß = fern'}${normalize?' · normiert':''}`);
      if(token.current===t&&source&&aspectMismatch(map,source.image))setNotice('Das Seitenverhältnis der Tiefenkarte weicht vom Ausgangsbild ab; sie wurde verzerrt angepasst.');
    }catch(e){if(token.current===t)fail(e);}
  }
  async function onHeuristic(){
    if(!source)return;
    const t=begin();
    try{await tick();const d=heuristicDepth(analysisImage(ch,source.image));if(token.current===t)setDepth(d,'heuristic',HEURISTIC_LABEL);}catch(e){if(token.current===t)fail(e);}
  }
  async function onImport(file:File){
    const t=begin();
    try{
      const next=auxFromBuckaux(importBuckaux(new Uint8Array(await file.arrayBuffer())));
      if(token.current!==t)return;
      setAux(a=>({...a,...next,busy:false,progress:undefined,error:undefined}));
      const d=next.channels.depth;
      if(source&&d&&aspectMismatch(d,source.image))setNotice('Das Seitenverhältnis des Analyse-Caches weicht vom Ausgangsbild ab. Gehört er zu diesem Shot?');
    }catch(e){if(token.current===t)fail(e);}
  }
  function onExport(){
    try{
      const bytes=exportBuckaux(ch,auxMeta(graph,aux,source,confirmed)),base=(source?.name??graph.meta.name).replace(/\.[^.]+$/,'');
      download(bytes as Uint8Array<ArrayBuffer>,`${safeName(base)}.buckaux`,'application/zip');
    }catch(e){fail(e);}
  }
  const pick=(fn:(f:File)=>void)=>(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];e.target.value='';if(f)fn(f);};
  const busy=aux.busy,canEstimate=!!source&&!!pin&&!!info?.available&&!busy;

  return <section className="buck-panel buck-aux control-panel" aria-labelledby={`${uid}-t`} aria-busy={busy}>
    <h2 id={`${uid}-t`}>Hilfskanäle</h2>
    <div style={BODY}>
    <dl className="buck-aux-status" style={DL}>
      <div className="buck-row" style={DROW}><dt style={DT}>Tiefe</dt><dd style={DD}>{aux.depthSource!=='none'&&aux.depthLabel?.startsWith(KIND_LABEL[aux.depthSource])?aux.depthLabel:<>{KIND_LABEL[aux.depthSource]}{aux.depthLabel&&aux.depthSource!=='none'?<> · {aux.depthLabel}</>:null}</>}</dd></div>
      <div className="buck-row" style={DROW}><dt style={DT}>Auflösung</dt><dd style={DD}>{ch.depth?`${ch.depth.width} × ${ch.depth.height} px`:'–'}{ch.depth&&source&&(ch.depth.width!==source.image.width||ch.depth.height!==source.image.height)?' (wird auf Bildgröße skaliert)':''}</dd></div>
      <div className="buck-row" style={DROW}><dt style={DT}>Normalen</dt><dd style={DD}>{ch.normals?`vorhanden · ${ch.normals.width} × ${ch.normals.height} px`:normalsDerived?(ch.depth?'werden aus der Tiefe abgeleitet':'werden aus der Tiefe abgeleitet, sobald eine vorliegt'):'keine'}</dd></div>
      {Object.keys(ch.masks).length>0&&<div className="buck-row" style={DROW}><dt style={DT}>Masken</dt><dd style={DD}>{Object.keys(ch.masks).sort().join(', ')}</dd></div>}
      {depth&&<div className="buck-row" style={DROW}><dt style={DT}>Quellen laut Graph</dt><dd style={DD}>{depth.decl.sources.map(describeSource).join(' → ')||'keine'}</dd></div>}
    </dl>
    {missing.length>0&&<div className="buck-note buck-warning" style={NOTE} role="note"><strong>Fehlende Eingaben:</strong><ul>{missing.map(name=><li key={name}><code>${name}</code> – {ON_MISSING[graph.inputs[name].onMissing]}</li>)}</ul></div>}
    {depth?.decl.sources.some(s=>s.type==='host-clip')&&<p className="buck-note" style={NOTE}>Im Web-Editor gibt es keine Host-Clips. Tiefe hier schätzen, als Datei laden oder aus einem Analyse-Cache übernehmen.</p>}
    {aux.error&&<p className="buck-error" role="alert">{aux.error}</p>}
    <p className="buck-note" style={NOTE} role="status" aria-live="polite">{notice??''}</p>
    {busy&&<div className="buck-row buck-progress" style={ROW}>
      {aux.progress!==undefined?<progress max={1} value={aux.progress} aria-label="Fortschritt der Tiefenschätzung">{Math.round(aux.progress*100)} %</progress>:<progress aria-label="Wird verarbeitet"/>}
      {aux.progress!==undefined&&<span>{Math.round(aux.progress*100)} %</span>}
      {aux.progress!==undefined&&<button type="button" className="buck-button buck-tool" style={BTN} onClick={()=>controller.current?.abort()}><X size={14}/>Abbrechen</button>}
    </div>}

    <h3 style={H3}>Tiefe schätzen</h3>
    {!depth?<p className="buck-note" style={NOTE}>Der Graph deklariert keine Tiefe. Sie wird gebraucht, sobald ein Nebel-, Tiefenschärfe-, Relight- oder Tiefenbereichsknoten im Graphen ist.</p>
    :!modelId?<p className="buck-note" style={NOTE}>Die Tiefeneingabe „{depth.name}“ nennt kein schätzbares Modell.</p>
    :!pin?<>
      <p className="buck-note buck-warning" style={NOTE} role="note">Das Modell „{modelId}“ steht nicht im lokalen Modellregister. Modelle und Pins aus einer .buck-Datei werden nie ausgeführt (§6.3, §11.6).</p>
      <button type="button" className="buck-button buck-tool" style={BTN} onClick={()=>{setModelChoice(undefined);updateGraph(g=>switchToDefaultModel(g,depth.name));}}>Auf „{KNOWN_MODELS[DEFAULT_DEPTH_MODEL].name}“ umstellen</button>
    </>
    :<>
      {models.length>1&&<label className="buck-row buck-field"><span>Modell</span><select value={modelId} onChange={e=>setModelChoice(e.target.value)}>{models.map(id=><option key={id} value={id}>{registryPin(id)?.name??id}</option>)}</select></label>}
      {trust&&trust.differs.length>0&&<div className="buck-note buck-warning" style={NOTE} role="note">Der Pin in der Datei weicht vom lokalen Register ab ({trust.differs.join(', ')}). Ausgeführt wird nur der Registereintrag; die Angaben der Datei werden ignoriert.
        <button type="button" className="buck-button buck-tool" style={BTN} onClick={()=>updateGraph(g=>adoptRegistryPin(g,modelId))}>Registereintrag in den Graphen übernehmen</button></div>}
      <dl className="buck-aux-status" style={DL}>
        <div className="buck-row" style={DROW}><dt style={DT}>Modell</dt><dd style={DD}>{pin.name} <small>({modelId})</small></dd></div>
        <div className="buck-row" style={DROW}><dt style={DT}>Lizenz</dt><dd style={DD}>{pin.license||'nicht angegeben'} – vor Weitergabe oder kommerzieller Nutzung selbst prüfen</dd></div>
        <div className="buck-row" style={DROW}><dt style={DT}>Herkunft</dt><dd style={DD}><code className="buck-hash">{pin.upstream}</code>{pin.revision&&<> · Revision <code className="buck-hash">{pin.revision.slice(0,12)}</code></>}</dd></div>
        <div className="buck-row" style={DROW}><dt style={DT}>Pin</dt><dd style={DD}>{isPinned(pin)?<>SHA-256 <code className="buck-hash" title={pin.weightsSha256}>{pin.weightsSha256.slice(0,16)}…</code></>:'nicht gepinnt – der Hash wird beim ersten Lauf festgelegt'}</dd></div>
      </dl>
      {info&&<p className="buck-note" style={NOTE}>{info.note}{info.file&&<> Datei: <code>{info.file}</code>{info.bytes?` (${bytesDe(info.bytes)})`:''}.</>} Es wird nichts automatisch heruntergeladen.</p>}
      {info?.available===false&&modelId!==DEFAULT_DEPTH_MODEL&&<button type="button" className="buck-button buck-tool" style={BTN} onClick={()=>{setModelChoice(undefined);updateGraph(g=>switchToDefaultModel(g,depth.name));}}>Auf „{KNOWN_MODELS[DEFAULT_DEPTH_MODEL].name}“ umstellen</button>}
      <input ref={onnxInput} type="file" accept=".onnx" hidden onChange={pick(f=>void onOnnx(f))} aria-label="ONNX-Modelldatei wählen"/>
      <button type="button" className="buck-button buck-tool" style={BTN} disabled={!canEstimate} onClick={()=>onnxInput.current?.click()} title={source?undefined:'Zuerst ein Ausgangsbild laden'}><Cpu size={14}/>Tiefe schätzen (ONNX-Datei wählen)</button>
      {hash&&<p className="buck-note" style={NOTE}>„{hash.name}“ · {bytesDe(hash.size)}<br/>SHA-256 <code className="buck-hash">{hash.sha}</code><br/>{hash.status==='match'?'Passt zum Pin.':hash.status==='mismatch'?'Passt nicht zum Pin – Ausführung verweigert.':'Modell ist noch nicht gepinnt.'}{info?.bytes&&info.bytes!==hash.size?` Erwartete Größe laut Register: ${bytesDe(info.bytes)}.`:''}</p>}
    </>}

    <h3 style={H3}>Tiefenkarte laden</h3>
    <div className="buck-segmented segmented" style={BTN} role="group" aria-label="Bedeutung heller Werte">
      <button type="button" aria-pressed={whiteNear} onClick={()=>setWhiteNear(true)}>Weiß = nah</button>
      <button type="button" aria-pressed={!whiteNear} onClick={()=>setWhiteNear(false)}>Weiß = fern</button>
    </div>
    <label className="buck-row buck-check"><input type="checkbox" checked={normalize} onChange={e=>setNormalize(e.target.checked)}/><span>Perzentil-Normierung ({normalizeOpts(depth?.decl).low} % / {normalizeOpts(depth?.decl).high} %)</span></label>
    <p className="buck-note" style={NOTE}>16- oder 8-Bit-Graustufen-PNG oder OpenEXR (ein Kanal, unkomprimiert). {whiteNear&&normalize?'Reines Schwarz gilt dabei als unendlich fern (Himmel).':''}</p>
    <input ref={mapInput} type="file" accept=".png,.exr,image/png,image/x-exr" hidden onChange={pick(f=>void onMap(f))} aria-label="Tiefenkarte wählen"/>
    <button type="button" className="buck-button buck-tool" style={BTN} disabled={busy} onClick={()=>mapInput.current?.click()}><Upload size={14}/>Tiefenkarte laden</button>

    <h3 style={H3}>Behelf</h3>
    <p className="buck-note" style={NOTE}><strong>Keine Tiefenmessung:</strong> grobe Schätzung aus Bildlage, Dunst, Kontrast und Sättigung. Nur zum Ausprobieren, wenn kein Modell und keine Tiefenkarte vorliegt.</p>
    <button type="button" className="buck-button buck-tool" style={BTN} disabled={!source||busy} onClick={()=>void onHeuristic()}><Wand2 size={14}/>Behelf: Bildheuristik</button>
    {ch.depth&&<button type="button" className="buck-button buck-tool" style={BTN} disabled={busy} onClick={()=>{setNotice(undefined);setAux(a=>({...a,channels:{...a.channels,depth:undefined,normals:undefined},depthSource:'none',depthLabel:undefined,error:undefined}));}}><Trash2 size={14}/>Tiefe verwerfen</button>}

    <h3 style={H3}>Analyse-Cache (.buckaux)</h3>
    <div className="buck-row" style={ROW}>
      <button type="button" className="buck-button buck-tool" style={BTN} disabled={!hasChannels||busy} onClick={onExport}><Download size={14}/>.buckaux exportieren</button>
      <input ref={auxInput} type="file" accept=".buckaux,application/zip" hidden onChange={pick(f=>void onImport(f))} aria-label=".buckaux-Datei wählen"/>
      <button type="button" className="buck-button buck-tool" style={BTN} disabled={busy} onClick={()=>auxInput.current?.click()}><FileUp size={14}/>.buckaux importieren</button>
    </div>

    <dialog ref={dialog} className="buck-dialog" aria-labelledby={`${uid}-d`} aria-describedby={`${uid}-dd`} onClose={()=>{const d=dialog.current,c=pending;if(d?.returnValue==='confirm'&&c)accept(c);else setPending(undefined);}}>
      <form method="dialog">
        <h2 id={`${uid}-d`}>Diesen Hash als Modell festlegen?</h2>
        <div id={`${uid}-dd`}>
          <p>„{pin?.name??pending?.id}“ hat im lokalen Register keinen Hash. Mit „Festlegen“ gilt dieser SHA-256-Wert für diese Sitzung und wird als Herkunft in den Graphen geschrieben; ein Hash aus einer geöffneten Datei zählt nie als Freigabe.</p>
          <p><code className="buck-hash">{pending?.sha}</code></p>
          <p>Lizenz laut Pin: {pin?.license||'nicht angegeben'} · Herkunft: <code>{pin?.upstream}</code></p>
        </div>
        <div className="buck-row" style={ROW}>
          <button type="submit" value="cancel" className="buck-button buck-tool" style={BTN} autoFocus>Abbrechen</button>
          <button type="submit" value="confirm" className="buck-button buck-tool" style={BTN}>Festlegen und schätzen</button>
        </div>
      </form>
    </dialog>
    </div>
  </section>;
}
