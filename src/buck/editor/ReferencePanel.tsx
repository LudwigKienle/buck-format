import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Check, ImageUp, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { readImage } from '../../image';
import type { ImageAsset } from '../../image';
import { heuristicDepth } from '../depth/heuristic';
import { DEFAULT_DEPTH_MODEL } from '../depth/models';
import { imageBuf } from '../field';
import { ASPECT_ORDER, analyzeReference } from '../reference/analyze';
import type { AspectId, ReferenceReport } from '../reference/analyze';
import { REFERENCE_LUT, buildReferenceGraph } from '../reference/build';
import { de } from '../reference/common';
import type { DepthKind } from '../reference/common';
import { referenceDepth } from '../reference/depth';
import type { BuckGraph, ImageBuf, SpaceName } from '../types';
import type { AuxState, SourceImage } from './types';
/**
 * Reference analysis 2.0 in the editor: load one reference image, analyze it locally (src/buck/reference/), tick the
 * suggestions and build a complete graph for the loaded source image. The reference image stays in memory only; the .buck
 * file receives the derived parameters and the LUT luts/reference_64.cube, never the image.
 */
export interface ReferenceApply {graph:BuckGraph;files:Map<string,Uint8Array>;applied:string[];}
type Props={graph:BuckGraph;source?:SourceImage;aux:AuxState;onApply:(r:ReferenceApply)=>void};
interface RefImage {name:string;image:ImageBuf;url:string;}
interface Analysis {report:ReferenceReport;source:ImageBuf;depthLabel:string;depthKind:DepthKind;note?:string;}
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
/** Pixel code values as given, tagged with the source's declared space (same reading as the source image). */
function toImageBuf(asset:ImageAsset,space:SpaceName):ImageBuf{
  const data=new Float32Array(asset.width*asset.height*4);
  if(asset.floatPixels)data.set(asset.floatPixels);else for(let i=0;i<data.length;i++)data[i]=asset.pixels[i]/255;
  return imageBuf(asset.width,asset.height,space,data);
}
const SOURCE_KIND:Record<AuxState['depthSource'],DepthKind>={estimate:'model',upload:'upload',heuristic:'heuristic',none:'heuristic'};
const LEVEL_CLASS={hoch:'high',mittel:'mid',niedrig:'low'} as const;

