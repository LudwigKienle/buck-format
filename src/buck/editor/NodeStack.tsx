import { useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Lock, Plus, Trash2 } from 'lucide-react';
import { LEVELS, NODE_CATALOG, addNode, ensureConversions, ensureInputs, imageChain, isAutoNode, levelGroups, maskNodes, moveNode, removeNode } from './chain';
import type { CatalogGroup } from './chain';
import { catalogEntry, nodeTitle } from './controls';
import { TIME_OF_DAY_OPTIONS, TOD_KEY, applyTimeOfDay, isTimeOfDayNode, timeOfDayOf } from '../prompt';
import type { TimeOfDay } from '../prompt';
import type { BuckGraph, BuckNode, NodeType } from '../types';
import type { UpdateGraph } from './types';
import './levels.css';

/** Re-derives auto conversions and input declarations; idempotent, applied after every stack edit. */
export const tidy=(g:BuckGraph)=>ensureInputs(ensureConversions(g));
/** enabled defaults to true (spec §4.3), so switching on drops the key instead of writing `true`. */
export function toggleEnabled(graph:BuckGraph,id:string):BuckGraph {
  return tidy({...graph,nodes:graph.nodes.map(n=>{
    if(n.id!==id)return n;
    if(n.enabled===false){const {enabled:_off,...rest}=n;void _off;return rest as BuckNode;}
    return {...n,enabled:false};
  })});
}
/** Anchor for addNode: the selected node if it still exists (addNode decides whether it fits the new type). */
export const addAnchor=(graph:BuckGraph,selected?:string)=>selected&&graph.nodes.some(n=>n.id===selected)?selected:undefined;
export function addToStack(graph:BuckGraph,type:NodeType,selected?:string){
  const r=addNode(graph,type,addAnchor(graph,selected));return {graph:tidy(r.graph),id:r.id};
}
export const removeFromStack=(graph:BuckGraph,id:string)=>tidy(removeNode(graph,id));
export const moveInStack=(graph:BuckGraph,id:string,dir:-1|1)=>tidy(moveNode(graph,id,dir));
/** Time-of-day switch: applies the preset (or removes the switch's nodes for "as-shot") and tidies the graph. */
export const setTimeOfDay=(graph:BuckGraph,preset:TimeOfDay)=>tidy(applyTimeOfDay(graph,preset).graph);
/** Menu groups in level order (light → atmosphere → optics → grade), masks last. */
const GROUPS:CatalogGroup[]=['Licht','Raum','Optik','Farbe','Maske'];
export const catalogGroups=()=>GROUPS.map(group=>({group,entries:NODE_CATALOG.filter(e=>e.group===group)})).filter(g=>g.entries.length);

const message=(e:unknown)=>e instanceof Error?e.message:String(e);

