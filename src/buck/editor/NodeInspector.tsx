import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Eraser, FileUp, Info } from 'lucide-react';
import { lumaWeights, isLinearSpace } from '../colorspace';
import { PARAM_RANGES } from '../validate';
import { parseCube } from '../nodes/color';
import { decodeMaskPng } from '../nodes/masks';
import { BuckError, LIMITS, PORTS, SPACE_NAMES } from '../types';
import type { Animatable, BuckGraph, BuckNode, NodeOf, NodeParamMap, NodeType, RGB } from '../types';
import { addNode, defaultNode, isAutoNode, maskNodes, setMask } from './chain';
import { AnimField, CheckField, ColorField, Hint, NumberField, PointField, RGBField, Section, SelectField, TextField, catalogEntry, nodeTitle, options } from './controls';
import type { NumberFieldProps, Range } from './controls';
import { tidy } from './NodeStack';
import type { UpdateGraph, UpdateNode } from './types';

type MaskPreset='background'|'foreground'|'top';
export const MASK_PRESETS:Record<MaskPreset,string>={background:'Neue Maske: Hintergrund',foreground:'Neue Maske: Vordergrund',top:'Neue Maske: Verlauf oben'};
/**
 * Background/foreground ranges are the bgMask/nearMask values of the spec §13 example (tests/fixtures/buck/fargo-fog-warm.json).
 * "Verlauf oben" is 1 at the top edge and fades out by the middle of a 16:9 frame (y = 0.5625/2); feather is the chain default.
 */
export function newMask(graph:BuckGraph,preset:MaskPreset):{graph:BuckGraph;id:string}{
  if(preset==='top'){
    const r=addNode(graph,'mask.gradient@1');
    return {id:r.id,graph:patchNode(r.graph,r.id,n=>n.type==='mask.gradient@1'?{...n,label:'Verlauf oben',params:{...n.params,shape:'linear',start:[.5,.28125],end:[.5,0]}}:n)};
  }
  const r=addNode(graph,'mask.depthRange@1'),bg=preset==='background';
  return {id:r.id,graph:patchNode(r.graph,r.id,n=>n.type==='mask.depthRange@1'?{...n,label:bg?'Hintergrund':'Vordergrund',params:{...n.params,...bg?{near:.55,far:1,feather:.15}:{near:0,far:.6,feather:.12}}}:n)};
}
/** Mask choice of an image node: '' = none, a mask node id, `$name` of a declared mask input, or `new:<preset>`. */
export function applyMaskChoice(graph:BuckGraph,nodeId:string,choice:string):{graph:BuckGraph;created?:string}{
  if(choice.startsWith('new:')){
    const r=newMask(graph,choice.slice(4) as MaskPreset);
    return {graph:tidy(setMask(r.graph,nodeId,r.id)),created:r.id};
  }
  return {graph:tidy(setMask(graph,nodeId,choice||undefined))};
}
export const patchNode=(graph:BuckGraph,id:string,fn:(n:BuckNode)=>BuckNode):BuckGraph=>({...graph,nodes:graph.nodes.map(n=>n.id===id?fn(n):n)});
/** Mask nodes that may feed `id` without forming a cycle (not itself, not anything downstream of it). */
export function maskSources(graph:BuckGraph,id:string):BuckNode[]{
  const down=new Set([id]);
  for(let grew=true;grew;){grew=false;for(const n of graph.nodes)if(!down.has(n.id)&&Object.values(n.inputs).some(r=>down.has(r))){down.add(n.id);grew=true;}}
  return maskNodes(graph).filter(n=>!down.has(n.id));
}
/** Removes the luma part of a Rec.709 tint (LookSpec tints are zero-luma offsets) and clamps to the tint range. */
export function zeroLuma(t:RGB,[min,max]:Range):RGB{
  const w=lumaWeights('Rec.1886 Rec.709 - Display'),y=w[0]*t[0]+w[1]*t[1]+w[2]*t[2];
  return t.map(v=>Math.min(max,Math.max(min,Number((v-y).toFixed(6))))) as RGB;
}
/** Parameters whose lower bound is exclusive in validate.ts (EXCLUSIVE_MIN is not exported, mirrored here). */
const EXCLUSIVE=new Set(['color.cdl@1:power','mask.gradient@1:radius','mask.gradient@1:feather','mask.luma@1:softness','mask.refine@1:gamma']);
// UI start values for physical DOF (no defaults in chain.ts): full-frame sensor 36 mm wide, 50 mm lens, f/2.8, 3 m.
const PHYSICAL={focusDistance:3,fNumber:2.8,focalLength:50,sensorWidth:36};
const LUT_FILE=/^luts\/[a-z0-9_-][a-z0-9._-]{0,99}\.cube$/,MASK_FILE=/^masks\/[a-z0-9_-][a-z0-9._-]{0,99}\.png$/;
const DISPLAY_SPACES=SPACE_NAMES.filter(s=>!isLinearSpace(s));
const SPACE_OPTS=options(SPACE_NAMES),DISPLAY_OPTS=options(DISPLAY_SPACES);
const LABEL_MAX=100;

