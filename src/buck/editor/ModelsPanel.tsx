import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { Cloud, Eraser, ScanFace, Trash2, X } from 'lucide-react';
import { INPAINT_MODEL, KNOWN_MODELS, MODEL_INFO, SKY_MODEL, SUBJECT_MODEL } from '../depth/models';
import { runMlJob } from '../ml/run';
import type { MaskResult, PlateResult } from '../ml/run';
import type { BuckGraph } from '../types';
import { DEFAULT_GROW, PLATE_INPUT, SKY_INPUT, SUBJECT_INPUT, inpaintNodeOf, withInpaint, withSkyMask, withSubjectMask, withoutInpaint } from './ml';
import type { AuxState, SourceImage, UpdateGraph } from './types';
/**
 * Segmentation and inpainting (spec §6.5) in the .buck editor. Like depth, the weights come only from files the user picks;
 * the registry pin decides whether they run (SHA-256). Results are shot data in the aux channels, the graph gets the declared
 * inputs and nodes (editor/ml.ts).
 */
type Props={graph:BuckGraph;source?:SourceImage;aux:AuxState;setAux:(next:AuxState|((a:AuxState)=>AuxState))=>void;updateGraph:UpdateGraph};
type Step='sky'|'subject'|'inpaint';
const MODEL:Record<Step,string>={sky:SKY_MODEL,subject:SUBJECT_MODEL,inpaint:INPAINT_MODEL};
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const BODY={display:'grid',gap:9,padding:'12px 15px 15px',fontSize:12} as const,ROW={display:'flex',flexWrap:'wrap',alignItems:'center',gap:8} as const;
const H3={margin:'6px 0 0',fontSize:12,fontWeight:600} as const,NOTE={display:'block'} as const,BTN={justifySelf:'start'} as const;
const mb=(n?:number)=>n?`${(n/1e6).toLocaleString('de-DE',{maximumFractionDigits:0})} MB`:'';