export function ReferencePanel({graph,source,aux,onApply}:Props){
  const uid=useId(),input=useRef<HTMLInputElement>(null),job=useRef(0),controller=useRef<AbortController|undefined>(undefined);
  const [ref,setRef]=useState<RefImage>(),[analysis,setAnalysis]=useState<Analysis>(),[selected,setSelected]=useState<Set<AspectId>>(new Set());
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[done,setDone]=useState('');
  const refUrl=useRef<string|undefined>(undefined);
  useEffect(()=>()=>{job.current++;controller.current?.abort();if(refUrl.current)URL.revokeObjectURL(refUrl.current);},[]);
  const depthDecl=Object.values(graph.inputs).find(d=>d.kind==='depth'),modelId=depthDecl?.sources.find(s=>s.type==='estimate')?.model??DEFAULT_DEPTH_MODEL;
  const stale=!!analysis&&!!source&&analysis.source!==source.image;

  async function analyse(r:RefImage){
    if(!source){setError('Zuerst ein Ausgangsbild laden.');return;}
    const id=++job.current;controller.current?.abort();const ctrl=new AbortController();controller.current=ctrl;
    setError('');setDone('');setBusy('Tiefe der Referenz …');
    try{
      const d=await referenceDepth(r.image,{useModel:aux.depthSource==='estimate',modelId,signal:ctrl.signal,onProgress:p=>{if(id===job.current)setBusy(`Tiefe der Referenz (Modell) · ${Math.round(p*100)} %`);}});
      if(id!==job.current)return;
      setBusy('Analysiere Farbe, Licht, Himmel, Dunst, Schärfe …');await tick();
      const srcDepth=aux.channels.depth??heuristicDepth(source.image),srcKind=aux.channels.depth?SOURCE_KIND[aux.depthSource]:'heuristic';
      const report=analyzeReference({image:r.image,depth:d.depth,depthKind:d.kind},{image:source.image,depth:srcDepth,depthKind:srcKind},{displaySpace:graph.colorManagement.working.display,srcEditorDepth:!!aux.channels.depth});
      if(id!==job.current)return;
      setAnalysis({report,source:source.image,depthLabel:d.label,depthKind:d.kind,note:d.note});
      setSelected(new Set(report.aspects.filter(a=>a.defaultOn&&a.transferable).map(a=>a.id)));
    }catch(e){if(id===job.current&&!ctrl.signal.aborted)setError(`Analyse fehlgeschlagen: ${message(e)}`);}
    finally{if(id===job.current)setBusy('');}
  }
  async function load(file:File){
    setError('');setDone('');
    try{
      const asset=await readImage(file);
      if(refUrl.current)URL.revokeObjectURL(refUrl.current);
      refUrl.current=asset.url.startsWith('blob:')?asset.url:undefined;
      const r:RefImage={name:asset.name,image:toImageBuf(asset,source?.image.space??graph.colorManagement.input),url:asset.url};
      setRef(r);setAnalysis(undefined);void analyse(r);
    }catch(e){setError(`Referenzbild konnte nicht geladen werden: ${message(e)}`);}
  }
  function apply(){
    if(!analysis||!source||!ref)return;
    try{
      const r=buildReferenceGraph({base:graph,report:analysis.report,selected,fileName:ref.name,source:source.image,sourceDepth:aux.channels.depth});
      onApply(r);setDone(`Übernommen: ${r.applied.join(' · ')||'nichts ausgewählt'}${r.files.has(REFERENCE_LUT)?` · ${REFERENCE_LUT}`:''}`);
    }catch(e){setError(`Übernehmen fehlgeschlagen: ${message(e)}`);}
  }
  const toggle=(id:AspectId)=>setSelected(s=>{const n=new Set(s);if(n.has(id))n.delete(id);else n.add(id);return n;});
  const pick=(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];e.target.value='';if(f)void load(f);};
  const aspects=analysis?[...analysis.report.aspects].sort((a,b)=>ASPECT_ORDER.indexOf(a.id)-ASPECT_ORDER.indexOf(b.id)):[];

  return <section className="buck-panel buck-reference control-panel" aria-labelledby={`${uid}-t`} aria-busy={!!busy}>
    <h2 id={`${uid}-t`}>Referenzbild</h2>
    <div className="buck-ref-body">
      <p className="buck-note">Ein Referenzbild genügt: Der Editor misst Farbe, Lichtfarbe, Tageszeit, Himmel, Dunst, Tiefenschärfe, Lichtrichtung und Lampen und schlägt daraus einen vollständigen Graphen für das geladene Ausgangsbild vor. Referenzbilder bleiben lokal und werden nicht in die .buck-Datei geschrieben – nur die abgeleiteten Parameter und die LUT.</p>
      <div className="buck-ref-head">
        {ref?<img className="buck-ref-thumb" src={ref.url} alt={`Referenzbild: ${ref.name}`}/>:<div className="buck-ref-thumb buck-ref-empty" aria-hidden="true"><ImageUp size={18}/></div>}
        <div className="buck-ref-actions">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pick} aria-label="Referenzbild auswählen"/>
          <button type="button" className="buck-tool" onClick={()=>input.current?.click()} disabled={!!busy}><ImageUp size={15}/>{ref?'Anderes Referenzbild':'Referenzbild laden'}</button>
          {ref&&<button type="button" className="buck-tool" onClick={()=>void analyse(ref)} disabled={!!busy||!source}><RefreshCw size={15}/>Neu analysieren</button>}
          {ref&&<span className="buck-ref-name" title={ref.name}>{ref.name} · {ref.image.width}×{ref.image.height}</span>}
        </div>
      </div>
      {busy&&<p className="buck-note" role="status" aria-live="polite"><LoaderCircle size={13} className="spin"/>{busy}</p>}
      {error&&<div className="buck-msg error" role="alert"><span>{error}</span><button type="button" className="icon-button" aria-label="Fehler schließen" onClick={()=>setError('')}><X size={16}/></button></div>}
      {analysis&&<>
        <p className="buck-ref-depth">
          <span className={`buck-badge${analysis.depthKind==='heuristic'?' warn':''}`}>Tiefe der Referenz: {analysis.depthLabel}</span>
          {analysis.depthKind==='heuristic'&&<small>Für echte Tiefe in den Hilfskanälen das Modell laden; dieselben Gewichte werden dann auch für die Referenz verwendet.</small>}
          {analysis.note&&<small>{analysis.note}</small>}
          {!aux.channels.depth&&<small>Das Ausgangsbild hat noch keine Tiefe: Für die Analyse wurde die Behelfstiefe genommen; Raumknoten bleiben überbrückt, bis in den Hilfskanälen eine Tiefe vorliegt.</small>}
        </p>
        {stale&&<p className="buck-note buck-warning" role="note"><TriangleAlert size={13}/>Das Ausgangsbild hat sich seit der Analyse geändert. Bitte neu analysieren.</p>}
        <ul className="buck-ref-list" aria-label="Vorschläge aus dem Referenzbild">
          {aspects.map(a=>{
            const cid=`${uid}-${a.id}`;
            return <li key={a.id} className={`buck-ref-item${a.transferable?'':' buck-ref-off'}`}>
              <div className="buck-ref-top">
                <input id={cid} type="checkbox" checked={selected.has(a.id)&&a.transferable} disabled={!a.transferable||!!busy} onChange={()=>toggle(a.id)} aria-describedby={`${cid}-v ${cid}-r ${cid}-t`}/>
                <label htmlFor={cid}>{a.title}</label>
                <span className={`buck-conf ${LEVEL_CLASS[a.level]}`} title={`Konfidenz ${de(a.confidence,2)} (0…1)`}>Konfidenz {a.level} · {de(a.confidence,2)}</span>
              </div>
              <p id={`${cid}-v`} className="buck-ref-value">{a.value}</p>
              <p id={`${cid}-r`} className="buck-ref-reason">{a.reason}</p>
              {a.transferable?<p id={`${cid}-t`} className="buck-ref-reason">{a.transferReason}</p>
                :<p id={`${cid}-t`} className="buck-note buck-warning"><TriangleAlert size={13}/>Nicht übertragbar: {a.transferReason}</p>}
            </li>;
          })}
        </ul>
        <div className="buck-ref-apply">
          <button type="button" className="buck-tool buck-primary" onClick={apply} disabled={!!busy||stale||!source||selected.size===0}><Check size={15}/>Übernehmen</button>
          <small>Ersetzt die Knotenkette; Name „Referenz · {ref?.name}“. Farbmanagement bleibt. Die Farb-LUT wird als {REFERENCE_LUT} eingebettet.</small>
        </div>
      </>}
      {done&&<p className="buck-note" role="status"><Check size={13}/>{done}</p>}
    </div>
  </section>;
}