/**
 * Validates a user-picked .cube or mask PNG with the reader's limits (parseCube; decodeMaskPng incl. the PNG gate of png.ts) and
 * returns its archive path: luts/<name>.cube or masks/<name>.png from the file name, suffixed -2, -3 … when another file holds it.
 */
export function archivePath(kind:'lut'|'mask',fileName:string,bytes:Uint8Array,files:ReadonlyMap<string,Uint8Array>):string {
  if(bytes.length>LIMITS.entryBytes)throw new BuckError(`„${fileName}“ ist größer als 64 MiB.`);
  const [dir,ext,re]=kind==='lut'?['luts','.cube',LUT_FILE]:['masks','.png',MASK_FILE];
  const stem=fileName.toLowerCase().replace(/\.[^.]*$/,'').replace(/[^a-z0-9._-]+/g,'_').replace(/^[^a-z0-9_-]+/,'').slice(0,90)||(kind==='lut'?'lut':'maske');
  if(kind==='lut'){
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new BuckError(`„${fileName}“ ist kein gültiges UTF-8.`);}
    parseCube(text);
  }else decodeMaskPng(bytes,fileName);
  const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
  for(let i=1;;i++){
    const path=`${dir}/${stem}${i>1?`-${i}`:''}${ext}`,held=files.get(path);
    if(!re.test(path))throw new BuckError(`Aus „${fileName}“ lässt sich kein gültiger Archivpfad bilden.`);
    if(!held||same(held,bytes))return path;
  }
}
type SetFile=(path:string,bytes:Uint8Array)=>void;
/** Archive file of a lut3d/mask.image node: presence, size and an upload button (only when the editor passes setFile). */
function ArchiveFile({kind,path,files,setFile,onPath}:{kind:'lut'|'mask';path:string;files?:ReadonlyMap<string,Uint8Array>;setFile?:SetFile;onPath:(p:string)=>void}){
  const input=useRef<HTMLInputElement>(null),[error,setError]=useState<string>(),held=files?.get(path);
  async function pick(e:ChangeEvent<HTMLInputElement>){
    const f=e.target.files?.[0];e.target.value='';if(!f||!setFile||!files)return;
    setError(undefined);
    try{
      if(f.size>LIMITS.entryBytes)throw new BuckError(`„${f.name}“ ist größer als 64 MiB.`);
      const bytes=new Uint8Array(await f.arrayBuffer()),next=archivePath(kind,f.name,bytes,files);
      setFile(next,bytes);onPath(next);
    }catch(err){setError(err instanceof Error?err.message:String(err));}
  }
  return <>
    {files&&(held?<Hint>Im Paket: {held.length.toLocaleString('de-DE')} Byte.</Hint>:<Hint tone="warn">„{path}“ fehlt im Paket. Ohne Datei lässt sich der Knoten nicht rendern und der Look nicht speichern.</Hint>)}
    {setFile&&<>
      <input ref={input} type="file" hidden accept={kind==='lut'?'.cube':'.png,image/png'} onChange={e=>void pick(e)} aria-label={kind==='lut'?'.cube-Datei wählen':'Maskenbild wählen'}/>
      <button type="button" className="buck-button buck-tool" onClick={()=>input.current?.click()}><FileUp size={14}/>{kind==='lut'?'.cube-Datei laden':'PNG-Maske laden'}</button>
    </>}
    {error&&<p className="buck-error" role="alert">{error}</p>}
  </>;
}

type Setter<P>=<K extends keyof P>(key:K,value:P[K],structural?:boolean)=>void;
type Merge<P>=(patch:Partial<P>,structural?:boolean)=>void;
type Edit=(patch:(n:BuckNode)=>BuckNode,structural?:boolean)=>void;
interface FormProps<T extends NodeType> {node:NodeOf<T>;graph:BuckGraph;set:Setter<NodeParamMap[T]>;merge:Merge<NodeParamMap[T]>;edit:Edit;files?:ReadonlyMap<string,Uint8Array>;setFile?:SetFile;}