export function ModelsPanel({graph,source,aux,setAux,updateGraph}:Props){
  const uid=useId(),[running,setRunning]=useState<Step>(),[progress,setProgress]=useState<number>(),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>();
  const files={sky:useRef<HTMLInputElement>(null),subject:useRef<HTMLInputElement>(null),inpaint:useRef<HTMLInputElement>(null)};
  const controller=useRef<AbortController|undefined>(undefined);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const masks=aux.channels.masks,plate=aux.channels.images?.[PLATE_INPUT],busy=!!running||aux.busy;
  const hasStep=!!inpaintNodeOf(graph);

  async function run(step:Step,file:File){
    if(!source)return;
    const pin=KNOWN_MODELS[MODEL[step]],ctrl=new AbortController();controller.current=ctrl;
    setRunning(step);setProgress(0);setError(undefined);setNotice(undefined);
    try{
      const weights=await file.arrayBuffer(),opts={signal:ctrl.signal,onProgress:setProgress};
      if(step==='inpaint'){
        const subject=masks[SUBJECT_INPUT];if(!subject)throw new Error('Zuerst das Motiv erkennen.');
        const r=await runMlJob({task:'inpaint',image:source.image,pin,weights,allowUnpinned:false,mask:subject,grow:DEFAULT_GROW},opts) as PlateResult;
        setAux(a=>({...a,channels:{...a.channels,images:{...a.channels.images,[PLATE_INPUT]:r.plate}}}));
        updateGraph(g=>withInpaint(g,DEFAULT_GROW));
        setNotice(`Motiv entfernt · ${pin.name} · sha256 ${r.weightsSha256.slice(0,8)}… · ${r.backend==='webgpu'?'WebGPU':'WASM'}`);
      }else{
        const r=await runMlJob({task:'mask',image:source.image,pin,weights,allowUnpinned:false},opts) as MaskResult;
        const name=step==='sky'?SKY_INPUT:SUBJECT_INPUT;
        setAux(a=>({...a,channels:{...a.channels,masks:{...a.channels.masks,[name]:r.mask}}}));
        updateGraph(g=>step==='sky'?withSkyMask(g):withSubjectMask(g));
        setNotice(`${step==='sky'?'Himmelsmaske':'Motivmaske'} · ${pin.name} · sha256 ${r.weightsSha256.slice(0,8)}… · ${r.backend==='webgpu'?'WebGPU':'WASM'}`);
      }
    }catch(e){
      if(ctrl.signal.aborted)setNotice('Modelllauf abgebrochen.');
      else{
        const m=message(e);
        // BiRefNet at 1024 px exceeds the 4 GB address space of WebAssembly, and one of its WebGPU shaders needs more storage
        // buffers than Apple GPUs offer (11 > 10).
        setError(/bad_alloc|memory|Speicher/i.test(m)?`${m} – Das Modell braucht mehr Speicher, als WebAssembly hat.`:/storage buffers/i.test(m)?`${m} – Diese Grafikkarte erlaubt zu wenige Speicherpuffer je Shader für das Modell.`:m);
      }
    }finally{if(controller.current===ctrl)controller.current=undefined;setRunning(undefined);setProgress(undefined);}
  }
  const pick=(step:Step)=>(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];e.target.value='';if(f)void run(step,f);};
  const dropMask=(name:string)=>setAux(a=>{const {[name]:_x,...rest}=a.channels.masks;void _x;return {...a,channels:{...a.channels,masks:rest}};});

  const row=(step:Step,icon:ReactNode,label:string,enabled:boolean,hint?:string)=>{
    const pin=KNOWN_MODELS[MODEL[step]],info=MODEL_INFO[MODEL[step]];
    return <>
      <p className="buck-note" style={NOTE}>{info?.note} <small>{pin.name} · {pin.license} · Datei <code>{info?.file}</code> {mb(info?.bytes)} · SHA-256 <code className="buck-hash" title={pin.weightsSha256}>{pin.weightsSha256.slice(0,12)}…</code></small></p>
      <input ref={files[step]} type="file" accept=".onnx" hidden onChange={pick(step)} aria-label={`ONNX-Datei für ${label} wählen`}/>
      <button type="button" className="buck-button buck-tool" style={BTN} disabled={!source||busy||!enabled} title={!source?'Zuerst ein Ausgangsbild laden':hint} onClick={()=>files[step].current?.click()}>{icon}{label} (ONNX-Datei wählen)</button>
    </>;
  };

  return <section className="buck-panel buck-aux control-panel" aria-labelledby={`${uid}-t`} aria-busy={busy}>
    <h2 id={`${uid}-t`}>Masken &amp; Retusche</h2>
    <div style={BODY}>
      <p className="buck-note" style={NOTE}>Lokale Modelle, deren Hash im Register gepinnt ist. Es wird nichts heruntergeladen und nichts hochgeladen; das Ergebnis gilt für dieses Bild und wird wie die Tiefe als Hilfskanal behandelt.</p>
      {error&&<p className="buck-error" role="alert">{error}</p>}
      <p className="buck-note" style={NOTE} role="status" aria-live="polite">{notice??''}</p>
      {running&&<div className="buck-row buck-progress" style={ROW}>
        <progress max={1} value={progress??0} aria-label="Fortschritt des Modelllaufs">{Math.round((progress??0)*100)} %</progress><span>{Math.round((progress??0)*100)} %</span>
        <button type="button" className="buck-button buck-tool" style={BTN} onClick={()=>controller.current?.abort()}><X size={14}/>Abbrechen</button>
      </div>}

      <h3 style={H3}>Himmel {masks[SKY_INPUT]?'· erkannt':''}</h3>
      {row('sky',<Cloud size={14}/>,'Himmel erkennen',true)}
      {masks[SKY_INPUT]&&<p className="buck-note" style={NOTE}>Himmel ersetzen nutzt jetzt diese Maske statt der Tiefe, Wolken eingeschlossen.</p>}
      {masks[SKY_INPUT]&&<button type="button" className="buck-button buck-tool" style={BTN} disabled={busy} onClick={()=>dropMask(SKY_INPUT)}><Trash2 size={14}/>Himmelsmaske verwerfen</button>}

      <h3 style={H3}>Motiv {masks[SUBJECT_INPUT]?'· erkannt':''}</h3>
      {row('subject',<ScanFace size={14}/>,'Motiv erkennen',true,'Läuft am besten mit WebGPU')}
      {masks[SUBJECT_INPUT]&&<p className="buck-note" style={NOTE}>Als Eingabe <code>$subject</code> verfügbar, etwa für „Maske aus Eingabe“ oder die Retusche.</p>}

      <h3 style={H3}>Retusche {hasStep?'· aktiv':''}</h3>
      {row('inpaint',<Eraser size={14}/>,'Motiv entfernen',!!masks[SUBJECT_INPUT],'Zuerst das Motiv erkennen')}
      {hasStep&&!plate&&<p className="buck-note buck-warning" style={NOTE} role="note">Der Look enthält eine Retusche, für dieses Bild fehlt aber die gefüllte Fassung. Sie wird übersprungen, bis „Motiv entfernen“ erneut läuft.</p>}
      {hasStep&&<button type="button" className="buck-button buck-tool" style={BTN} disabled={busy} onClick={()=>{updateGraph(withoutInpaint);setAux(a=>{const {[PLATE_INPUT]:_x,...images}=a.channels.images??{};void _x;return {...a,channels:{...a.channels,images}};});}}><Trash2 size={14}/>Retusche entfernen</button>}
    </div>
  </section>;
}
