import { INPAINT_MODEL, SKY_MODEL, SUBJECT_MODEL } from '../depth/models';
import { BuckError } from '../types';
import type { AuxChannels, BuckGraph, BuckNode, ImageBuf, InputDecl } from '../types';
import { ensureInputs, insertByLevel, removeNode, uniqueId } from './chain';
/**
 * Graph side of the segmentation and inpainting models (spec §6.5): declared inputs with an estimate source and the nodes
 * that use them. Pure functions; the aux panel runs the models and stores the results under the same input names.
 */
export const SKY_INPUT='sky',SUBJECT_INPUT='subject',PLATE_INPUT='plate';
/** Grow of the hole around the subject (image widths): covers the soft edge and a thin shadow line. */
export const DEFAULT_GROW=.006;

const maskInput=(model:string):InputDecl=>({kind:'mask',required:false,sources:[{type:'cache'},{type:'estimate',model}],onMissing:'bypass-dependents'});
export const plateInput=(grow:number):InputDecl=>({kind:'image',required:false,sources:[{type:'cache'},{type:'estimate',model:INPAINT_MODEL,hole:{input:SUBJECT_INPUT,grow}}],onMissing:'bypass-dependents'});
const declare=(graph:BuckGraph,name:string,decl:InputDecl):BuckGraph=>({...graph,inputs:{...graph.inputs,[name]:decl}});

/** Declares `$sky` (sky segmentation); ensureInputs then connects it to every sky.replace@1. */
export const withSkyMask=(graph:BuckGraph)=>ensureInputs(declare(graph,SKY_INPUT,graph.inputs[SKY_INPUT]?.kind==='mask'?graph.inputs[SKY_INPUT]:maskInput(SKY_MODEL)));
/** Declares `$subject` (subject segmentation by `model`), usable by mask.input@1 and as the hole of the inpainting plate. */
export const withSubjectMask=(graph:BuckGraph,model=SUBJECT_MODEL)=>{
  const cur=graph.inputs[SUBJECT_INPUT];
  // An existing declaration keeps its other sources; only the estimate source follows the model that actually ran.
  const decl:InputDecl=cur?.kind==='mask'?{...cur,sources:[...cur.sources.filter(s=>s.type!=='estimate'),{type:'estimate',model}]}:maskInput(model);
  return ensureInputs(declare(graph,SUBJECT_INPUT,decl));
};

/** Image every analysis (sky, depth) runs on: the plate when a subject was removed, otherwise the source. */
export const analysisImage=(channels:AuxChannels,source:ImageBuf)=>channels.images?.[PLATE_INPUT]??source;

/** The fill node of the "remove subject" step, if the graph has one. */
export const inpaintNodeOf=(graph:BuckGraph)=>graph.nodes.find(n=>n.type==='fill.inpaint@1'&&n.inputs.plate===`$${PLATE_INPUT}`);

/**
 * "Motiv entfernen": declares `$plate` (inpainted from `$subject`, grown by `grow`) and puts fill.inpaint@1 at the start of
 * the light level, masked by the same region (mask.input@1 of `$subject` → mask.refine@1 with the same grow and a soft edge
 * of a third of it). An existing step is replaced, so the grow of node and plate always match.
 */
export function withInpaint(graph:BuckGraph,grow=DEFAULT_GROW):BuckGraph{
  if(!(grow>=0&&grow<=.1))throw new BuckError('Die Erweiterung der Retuschemaske muss zwischen 0 und 0,1 Bildbreiten liegen.');
  const before=withoutInpaint(graph);
  let g=before.inputs[SUBJECT_INPUT]?.kind==='mask'?before:withSubjectMask(before);
  g=declare(g,PLATE_INPUT,plateInput(grow));
  const src=uniqueId(g,'subjectMask'),refine=uniqueId({...g,nodes:[...g.nodes,{id:src} as BuckNode]},'holeMask');
  const masks:BuckNode[]=[
    {id:src,type:'mask.input@1',label:'Motiv (Modell)',inputs:{},params:{input:`$${SUBJECT_INPUT}`,channel:'luma'}},
    {id:refine,type:'mask.refine@1',label:'Retuscheregion',inputs:{mask:src},params:{grow,blur:grow/3,gamma:1}},
  ];
  const id=uniqueId({...g,nodes:[...g.nodes,...masks]},'inpaint');
  const node:BuckNode={id,type:'fill.inpaint@1',label:'Retusche · Motiv entfernt',inputs:{image:'$source',plate:`$${PLATE_INPUT}`,mask:refine},params:{}};
  return insertByLevel(g,node,{edge:'start',masks});
}
/** Removes the fill node with its two masks and the plate declaration; `$subject` stays (it is still a usable mask). */
export function withoutInpaint(graph:BuckGraph):BuckGraph{
  const node=inpaintNodeOf(graph);
  if(!node)return graph;
  const refine=graph.nodes.find(n=>n.id===node.inputs.mask),src=refine?.type==='mask.refine@1'?graph.nodes.find(n=>n.id===refine.inputs.mask):undefined;
  let g=removeNode(graph,node.id);
  for(const m of [refine,src])if(m&&m.type.startsWith('mask.')&&!g.nodes.some(n=>Object.values(n.inputs).includes(m.id)))g={...g,nodes:g.nodes.filter(n=>n.id!==m.id)};
  const {[PLATE_INPUT]:_drop,...inputs}=g.inputs;void _drop;
  return ensureInputs({...g,inputs});
}
