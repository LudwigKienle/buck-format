import { useEffect, useRef, useState } from 'react';
import { Check, FilePlus, FlaskConical, FolderOpen, ImageUp, LoaderCircle, Save, Sparkles, TriangleAlert, X } from 'lucide-react';
import { bakeColorCube, bakeLookCube, serializeBuckCube } from '../bake';
import { isLinearSpace, toSRGB8 } from '../colorspace';
import { missingFiles, readBuck, writeBuck } from '../container';
import { HEURISTIC_LABEL, heuristicDepth } from '../depth/heuristic';
import { imageBuf } from '../field';
import { emptyGraph, promptToGraph } from '../prompt';
import { BUCK_MIMETYPE, LIMITS, PORTS } from '../types';
import type { BuckGraph, BuckNode, ImageBuf, SpaceName } from '../types';
import { checkGraph, parseGraph } from '../validate';
import { download, loadAsset, readImage, safeName } from '../../image';
import type { ImageAsset } from '../../image';
import { AuxPanel } from './AuxPanel';
import { BuckViewer } from './BuckViewer';
import { ensureConversions, ensureInputs, openForEditing } from './chain';
import { NodeInspector } from './NodeInspector';
import { NodeStack } from './NodeStack';
import type { AuxState, EditorState, SourceImage, UpdateGraph, UpdateNode, ViewMode } from './types';
import { bakedLutPath, renderOnce, thumbSize, useBuckRender } from './useBuckRender';
import './buck.css';

const INITIAL_PROMPT='Dune-Look, Dunst im Hintergrund, warmes Licht von links';
const DEMO_URL='./demo-desert.jpg',DEMO_NAME='Wüste · Testmotiv';
const INPUT_SPACES:SpaceName[]=['Rec.1886 Rec.709 - Display','sRGB - Display'];
const LUT_SIZE=64,THUMB_SIDE=1024,JPEG_QUALITY=.9;
const FALLBACK_PATH='luts/fallback_64.cube';
const GENERATOR='Buckswood Auto LUT · .buck-Editor';
const NO_AUX:AuxState={channels:{masks:{}},depthSource:'none',busy:false};

/** Writer side (spec §8): the editor, not the reader, emits explicit conversions and input declarations. */
const normalize=(g:BuckGraph)=>ensureInputs(ensureConversions(g));
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
/** Pixel code values as given, tagged with the chosen input space (no conversion). */
function toImageBuf(asset:ImageAsset,space:SpaceName):ImageBuf {
  const data=new Float32Array(asset.width*asset.height*4);
  if(asset.floatPixels)data.set(asset.floatPixels);else for(let i=0;i<data.length;i++)data[i]=asset.pixels[i]/255;
  return imageBuf(asset.width,asset.height,space,data);
}
const heuristicAux=(image:ImageBuf):AuxState=>({channels:{depth:heuristicDepth(image),masks:{}},depthSource:'heuristic',depthLabel:`${HEURISTIC_LABEL} – keine echte Tiefenschätzung`,busy:false});
/** lut3d and mask.image files: the only archive entries the user supplies; baked LUTs, fallback and thumbnails are rebuilt on save. */
const nodeFiles=(g:BuckGraph)=>new Set(g.nodes.flatMap(n=>n.type==='color.lut3d@1'||n.type==='mask.image@1'?[n.params.file]:[]));
const lookUnderstood=(g:BuckGraph)=>g.nodes.flatMap(n=>n.type==='color.look@1'?n.params.understood??[]:[]);

function initial():{state:EditorState;understood:string[];error?:string} {
  const base:Omit<EditorState,'graph'>={files:new Map(),aux:NO_AUX,view:'split',frame:0};
  try{const r=promptToGraph(INITIAL_PROMPT);return {state:{...base,graph:normalize(r.graph)},understood:r.understood};}
  catch(e){return {state:{...base,graph:emptyGraph('Neuer Look')},understood:[],error:message(e)};}
}

