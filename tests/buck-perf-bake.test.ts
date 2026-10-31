import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bakeColorCube, bakeLookCube, serializeBuckCube } from '../src/buck/bake';
import { bakedLutPath, bakeForSave, handleBakeJob } from '../src/buck/bake.worker';
import type { BakeDone, BakeFailed, BakeProgress, BakeReply } from '../src/buck/bake.worker';
import type { BuckGraph, BuckNode } from '../src/buck/types';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8')) as BuckGraph;
const SIZE=17,FALLBACK='luts/fallback_64.cube';

/** Reference copy of the former main-thread bake in BuckEditor.saveBuck (before bake.worker.ts). */
function referenceBake(graph:BuckGraph,existing:Map<string,Uint8Array>,size:number){
  let g=graph;const files=new Map(existing);
  const taken=new Set([...files.keys()]),enc=new TextEncoder();
  const nodes:BuckNode[]=g.nodes.map(n=>{
    if(n.type!=='color.look@1')return n;
    const path=bakedLutPath(n.id,taken);
    files.set(path,enc.encode(serializeBuckCube(bakeLookCube(n.params,size),size,`${g.meta.name} · ${n.label??n.id}`,n.params.space,n.params.space)));
    return {...n,params:{...n.params,bakedLut:path}};
  });
  g={...g,nodes};
  const cm=g.colorManagement,fb=bakeColorCube(g,files,size);
  files.set(FALLBACK,enc.encode(serializeBuckCube(fb.data,size,`${g.meta.name} · nur Farbe`,cm.input,cm.output)));
  g={...g,fallback:{cube:FALLBACK,inputSpace:cm.input,outputSpace:cm.output,covers:fb.covers,omits:fb.omits}};
  return {graph:g,files,fb};
}
/** Fixture plus a second look whose id slugs onto an already taken path. */
function twoLooks():{graph:BuckGraph;files:Map<string,Uint8Array>} {
  const g=fixture(),look=g.nodes.find(n=>n.type==='color.look@1') as BuckNode;
  const second={...look,id:'Fargo',label:'Zweiter Look',inputs:{image:look.id}} as BuckNode;
  return {graph:{...g,nodes:[...g.nodes,second],output:'Fargo'},files:new Map([['luts/fargo_rec709_64.cube',new Uint8Array([1,2,3])],['meta/notes.txt',new Uint8Array([4])]])};
}

describe('bake worker produces the bytes of the former main-thread bake', () => {
  for(const [name,make] of [['fixture',()=>({graph:fixture(),files:new Map<string,Uint8Array>()})],['two looks, taken path',twoLooks]] as const){
    it(name, () => {
      const {graph,files}=make(),ref=referenceBake(graph,files,SIZE);
      const replies:BakeReply[]=[];
      handleBakeJob({jobId:3,graph,files:[],taken:[...files.keys()],size:SIZE,fallbackPath:FALLBACK},r=>replies.push(r),()=>0);
      const done=replies.at(-1) as BakeDone;
      expect('error' in done).toBe(false);
      expect(done.graph).toEqual(ref.graph);
      expect(done.covers).toEqual(ref.fb.covers);expect(done.omits).toEqual(ref.fb.omits);
      const added=[...ref.files].filter(([p])=>!files.has(p)||files.get(p)!==ref.files.get(p));
      expect(done.entries.map(([p])=>p).sort()).toEqual(added.map(([p])=>p).sort());
      for(const [p,b] of done.entries)expect(Buffer.from(b).equals(Buffer.from(ref.files.get(p) as Uint8Array))).toBe(true);
      // Progress before every cube, monotone, then the result.
      const progress=replies.slice(0,-1) as BakeProgress[],looks=graph.nodes.filter(n=>n.type==='color.look@1').length;
      expect(progress).toHaveLength(looks+1);
      expect(progress.map(p=>p.progress)).toEqual(Array.from({length:looks+1},(_,i)=>i/(looks+1)));
      expect(progress.at(-1)?.label).toBe('Fallback-Cube');
    });
  }
  it('reports errors with the job id', () => {
    const g=fixture(),bad={...g,colorManagement:{...g.colorManagement,output:'ACEScg' as const}};
    const replies:BakeReply[]=[];handleBakeJob({jobId:9,graph:bad,files:[],taken:[],size:SIZE,fallbackPath:FALLBACK},r=>replies.push(r));
    const last=replies.at(-1) as BakeFailed;expect(last.jobId).toBe(9);expect(last.error).toMatch(/Fallback|convert|endet/);
  });
  it('bakeForSave keeps the caller graph untouched', () => {
    const g=fixture(),before=JSON.stringify(g);bakeForSave({graph:g,files:[],taken:[],size:SIZE,fallbackPath:FALLBACK});
    expect(JSON.stringify(g)).toBe(before);
  });
});