interface Props {graph:BuckGraph;selected?:string;onSelect:(id?:string)=>void;updateGraph:UpdateGraph;}
export function NodeStack({graph,selected,onSelect,updateGraph}:Props){
  const [open,setOpen]=useState(false),[error,setError]=useState<string>();
  const menuId=useId(),chainId=useId(),maskId=useId(),toggleRef=useRef<HTMLButtonElement>(null);
  /** Computes on the rendered graph to surface errors; if the graph moved on meanwhile, the edit is redone on the newer one. */
  function commit(next:BuckGraph,redo:(g:BuckGraph)=>BuckGraph){
    setError(undefined);
    updateGraph(g=>{if(g===graph)return next;try{return redo(g);}catch{return g;}});
    return next;
  }
  function run(fn:(g:BuckGraph)=>BuckGraph){
    try{const next=commit(fn(graph),fn);if(selected&&!next.nodes.some(n=>n.id===selected))onSelect(undefined);}
    catch(e){setError(message(e));}
  }
  function add(type:NodeType){
    try{const r=addToStack(graph,type,selected);commit(r.graph,g=>addToStack(g,type,selected).graph);onSelect(r.id);closeMenu();}
    catch(e){setError(message(e));}
  }
  function closeMenu(){setOpen(false);toggleRef.current?.focus();}

  const chain=imageChain(graph),userChain=chain.filter(n=>!isAutoNode(n)),masks=maskNodes(graph),levels=levelGroups(graph),tod=timeOfDayOf(graph);
  const item=(n:BuckNode,group:BuckNode[])=>{
    const auto=isAutoNode(n),active=n.id===selected,title=nodeTitle(n),off=n.enabled===false,i=group.indexOf(n);
    const byTod=isTimeOfDayNode(n)?'Tageszeit':TOD_KEY in n?'von der Tageszeit angepasst':'';
    const sub=[auto?'automatisch':catalogEntry(n.type)?.label??n.type,n.id,n.inputs.mask?`Maske: ${n.inputs.mask}`:'',byTod,off?'aus':''].filter(Boolean).join(' · ');
    return <li key={n.id} className={`buck-item${active?' buck-item-active':''}${auto||off?' buck-muted':''}`} style={{display:'flex',alignItems:'center',gap:4}}>
      <button type="button" className="buck-button" aria-current={active||undefined} onClick={()=>onSelect(active?undefined:n.id)}
        style={{flex:1,minWidth:0,textAlign:'left',display:'grid'}}>
        <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{auto&&<Lock size={12} aria-hidden="true"/>} {title}</span>
        <small className="buck-muted">{sub}</small>
      </button>
      {auto?<span className="buck-muted" title="Wird bei jeder Änderung automatisch neu gesetzt und lässt sich nicht verschieben.">automatisch</span>:<>
        <button type="button" className="buck-icon-button" aria-pressed={!off} aria-label={`„${title}“ ${off?'einschalten':'ausschalten'}`} title={off?'Einschalten':'Ausschalten'} onClick={()=>run(g=>toggleEnabled(g,n.id))}>{off?<EyeOff size={14}/>:<Eye size={14}/>}</button>
        <button type="button" className="buck-icon-button" aria-label={`„${title}“ nach oben`} title="Nach oben" disabled={i<=0} onClick={()=>run(g=>moveInStack(g,n.id,-1))}><ChevronUp size={14}/></button>
        <button type="button" className="buck-icon-button" aria-label={`„${title}“ nach unten`} title="Nach unten" disabled={i<0||i>=group.length-1} onClick={()=>run(g=>moveInStack(g,n.id,1))}><ChevronDown size={14}/></button>
        <button type="button" className="buck-icon-button" aria-label={`„${title}“ löschen`} title="Löschen" onClick={()=>run(g=>removeFromStack(g,n.id))}><Trash2 size={14}/></button>
      </>}
    </li>;
  };
  return <section className="buck-panel" aria-label="Knotenliste">
    <div className="buck-tod" role="radiogroup" aria-label="Tageszeit">
      <span className="buck-tod-title">Tageszeit</span>
      <div className="buck-tod-options">
        {TIME_OF_DAY_OPTIONS.map(o=><button key={o.value} type="button" role="radio" aria-checked={tod===o.value} className={`buck-tod-option${tod===o.value?' buck-tod-active':''}`}
          onClick={()=>{if(o.value!==tod)run(g=>setTimeOfDay(g,o.value));}}>{o.label}</button>)}
      </div>
      <small className="buck-muted">Setzt Himmel, Szenenbelichtung, Grade und bei Bedarf Mond- oder Sonnenlicht als normale Knoten (Kennung „tod-“). „Wie aufgenommen“ entfernt sie wieder.</small>
    </div>
    <div style={{position:'relative'}}>
      <button ref={toggleRef} type="button" className="buck-button" aria-expanded={open} aria-controls={menuId} onClick={()=>setOpen(o=>!o)}><Plus size={14} aria-hidden="true"/> Knoten hinzufügen</button>
      <div id={menuId} hidden={!open} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();closeMenu();}}}>
        {catalogGroups().map(({group,entries})=><div key={group} role="group" aria-label={group}>
          <h4 className="buck-muted" aria-hidden="true">{group}</h4>
          {entries.map(e=><button key={e.type} type="button" className="buck-button" title={e.description} style={{display:'grid',textAlign:'left',width:'100%'}} onClick={()=>add(e.type)}>
            <span>{e.label}</span><small className="buck-muted">{e.description}</small>
          </button>)}
        </div>)}
      </div>
    </div>
    {error&&<p role="alert" className="buck-muted">{error}</p>}
    <h3 id={chainId}>Bildkette</h3>
    <p className="buck-muted">Quelle · {graph.colorManagement.input}</p>
    <div aria-labelledby={chainId}>
      {levels.groups.map((g,k)=>{
        const info=LEVELS.find(l=>l.id===g.level)!;
        return <section key={`${g.level}-${k}`} className={`buck-level buck-level-${g.level}${g.outOfOrder?' buck-level-off':''}`} aria-label={`Ebene ${info.label}`}>
          <h4 className="buck-level-title">{info.label}{g.outOfOrder&&<span className="buck-level-warn" title="Diese Knoten stehen hinter einer späteren Ebene. Die Datei wird nicht umsortiert.">außerhalb der Reihenfolge</span>}</h4>
          <p className="buck-muted buck-level-desc">{info.description}</p>
          {g.nodes.length?<ul className="buck-list">{g.nodes.map(n=>item(n,userChain))}</ul>:<p className="buck-muted buck-level-empty">Keine Knoten.</p>}
        </section>;
      })}
      {!levels.ordered&&<p className="buck-muted buck-level-note" role="note">Die Reihenfolge weicht von Licht → Atmosphäre → Optik → Grade ab. Sie bleibt, wie sie ist; neue Knoten kommen in ihre Ebene.</p>}
    </div>
    <p className="buck-muted">Ausgabe · {graph.colorManagement.output}</p>
    <h3 id={maskId}>Masken</h3>
    {masks.length?<ul className="buck-list" aria-labelledby={maskId}>{masks.map(n=>item(n,masks))}</ul>:<p className="buck-muted">Keine Masken.</p>}
  </section>;
}