/** OffscreenCanvas where available (MDN: Baseline since 03/2023), DOM canvas otherwise. */
function canvas2d(w:number,h:number){
  if(typeof OffscreenCanvas!=='undefined'){
    const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d');
    // Same drawing API at runtime; typed as one context because TS cannot call a union of overloaded methods.
    if(ctx)return {canvas,ctx:ctx as unknown as CanvasRenderingContext2D};
  }
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas 2D ist nicht verfügbar.');
  return {canvas,ctx};
}
/** sRGB RGBA8 → JPEG with longest side ≤ 1024 (spec §3.2), flattened on black. */
async function jpegThumb(rgba:Uint8ClampedArray,width:number,height:number):Promise<Uint8Array> {
  const [tw,th]=thumbSize(width,height,THUMB_SIDE),full=canvas2d(width,height),out=canvas2d(tw,th),ctx=out.ctx;
  full.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);
  ctx.fillStyle='#000';ctx.fillRect(0,0,tw,th);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(full.canvas,0,0,tw,th);
  const c=out.canvas;let blob:Blob|null;
  if(c instanceof HTMLCanvasElement)blob=await new Promise<Blob|null>(res=>c.toBlob(res,'image/jpeg',JPEG_QUALITY));
  else blob=await c.convertToBlob({type:'image/jpeg',quality:JPEG_QUALITY});
  // Both APIs silently fall back to PNG when JPEG is unsupported.
  if(!blob||blob.type!=='image/jpeg')throw new Error('Der Browser kann kein JPEG-Vorschaubild erzeugen.');
  return new Uint8Array(await blob.arrayBuffer());
}