/** `files`/`setFile`: archive entries of the editor state; without them lut3d and mask.image show no file status or upload. */
interface Props {graph:BuckGraph;node?:BuckNode;updateNode:UpdateNode;updateGraph:UpdateGraph;files?:ReadonlyMap<string,Uint8Array>;setFile?:SetFile;}
export function NodeInspector({graph,node,updateNode,updateGraph,files,setFile}:Props){
  if(!node)return <section className="buck-panel" aria-label="Knoteneigenschaften"><p className="buck-muted">Kein Knoten ausgewählt. Wähle links einen Knoten aus.</p></section>;
  const id=node.id,entry=catalogEntry(node.type),auto=isAutoNode(node),image=entry?PORTS[node.type].output==='image':'image' in node.inputs;
  // Plain value edits patch the node; edits that change spaces, inputs or flow re-derive conversions and declarations.
  const edit:Edit=(patch,structural=false)=>structural?updateGraph(g=>tidy(patchNode(g,id,patch))):updateNode(id,patch);
  const merge=(patch:Record<string,unknown>,structural=false)=>edit(n=>({...n,params:{...n.params,...patch}}) as BuckNode,structural);
  const set=(key:string,value:unknown,structural=false)=>merge({[key]:value},structural);
  const props=<T extends NodeType>(n:NodeOf<T>):FormProps<T>=>({node:n,graph,edit,files,setFile,set:set as unknown as Setter<NodeParamMap[T]>,merge:merge as unknown as Merge<NodeParamMap[T]>});
  const header=<header>
    <h2>{nodeTitle(node)}</h2>
    <p className="buck-muted">{entry?.label??node.type} · {node.type} · {id}</p>
    {entry&&<p className="buck-muted">{entry.description}</p>}
  </header>;
  if(auto)return <section className="buck-panel" aria-label="Knoteneigenschaften">{header}
    <Hint><Info size={14} aria-hidden="true"/> automatisch: {node.type==='color.convert@1'?`${node.params.from} → ${node.params.to}. `:''}Diese Konvertierung setzt der Editor bei jeder Änderung neu (§8); sie ist nicht bearbeitbar.</Hint>
  </section>;
  const form=renderForm(node,props);
  return <section className="buck-panel" aria-label="Knoteneigenschaften">{header}
    <Section title="Allgemein">
      <TextField label="Bezeichnung" value={node.label??''} maxLength={LABEL_MAX} placeholder={entry?.label}
        onChange={v=>edit(n=>{const {label:_old,...rest}=n;void _old;return (v.trim()?{...rest,label:v}:rest) as BuckNode;})}/>
      <CheckField label="Aktiv" checked={node.enabled!==false} onChange={on=>edit(n=>{const {enabled:_old,...rest}=n;void _old;return (on?rest:{...rest,enabled:false}) as BuckNode;},true)}/>
      <AnimField label="Stärke (amount)" value={node.amount??1} range={PARAM_UNIT} onChange={v=>edit(n=>({...n,amount:v}))}/>
      {image&&<MaskSelect graph={graph} node={node} updateGraph={updateGraph}/>}
    </Section>
    {form}
  </section>;
}
const PARAM_UNIT:Range=[0,1];

function MaskSelect({graph,node,updateGraph}:{graph:BuckGraph;node:BuckNode;updateGraph:UpdateGraph}){
  const current=node.inputs.mask??'',declared=Object.entries(graph.inputs).filter(([,d])=>d.kind==='mask').map(([k])=>`$${k}`);
  const opts=[{value:'',label:'Keine Maske'},...maskNodes(graph).map(m=>({value:m.id,label:`${nodeTitle(m)} (${m.id})`})),
    ...declared.map(d=>({value:d,label:`Eingabe ${d}`})),...Object.entries(MASK_PRESETS).map(([k,v])=>({value:`new:${k}`,label:v}))];
  return <SelectField label="Maske" value={current} options={opts}
    onChange={choice=>updateGraph(g=>{try{return applyMaskChoice(g,node.id,choice).graph;}catch{return g;}})}/>;
}

const R=(t:NodeType,k:string):Range=>PARAM_RANGES[t][k];
const ex=(t:NodeType,k:string)=>EXCLUSIVE.has(`${t}:${k}`);
const depthSemantics=(graph:BuckGraph,node:BuckNode)=>{const ref=node.inputs.depth;return ref?.startsWith('$')?graph.inputs[ref.slice(1)]?.semantics:undefined;};
/** Depth bounds are safety limits up to 1e4: normalized depth gets a 0…1 slider, metric depth a log slider in metres. */
function depthProps(graph:BuckGraph,node:BuckNode,t:NodeType,k:string){
  const metric=depthSemantics(graph,node)==='metric';
  return metric?{range:R(t,k),slider:[.1,1000] as Range,scale:'log' as const,unit:'m'}:{range:R(t,k),slider:[R(t,k)[0],1] as Range};
}
function anim<T extends NodeType>(node:NodeOf<T>,set:Setter<NodeParamMap[T]>,key:keyof NodeParamMap[T]&string,label:string,extra:Partial<NumberFieldProps>={}){
  const params=node.params as unknown as Record<string,Animatable|undefined>,v=params[key];
  if(v===undefined)return null;
  return <AnimField key={key} label={label} value={v} range={R(node.type,key)} exclusiveMin={ex(node.type,key)} {...extra}
    onChange={x=>set(key,x as NodeParamMap[T][typeof key])}/>;
}
const linearHint=(graph:BuckGraph)=>!isLinearSpace(graph.colorManagement.input)&&<Hint>Der Eingang ist display-bezogen: „linear“ bedeutet hier linearisiertes Display-Licht, keine echte Szenenlinearität (§8).</Hint>;

function renderForm(node:BuckNode,props:<T extends NodeType>(n:NodeOf<T>)=>FormProps<T>){
  switch(node.type){
    case 'color.convert@1':return <ConvertForm {...props(node)}/>;
    case 'color.look@1':return <LookForm {...props(node)}/>;
    case 'color.cdl@1':return <CdlForm {...props(node)}/>;
    case 'color.lut3d@1':return <LutForm {...props(node)}/>;
    case 'atmos.fog@1':return <FogForm {...props(node)}/>;
    case 'lens.dof@1':return <DofForm {...props(node)}/>;
    case 'light.relight@1':return <RelightForm {...props(node)}/>;
    case 'mask.depthRange@1':return <DepthRangeForm {...props(node)}/>;
    case 'mask.gradient@1':return <GradientForm {...props(node)}/>;
    case 'mask.luma@1':return <LumaForm {...props(node)}/>;
    case 'mask.input@1':return <InputMaskForm {...props(node)}/>;
    case 'mask.image@1':return <ImageMaskForm {...props(node)}/>;
    case 'mask.combine@1':return <CombineForm {...props(node)}/>;
    case 'mask.refine@1':return <RefineForm {...props(node)}/>;
    default:return <Hint>Unbekannter Knotentyp: Er wird unverändert gespeichert, aber nicht bearbeitet.</Hint>;
  }
}

function ConvertForm({node,set}:FormProps<'color.convert@1'>){
  return <Section title="Farbraum">
    <SelectField label="Von" value={node.params.from} options={SPACE_OPTS} onChange={v=>set('from',v,true)}/>
    <SelectField label="Nach" value={node.params.to} options={SPACE_OPTS} onChange={v=>set('to',v,true)}/>
    {node.params.from===node.params.to&&<Hint tone="warn">Quelle und Ziel sind gleich; der Knoten ändert nichts.</Hint>}
  </Section>;
}