export function BuckEditor(){
  const [boot]=useState(initial);
  const [state,setState]=useState<EditorState>(boot.state),ref=useRef(state);
  const [understood,setUnderstood]=useState(boot.understood),[draft,setDraft]=useState(INITIAL_PROMPT),[promptMiss,setPromptMiss]=useState(false);
  const [inputSpace,setInputSpace]=useState<SpaceName>(INPUT_SPACES[0]),[thumbs,setThumbs]=useState(true);
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(boot.error??''),[notice,setNotice]=useState('');
  const imageInput=useRef<HTMLInputElement>(null),buckInput=useRef<HTMLInputElement>(null),loadJob=useRef(0);
  const render=useBuckRender(state);

  // Updates go through a ref so throwing transforms (chain limits) can be reported without touching state.
  const update=(fn:(s:EditorState)=>EditorState)=>{const next=fn(ref.current);ref.current=next;setState(next);};
  const updateGraph:UpdateGraph=next=>{try{update(s=>({...s,graph:normalize(next(s.graph))}));}catch(e){setError(message(e));}};
  const updateNode:UpdateNode=(id,patch)=>updateGraph(g=>({...g,nodes:g.nodes.map(n=>n.id===id?patch(n):n)}));
  const setFile=(path:string,bytes:Uint8Array)=>update(s=>({...s,files:new Map(s.files).set(path,bytes)}));
  const setAux=(next:AuxState|((a:AuxState)=>AuxState))=>update(s=>({...s,aux:typeof next==='function'?next(s.aux):next}));

  async function loadSource(get:()=>Promise<ImageAsset>,heuristic:boolean){
    const id=++loadJob.current;setLoading(true);setError('');
    try{
      const asset=await get();if(asset.url.startsWith('blob:'))URL.revokeObjectURL(asset.url);
      if(id!==loadJob.current)return;
      const image=toImageBuf(asset,inputSpace),source:SourceImage={name:asset.name,image,width:image.width,height:image.height};
      // Aux channels belong to one shot: a new image drops them; the heuristic is recomputed if it was in use.
      const aux=heuristic||ref.current.aux.depthSource==='heuristic'?heuristicAux(image):NO_AUX;
      update(s=>({...s,source,aux}));
    }catch(e){if(id===loadJob.current)setError(message(e));}
    finally{if(id===loadJob.current)setLoading(false);}
  }
  useEffect(()=>{void loadSource(()=>loadAsset(DEMO_URL,DEMO_NAME),true);},[]);
  useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(t);},[notice]);

  function retag(space:SpaceName){
    setInputSpace(space);
    update(s=>s.source?{...s,source:{...s.source,image:{...s.source.image,space}}}:s);
  }
  function newGraph(){
    update(s=>({...s,graph:emptyGraph('Neuer Look'),files:new Map(),selected:undefined}));
    setUnderstood([]);setDraft('');setPromptMiss(false);setNotice('Neuer, leerer Look.');
  }
  function applyPrompt(){
    const text=draft.trim();if(!text)return;
    try{
      const r=promptToGraph(text,ref.current.graph);
      update(s=>({...s,graph:normalize(r.graph),selected:undefined}));
      setUnderstood(r.understood);setPromptMiss(r.understood.length===0);
    }catch(e){setError(message(e));}
  }
  async function openBuck(file:File){
    setError('');
    try{
      if(file.size>LIMITS.archiveBytes)throw new Error('Die .buck-Datei ist größer als 128 MiB.');
      const pkg=await readBuck(new Uint8Array(await file.arrayBuffer()),{parse:parseGraph});
      // Array order becomes data-flow order (same render); a non-linear image graph keeps its wiring (chain.ts).
      const {graph,linear}=openForEditing(pkg.graph),missing=missingFiles(graph,pkg.files);
      update(s=>({...s,graph,files:pkg.files,selected:undefined}));
      setUnderstood(lookUnderstood(graph));setDraft(graph.meta.prompt??'');setPromptMiss(false);
      setNotice(`„${graph.meta.name}“ geöffnet · ${graph.nodes.length} Knoten · Look-ID ${pkg.lookId.slice(0,12)}…`);
      const warnings=[...linear?[]:['Die Bildknoten bilden keine einfache Kette: Bildknoten lassen sich nicht hinzufügen, entfernen oder verschieben, automatische Konvertierungen werden nicht angepasst.'],
        ...missing.length?[`Im Paket fehlen Dateien, auf die der Graph verweist: ${missing.join(', ')}.`]:[]];
      if(warnings.length)setError(warnings.join(' '));
    }catch(e){setError(`Die .buck-Datei konnte nicht geöffnet werden: ${message(e)}`);}
  }
  async function saveBuck(){
    if(saving)return;setSaving(true);setError('');
    await new Promise(r=>setTimeout(r,0)); // let the busy state paint before the bakes block the main thread
    const snap=ref.current,notes:string[]=[];
    try{
      let g=normalize(snap.graph);
      const refs=nodeFiles(g),absent=[...refs].filter(p=>!snap.files.has(p)).sort();
      if(absent.length)throw new Error(`Im Paket fehlt ${absent.length===1?'die Datei':'Dateien'} ${absent.map(p=>`„${p}“`).join(', ')}. Bitte im Knoten laden oder den Knoten entfernen.`);
      // Unreferenced luts/ and masks/ entries (old uploads, previous bakes) are dropped; meta/ and ext/ are kept.
      const files=new Map([...snap.files].filter(([p])=>refs.has(p)||!(p.startsWith('luts/')||p.startsWith('masks/')||p.startsWith('thumbs/'))));
      const taken=new Set([...files.keys()]),enc=new TextEncoder();
      const nodes:BuckNode[]=g.nodes.map(n=>{
        if(n.type!=='color.look@1')return n;
        const path=bakedLutPath(n.id,taken);
        files.set(path,enc.encode(serializeBuckCube(bakeLookCube(n.params,LUT_SIZE),LUT_SIZE,`${g.meta.name} · ${n.label??n.id}`,n.params.space,n.params.space)));
        return {...n,params:{...n.params,bakedLut:path}};
      });
      g={...g,nodes};
      const cm=g.colorManagement,fb=bakeColorCube(g,files,LUT_SIZE);
      files.set(FALLBACK_PATH,enc.encode(serializeBuckCube(fb.data,LUT_SIZE,`${g.meta.name} · nur Farbe`,cm.input,cm.output)));
      g={...g,fallback:{cube:FALLBACK_PATH,inputSpace:cm.input,outputSpace:cm.output,covers:fb.covers,omits:fb.omits}};
      const meta={...g.meta},thumbnails:{before?:string;after?:string}={};delete meta.thumbnails;
      if(thumbs&&snap.source){
        const img=snap.source.image;
        files.set('thumbs/before.jpg',await jpegThumb(toSRGB8(img),img.width,img.height));thumbnails.before='thumbs/before.jpg';
        try{
          const after=await renderOnce({...snap,graph:g,files});
          files.set('thumbs/after.jpg',await jpegThumb(after.preview,after.width,after.height));thumbnails.after='thumbs/after.jpg';
        }catch(e){notes.push(`ohne Nachher-Vorschaubild (${message(e)})`);}
      }
      g={...g,meta:{...meta,generator:GENERATOR,created:meta.created??new Date().toISOString(),...(thumbnails.before?{thumbnails}:{})}};
      const problems=checkGraph(g),dangling=missingFiles(g,files);
      if(problems.length)throw new Error(problems.slice(0,3).join(' · '));
      if(dangling.length)throw new Error(`Der Graph verweist auf fehlende Dateien: ${dangling.join(', ')}.`);
      const bytes=await writeBuck(g,files);
      download(new Uint8Array(bytes),`${safeName(g.meta.name)}.buck`,BUCK_MIMETYPE);
      // Edits made while saving win; the baked state is only adopted if the graph is still the saved one.
      update(s=>s.graph===snap.graph?{...s,graph:g,files}:s);
      setNotice(`.buck gespeichert · ${(bytes.length/1048576).toFixed(1)} MB · Fallback-Cube deckt ${fb.covers.length} Knoten, lässt ${fb.omits.length} räumliche weg${notes.length?' · '+notes.join(' · '):''}`);
    }catch(e){setError(`Speichern fehlgeschlagen: ${message(e)}`);}
    finally{setSaving(false);}
  }

  const {graph,source,aux}=state,result=render.result;
  const selectedNode=graph.nodes.find(n=>n.id===state.selected);
  const labelOf=(id:string)=>{const n=graph.nodes.find(x=>x.id===id);return n?.label?`${n.label} (${id})`:id;};
  const displayIn=!isLinearSpace(graph.colorManagement.input)&&graph.nodes.some(n=>(PORTS as Partial<Record<string,{space:string}>>)[n.type]?.space==='linear');
  const busy=render.busy||loading;
  const status=loading?'Bild wird geladen …':!source?'Kein Bild geladen.':render.busy?'Wird gerendert …':result?`Gerendert in ${Math.round(result.ms)} ms · ${result.width}×${result.height} px`:render.error?'Render fehlgeschlagen.':'Bereit.';

  return <div className="buck-editor">
    <div className="buck-toolbar" role="toolbar" aria-label=".buck-Werkzeuge">
      <div className="buck-tools">
        <button className="buck-tool" onClick={newGraph}><FilePlus size={15}/>Neu</button>
        <button className="buck-tool" onClick={()=>imageInput.current?.click()} disabled={loading}><ImageUp size={15}/>Bild laden</button>
        <button className="buck-tool" onClick={()=>void loadSource(()=>loadAsset(DEMO_URL,DEMO_NAME),false)} disabled={loading}><FlaskConical size={15}/>Testmotiv</button>
        <label className="buck-field"><span>Eingang</span><select value={inputSpace} onChange={e=>retag(e.target.value as SpaceName)} title="Wie die Pixelwerte des geladenen Bildes zu lesen sind (Codewerte, keine Konvertierung)">{INPUT_SPACES.map(s=><option key={s} value={s}>{s}</option>)}</select></label>
      </div>
      <div className="buck-tools">
        <label className="buck-field buck-name"><span>Name</span><input value={graph.meta.name} maxLength={LIMITS.nameChars} aria-label="Name des Looks" onChange={e=>{const name=e.target.value;update(s=>({...s,graph:{...s.graph,meta:{...s.graph.meta,name}}}));}}/></label>
        <label className="buck-field buck-frame"><span>Frame</span><input type="number" min={0} max={1000000} step={1} value={state.frame} aria-label="Frame für Keyframes" onChange={e=>{const f=Math.max(0,Math.min(1000000,Math.round(Number(e.target.value)||0)));update(s=>({...s,frame:f}));}}/></label>
        <label className="buck-check" title="Vorschaubilder zeigen Produktionsmaterial (Spec §11.8)"><input type="checkbox" checked={thumbs} onChange={e=>setThumbs(e.target.checked)}/>Vorschaubilder einbetten</label>
        <button className="buck-tool" onClick={()=>buckInput.current?.click()}><FolderOpen size={15}/>.buck öffnen</button>
        <button className="buck-tool buck-primary" onClick={()=>void saveBuck()} disabled={saving||!graph.meta.name.trim()}>{saving?<LoaderCircle size={15} className="spin"/>:<Save size={15}/>}{saving?'Speichern …':'.buck speichern'}</button>
      </div>
    </div>
    <div className="buck-layout">
      <aside className="buck-col buck-left" aria-label="Knoten"><NodeStack graph={graph} selected={state.selected} onSelect={(id?:string)=>update(s=>({...s,selected:id}))} updateGraph={updateGraph}/></aside>
      <main className="buck-col buck-center">
        <section className="buck-prompt" aria-label="Look beschreiben">
          <div className="buck-prompt-row">
            <textarea value={draft} rows={2} maxLength={LIMITS.promptChars} aria-label="Look-Beschreibung" placeholder="z. B. Fargo-Look, Nebel im Hintergrund, warmes Licht von links" onChange={e=>{setDraft(e.target.value);setPromptMiss(false);}} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();applyPrompt();}}}/>
            <button className="buck-tool buck-primary" onClick={applyPrompt} disabled={!draft.trim()}><Sparkles size={15}/>Graph erzeugen</button>
          </div>
          <small>Ersetzt die Knotenkette, Name und Farbmanagement bleiben. Lokal interpretiert · ⌘/Strg + Enter</small>
          {promptMiss&&<p className="buck-miss">Keine bekannten Begriffe erkannt. Nenne einen Look (z. B. Fargo), Nebel, Tiefenschärfe oder Licht mit Richtung.</p>}
          {understood.length>0&&<ul className="buck-chips" aria-label="Erkannte Anweisungen">{understood.map(u=><li key={u}>{u}</li>)}</ul>}
        </section>
        {error&&<div className="buck-msg error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Fehler schließen" onClick={()=>setError('')}><X size={16}/></button></div>}
        {render.error&&<div className="buck-msg error" role="alert"><span>{render.error}</span></div>}
        <BuckViewer state={state} result={result} busy={busy} onView={(v:ViewMode)=>update(s=>({...s,view:v}))}/>
        <div className="buck-status" aria-live="polite">
          <span className={`status-dot ${result&&!busy?'ready':''}`}/>{status}
          {aux.depthSource==='heuristic'&&<span className="buck-badge warn">Tiefe: {HEURISTIC_LABEL}</span>}
          {source&&<span className="buck-badge">{source.name} · gelesen als {source.image.space}</span>}
        </div>
        {displayIn&&<p className="buck-note"><TriangleAlert size={13}/>Display-Eingang: Die Linearisierung ergibt Display-Licht, keine Szenenlinearität. Spitzlichter sind bereits beschnitten (Spec §8).</p>}
        {result&&result.warnings.length>0&&<ul className="buck-warnings" aria-label="Warnungen">{result.warnings.map(w=><li key={w}><TriangleAlert size={13}/>{w}</li>)}</ul>}
        {result&&result.bypassed.length>0&&<p className="buck-note">Überbrückt: {result.bypassed.map(labelOf).join(', ')}</p>}
        <AuxPanel graph={graph} source={source} aux={aux} setAux={setAux} updateGraph={updateGraph}/>
      </main>
      <aside className="buck-col buck-right" aria-label="Parameter"><NodeInspector graph={graph} node={selectedNode} updateNode={updateNode} updateGraph={updateGraph} files={state.files} setFile={setFile}/></aside>
    </div>
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" className="file-input" aria-label="Bild auswählen" onChange={e=>{const f=e.target.files?.[0];if(f)void loadSource(()=>readImage(f),false);e.target.value='';}}/>
    <input ref={buckInput} type="file" accept=".buck,application/vnd.buckswood.buck+zip" className="file-input" aria-label=".buck-Datei auswählen" onChange={e=>{const f=e.target.files?.[0];if(f)void openBuck(f);e.target.value='';}}/>
    {notice&&<div className="toast" role="status"><Check size={17}/>{notice}</div>}
  </div>;
}