const ZONES=[['shadows','Schatten'],['midtones','Mitteltöne'],['highlights','Lichter']] as const;
function LookForm({node,edit}:FormProps<'color.look@1'>){
  const t='color.look@1',p=node.params,look=p.look,baked=p.bakedLut!==undefined;
  // Any edit invalidates a baked LUT of this node (§5.2.1: it holds exactly this node), so it is dropped.
  const patch=(next:Partial<NodeParamMap[typeof t]>,structural=false)=>edit(n=>{
    if(n.type!==t)return n;const {bakedLut:_b,...rest}=n.params;void _b;return {...n,params:{...rest,...next}};
  },structural);
  const setLook=<K extends keyof typeof look>(k:K,v:(typeof look)[K])=>patch({look:{...look,[k]:v}});
  const num=(k:'whiteClean'|'skinProtect'|'skinHue'|'key'|'contrast'|'saturation',label:string)=>
    <NumberField key={k} label={label} value={look[k]} range={R(t,`look.${k}`)} onChange={v=>setLook(k,v)}/>;
  return <>
    <Section title="Farbraum"><SelectField label="Arbeitsraum (display)" value={p.space} options={DISPLAY_OPTS} onChange={v=>patch({space:v},true)}/></Section>
    <Section title="Tönung">
      <Hint>Offsets in Rec.709-Display-Werten; ohne Luma-Anteil bleibt die Helligkeit erhalten.</Hint>
      {ZONES.map(([k,label])=><div key={k}>
        <RGBField label={label} value={look[k]} range={R(t,`look.${k}`)} onChange={v=>setLook(k,v)}/>
        <button type="button" className="buck-icon-button" aria-label={`${label}: Luma-Anteil entfernen`} title="Luma-Anteil entfernen"
          onClick={()=>setLook(k,zeroLuma(look[k],R(t,`look.${k}`)))}><Eraser size={14}/></button>
      </div>)}
    </Section>
    <Section title="Tonwert">{num('key','Key (hell/dunkel)')}{num('contrast','Kontrast')}{num('saturation','Sättigung')}{num('whiteClean','Saubere Weißtöne')}</Section>
    <Section title="Haut">
      {num('skinProtect','Hautschutz im Look')}{num('skinHue','Hautton (Magenta ↔ Gelbgrün)')}
      <NumberField label="Hautschutz (Einstellung)" value={p.skinProtection} range={R(t,'skinProtection')} onChange={v=>patch({skinProtection:v})}/>
    </Section>
    {(p.prompt||p.understood?.length||baked)&&<Section title="Dokumentation">
      {p.prompt&&<p><span className="buck-muted">Prompt:</span> {p.prompt}</p>}
      {p.understood?.length?<ul className="buck-list" aria-label="Verstanden">{p.understood.map((u,i)=><li key={i} className="buck-muted">{u}</li>)}</ul>:null}
      {baked&&<Hint>Gebackene LUT {p.bakedLut}: wird bei der ersten Änderung entfernt und muss neu gebacken werden.</Hint>}
      <Hint>Prompt und Liste haben keine Renderwirkung (§5.2.1).</Hint>
    </Section>}
  </>;
}

function CdlForm({node,set}:FormProps<'color.cdl@1'>){
  const t='color.cdl@1',p=node.params;
  return <Section title="ASC CDL">
    <RGBField label="Slope" value={p.slope} range={R(t,'slope')} slider={[0,4]} onChange={v=>set('slope',v)}/>
    <RGBField label="Offset" value={p.offset} range={R(t,'offset')} slider={[-1,1]} onChange={v=>set('offset',v)}/>
    <PowerField value={p.power} onChange={v=>set('power',v)}/>
    <NumberField label="Sättigung" value={p.saturation} range={R(t,'saturation')} slider={[0,4]} onChange={v=>set('saturation',v)}/>
    <SelectField label="Stil" value={p.style} options={options(['v1.2_Fwd','noClampFwd'] as const,{'v1.2_Fwd':'v1.2_Fwd (geklemmt)','noClampFwd':'noClampFwd (ungeklemmt)'})} onChange={v=>set('style',v)}/>
    <SelectField label="Arbeitsraum" value={p.space} options={SPACE_OPTS} onChange={v=>set('space',v,true)}/>
  </Section>;
}
/** CDL power is > 0, so each channel has an exclusive lower bound. */
function PowerField({value,onChange}:{value:RGB;onChange:(v:RGB)=>void}){
  const r=R('color.cdl@1','power');
  return <fieldset className="buck-row" style={{border:0,padding:0,margin:0,display:'grid',gap:2}}><legend>Power</legend>
    {(['R','G','B'] as const).map((c,i)=><NumberField key={c} label={`Power ${c}`} value={value[i]} range={r} slider={[0,4]} exclusiveMin onChange={v=>onChange(value.map((x,j)=>j===i?v:x) as RGB)}/>)}
  </fieldset>;
}

function LutForm({node,set,files,setFile}:FormProps<'color.lut3d@1'>){
  const p=node.params;
  return <Section title="3D-LUT">
    <TextField label="Datei im Archiv" value={p.file} maxLength={120} validate={v=>LUT_FILE.test(v)?undefined:'Erwartet wird luts/<name>.cube (Kleinbuchstaben, Ziffern, . _ -).'} onChange={v=>set('file',v)}/>
    <ArchiveFile kind="lut" path={p.file} files={files} setFile={setFile} onPath={v=>set('file',v)}/>
    <SelectField label="Eingangsraum" value={p.inputSpace} options={SPACE_OPTS} onChange={v=>set('inputSpace',v,true)}/>
    <SelectField label="Ausgangsraum" value={p.outputSpace} options={SPACE_OPTS} onChange={v=>set('outputSpace',v,true)}/>
    <Hint>Die Datei muss im Archiv liegen; tetraedrische Interpolation, Eingang wird auf die Domain geklemmt (§5.2.2).</Hint>
  </Section>;
}

function FogForm({node,set,merge,graph}:FormProps<'atmos.fog@1'>){
  const t='atmos.fog@1',p=node.params,space=graph.colorManagement.working.linear;
  return <Section title="Nebel">
    {linearHint(graph)}
    <SelectField label="Modell" value={p.model} options={options(['exponential','linear'] as const,{exponential:'Exponentiell',linear:'Linear'})}
      onChange={v=>{
        // Linear fog needs end > start; UI start value: 0.4 depth units behind a constant start.
        merge(v==='linear'&&p.end===undefined?{model:v,end:(typeof p.start==='number'?p.start:0)+.4}:{model:v});
      }}/>
    {anim(node,set,'start','Beginn',depthProps(graph,node,t,'start'))}
    {p.model==='linear'&&anim(node,set,'end','Voll ab',depthProps(graph,node,t,'end'))}
    {p.model==='linear'&&typeof p.start==='number'&&typeof p.end==='number'&&p.start>=p.end&&<Hint tone="warn">„Beginn“ muss kleiner als „Voll ab“ sein.</Hint>}
    {p.model==='exponential'&&anim(node,set,'density','Dichte')}
    <ColorField label="Streulichtfarbe" value={p.color} space={space} range={R(t,'color')} kelvinRange={R(t,'color.kelvin')} onChange={v=>set('color',v)}/>
    {anim(node,set,'luminance','Helligkeit',{unit:'EV',slider:[-5,5]})}
    {anim(node,set,'maxOpacity','Max. Deckung')}
    {anim(node,set,'skyProtect','Himmelsschutz')}
  </Section>;
}

function DofForm({node,set,merge,graph}:FormProps<'lens.dof@1'>){
  const t='lens.dof@1',p=node.params,metric=depthSemantics(graph,node)==='metric';
  const switchMode=(m:'artistic'|'physical')=>{
    const d=defaultNode(t,'x');
    const base=m==='physical'?PHYSICAL:d.type===t?{focus:d.params.focus,focusRange:d.params.focusRange,blurNear:d.params.blurNear,blurFar:d.params.blurFar}:{};
    const fill=Object.fromEntries(Object.entries(base).filter(([k])=>p[k as keyof typeof p]===undefined));
    merge({...fill,mode:m});
  };
  const s=typeof p.focusDistance==='number'?p.focusDistance:undefined,f=typeof p.focalLength==='number'?p.focalLength:undefined;
  return <>
    <Section title="Fokus">
      {linearHint(graph)}
      <SelectField label="Modus" value={p.mode} options={options(['artistic','physical'] as const,{artistic:'Künstlerisch (relative Tiefe)',physical:'Physikalisch (metrische Tiefe)'})} onChange={switchMode}/>
      {p.mode==='artistic'?<>
        {anim(node,set,'focus','Fokus (Tiefe)',depthProps(graph,node,t,'focus'))}
        {anim(node,set,'focusRange','Scharfbereich')}
        {anim(node,set,'blurNear','Unschärfe nah',{unit:'× Breite'})}
        {anim(node,set,'blurFar','Unschärfe fern',{unit:'× Breite'})}
      </>:<>
        {!metric&&<Hint tone="warn">Der Modus „physikalisch“ braucht metrische Tiefe; die deklarierte Tiefe ist relativ.</Hint>}
        {anim(node,set,'focusDistance','Fokusdistanz',{unit:'m',scale:'log',slider:[.1,1000]})}
        {anim(node,set,'fNumber','Blende (f/)',{scale:'log'})}
        {anim(node,set,'focalLength','Brennweite',{unit:'mm',scale:'log'})}
        {anim(node,set,'sensorWidth','Sensorbreite',{unit:'mm'})}
        {s!==undefined&&f!==undefined&&s<=f/1000&&<Hint tone="warn">Die Fokusdistanz muss größer als die Brennweite sein.</Hint>}
      </>}
      {anim(node,set,'maxBlur','Max. Unschärfe',{unit:'× Breite'})}
    </Section>
    <Section title="Bokeh">
      <SelectField label="Lamellen" value={String(p.blades)} options={[{value:'0',label:'Kreis'},...[5,6,7,8,9,10,11,12].map(n=>({value:String(n),label:`${n} Lamellen`}))]} onChange={v=>set('blades',Number(v))}/>
      {anim(node,set,'rotation','Drehung',{unit:'°',step:1})}
      {anim(node,set,'bladeCurvature','Lamellenrundung')}
      {anim(node,set,'catEye','Katzenauge')}
      {anim(node,set,'highlightBoost','Lichterverstärkung')}
    </Section>
  </>;
}

function RelightForm({node,set,graph}:FormProps<'light.relight@1'>){
  const t='light.relight@1',p=node.params;
  return <Section title="Licht">
    {linearHint(graph)}
    {anim(node,set,'azimuth','Azimut (−90 links, +90 rechts)',{unit:'°',step:1})}
    {anim(node,set,'elevation','Höhe',{unit:'°',step:1})}
    <ColorField label="Lichtfarbe" value={p.color} space={graph.colorManagement.working.linear} range={R(t,'color')} kelvinRange={R(t,'color.kelvin')} onChange={v=>set('color',v)}/>
    {anim(node,set,'intensity','Intensität',{unit:'EV',slider:[-5,5]})}
    {anim(node,set,'softness','Weichheit')}
    <SelectField label="Modus" value={p.mode} options={[{value:'add',label:'Hinzufügen'}]} onChange={v=>set('mode',v)}/>
    {anim(node,set,'preserveHighlights','Lichter schützen')}
  </Section>;
}

function DepthRangeForm({node,set,graph}:FormProps<'mask.depthRange@1'>){
  const t='mask.depthRange@1',p=node.params,metric=depthSemantics(graph,node)==='metric';
  return <Section title="Tiefenbereich">
    <Hint>Tiefe: 0 = nah … 1 = fern{metric?' (hier metrisch in Metern)':''}.</Hint>
    {anim(node,set,'near','Nah',depthProps(graph,node,t,'near'))}
    {anim(node,set,'far','Fern',depthProps(graph,node,t,'far'))}
    {typeof p.near==='number'&&typeof p.far==='number'&&p.near>p.far&&<Hint tone="warn">„Nah“ darf nicht größer als „Fern“ sein.</Hint>}
    {anim(node,set,'feather','Weiche Kante',metric?{scale:'log',slider:[.02,100],unit:'m'}:{slider:[.02,1]})}
    <CheckField label="Umkehren" checked={p.invert} onChange={v=>set('invert',v)}/>
  </Section>;
}

const POINT_SLIDER:[Range,Range]=[[0,1],[0,1]];
function GradientForm({node,set,merge}:FormProps<'mask.gradient@1'>){
  const t='mask.gradient@1',p=node.params,d=defaultNode(t,'x');
  const def=d.type===t?d.params:undefined;
  const shape=(v:'linear'|'radial')=>{
    // Radial start values match gradientMask's fallbacks for a 16:9 frame (center [0.5, H/W/2], radius 0.5).
    merge(v==='linear'?{shape:v,start:p.start??def?.start,end:p.end??def?.end}:{shape:v,center:p.center??[.5,.28125],radius:p.radius??.5});
  };
  return <Section title="Verlauf">
    <Hint>Koordinaten in Bildbreiten: (0, 0) oben links, y reicht bis Höhe/Breite (16:9: 0,5625).</Hint>
    <SelectField label="Form" value={p.shape} options={options(['linear','radial'] as const,{linear:'Linear',radial:'Radial'})} onChange={shape}/>
    {p.shape==='linear'?<>
      {p.start&&<PointField label="Start (0)" value={p.start} range={R(t,'start')} slider={POINT_SLIDER} onChange={v=>set('start',v)}/>}
      {p.end&&<PointField label="Ende (1)" value={p.end} range={R(t,'end')} slider={POINT_SLIDER} onChange={v=>set('end',v)}/>}
      {p.start&&p.end&&p.start[0]===p.end[0]&&p.start[1]===p.end[1]&&<Hint tone="warn">Start- und Endpunkt dürfen nicht gleich sein.</Hint>}
    </>:<>
      {p.center&&<PointField label="Mitte" value={p.center} range={R(t,'center')} slider={POINT_SLIDER} onChange={v=>set('center',v)}/>}
      {anim(node,set,'radius','Radius',{slider:[0,1.5]})}
    </>}
    {anim(node,set,'feather','Weiche Kante',{slider:[0,1]})}
    <CheckField label="Umkehren" checked={p.invert} onChange={v=>set('invert',v)}/>
  </Section>;
}

function LumaForm({node,set}:FormProps<'mask.luma@1'>){
  const p=node.params,slider:Range|undefined=isLinearSpace(p.space)?[0,4]:[0,1];
  return <Section title="Luminanz">
    <SelectField label="Farbraum" value={p.space} options={SPACE_OPTS} onChange={v=>set('space',v)}/>
    {anim(node,set,'low','Untergrenze',{slider})}
    {anim(node,set,'high','Obergrenze',{slider})}
    {typeof p.low==='number'&&typeof p.high==='number'&&p.low>p.high&&<Hint tone="warn">Die Untergrenze darf nicht über der Obergrenze liegen.</Hint>}
    {anim(node,set,'softness','Weichheit',{slider:[0,.5]})}
  </Section>;
}

function InputMaskForm({node,set,graph}:FormProps<'mask.input@1'>){
  const p=node.params,declared=Object.entries(graph.inputs).filter(([,d])=>d.kind==='mask').map(([k])=>({value:`$${k}`,label:k}));
  return <Section title="Eingabemaske">
    <SelectField label="Eingabe" value={p.input} options={declared} onChange={v=>set('input',v,true)}/>
    <SelectField label="Kanal" value={p.channel} options={options(['luma','r','g','b','a'] as const,{luma:'Luminanz',r:'Rot',g:'Grün',b:'Blau',a:'Alpha'})} onChange={v=>set('channel',v)}/>
    <Hint>Die Maske liefert der Host (Clip „{graph.inputs[p.input.replace(/^\$/,'')]?.sources.find(s=>s.type==='host-clip')?.clip??'?'}“).</Hint>
  </Section>;
}

function ImageMaskForm({node,set,files,setFile}:FormProps<'mask.image@1'>){
  const p=node.params;
  return <Section title="Maskenbild">
    <TextField label="Datei im Archiv" value={p.file} maxLength={120} validate={v=>MASK_FILE.test(v)?undefined:'Erwartet wird masks/<name>.png (Kleinbuchstaben, Ziffern, . _ -).'} onChange={v=>set('file',v)}/>
    <ArchiveFile kind="mask" path={p.file} files={files} setFile={setFile} onPath={v=>set('file',v)}/>
    <SelectField label="Einpassen" value={p.fit} options={options(['stretch','contain','cover'] as const,{stretch:'Strecken',contain:'Einpassen',cover:'Füllen'})} onChange={v=>set('fit',v)}/>
  </Section>;
}

const OPS={multiply:'Multiplizieren',max:'Maximum',min:'Minimum',subtract:'Abziehen (a − b)',screen:'Screen'} as const;
function maskPort(node:BuckNode,graph:BuckGraph,edit:Edit,name:string,label:string){
  const sources=maskSources(graph,node.id).map(m=>({value:m.id,label:`${nodeTitle(m)} (${m.id})`}));
  return <SelectField key={name} label={label} value={node.inputs[name]??''} options={sources} onChange={v=>edit(n=>({...n,inputs:{...n.inputs,[name]:v}}),true)}/>;
}
function CombineForm({node,graph,set,edit}:FormProps<'mask.combine@1'>){
  return <Section title="Masken verknüpfen">{maskPort(node,graph,edit,'a','Maske a')}{maskPort(node,graph,edit,'b','Maske b')}
    <SelectField label="Verknüpfung" value={node.params.op} options={options(Object.keys(OPS) as (keyof typeof OPS)[],OPS)} onChange={v=>set('op',v)}/>
  </Section>;
}
function RefineForm({node,graph,set,edit}:FormProps<'mask.refine@1'>){
  return <Section title="Maske verfeinern">{maskPort(node,graph,edit,'mask','Eingangsmaske')}
    {anim(node,set,'blur','Weichzeichnen',{unit:'× Breite'})}
    {anim(node,set,'grow','Erweitern (±)',{unit:'× Breite'})}
    {anim(node,set,'gamma','Gamma',{slider:[0,4]})}
  </Section>;
}
