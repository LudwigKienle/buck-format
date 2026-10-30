import { imageBuf } from './field';
import { lookNode } from './nodes/color';
import { renderGraph } from './render';
import { BuckError, OFX_CONFIG, SPACE_NAMES } from './types';
import type { BuckGraph, BuckNode, ImageBuf, LookParams, Resolved, SpaceName } from './types';
/**
 * Fallback cube (spec §3.4, §5.5): the color part of a graph sampled on an N³ grid. Layout and text format follow
 * src/color/engine.ts (makeCube/serializeCube) and the Iridas/Adobe Cube 1.0 convention read by native/ofx Cube.cpp:
 * red changes fastest, then green, then blue.
 */
const CUBE_MIN=2,CUBE_MAX=256;
function checkSize(size:number){
  if(!Number.isInteger(size)||size<CUBE_MIN||size>CUBE_MAX)throw new BuckError(`Cube-Größe muss eine ganze Zahl von ${CUBE_MIN} bis ${CUBE_MAX} sein.`);
}
function checkSpace(name:SpaceName,what:string){
  if(!(SPACE_NAMES as readonly string[]).includes(name))throw new BuckError(`${what}: unbekannter Farbraum „${String(name)}“.`);
}
/** Identity grid as an (N·N)×N image: pixel x = r + N·g, row y = b, so pixel order equals cube row order. */
export function cubeGrid(size:number,space:SpaceName):ImageBuf {
  checkSize(size);
  const img=imageBuf(size*size,size,space),d=img.data,s=size-1;let i=0;
  for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++){d[i++]=r/s;d[i++]=g/s;d[i++]=b/s;d[i++]=1;}
  return img;
}
function cubeData(img:ImageBuf,size:number):Float32Array {
  if(img.width!==size*size||img.height!==size||img.data.length!==size**3*4)throw new BuckError('Das gebackene Gitter hat nicht die erwartete Größe.');
  const out=new Float32Array(size**3*3),d=img.data;
  for(let p=0,i=0;i<d.length;p+=3,i+=4){out[p]=d[i];out[p+1]=d[i+1];out[p+2]=d[i+2];}
  return out;
}
/** Node ids the graph output depends on through any port (unreachable nodes are neither covered nor omitted). */
function reachable(graph:BuckGraph):Set<string> {
  const byId=new Map<string,BuckNode>(),seen=new Set<string>();
  for(const n of graph.nodes)if(!byId.has(n.id))byId.set(n.id,n);
  const stack=[graph.output];
  while(stack.length){
    const ref=stack.pop() as string;if(ref.startsWith('$')||seen.has(ref))continue;
    const n=byId.get(ref);if(!n)continue;
    seen.add(ref);for(const r of Object.values(n.inputs))stack.push(r);
  }
  return seen;
}
const isColor=(n:BuckNode)=>n.type.startsWith('color.');
const isMask=(n:BuckNode)=>n.type.startsWith('mask.');

/**
 * Bakes every unmasked color.* node; all other nodes and masked color nodes are force-bypassed. `covers` lists the
 * active baked color nodes, `omits` the active effects missing from the cube (spatial nodes and masked color nodes,
 * as in the spec §13 example); mask nodes and disabled nodes appear in neither. Grid values are in
 * colorManagement.input, results in colorManagement.output. Animated `amount` is evaluated at frame 0 (timing
 * reference), because a cube cannot vary over time.
 */
export function bakeColorCube(graph:BuckGraph,files:Map<string,Uint8Array>,size:number):{data:Float32Array;covers:string[];omits:string[]} {
  checkSize(size);
  const cm=graph.colorManagement,live=reachable(graph),covers:string[]=[],omits:string[]=[],forceBypass:string[]=[];
  for(const n of graph.nodes){
    const listed=n.enabled!==false&&live.has(n.id);
    if(isColor(n)&&n.inputs.mask===undefined){if(listed)covers.push(n.id);continue;}
    forceBypass.push(n.id);
    if(listed&&!isMask(n))omits.push(n.id);
  }
  const {output}=renderGraph(graph,cubeGrid(size,cm.input),{frame:0,aux:{masks:{}},files,forceBypass});
  if(output.kind!=='image')throw new BuckError('Der Ausgang des Graphen muss ein Bild liefern.');
  if(output.space!==cm.output)throw new BuckError(`Der Farbanteil endet in „${output.space}“, deklariert ist „${cm.output}“. Ohne abschließenden color.convert@1-Knoten lässt sich kein Fallback-Cube backen.`);
  return {data:cubeData(output,size),covers,omits};
}

/**
 * `bakedLut` of one color.look@1 node (spec §5.2.1, §5.5): the cube domain is the node's declared space. The node's
 * warning about a non-Rec.1886 space is dropped: the round trip it announces is part of what the cube bakes.
 */
export function bakeLookCube(params:LookParams,size:number):Float32Array {
  checkSize(size);checkSpace(params.space,'color.look@1');
  const grid=cubeGrid(size,params.space);
  const out=lookNode.evaluate({image:grid},params as Resolved<LookParams>,{width:grid.width,height:grid.height,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'ACEScg',warn:()=>{}});
  if(out.kind!=='image')throw new BuckError('color.look@1 lieferte kein Bild.');
  return cubeData(out,size);
}

/**
 * Iridas .cube text like serializeCube in src/color/engine.ts. The `# Input:`/`# Output:` comments carry the OFX
 * config names that native/ofx Cube.cpp reads and that graph.fallback must repeat (spec §3.4).
 */
export function serializeBuckCube(data:Float32Array,size:number,title:string,input:SpaceName,output:SpaceName):string {
  checkSize(size);checkSpace(input,'Cube-Eingang');checkSpace(output,'Cube-Ausgang');
  if(data.length!==size**3*3)throw new BuckError('Ungültige LUT-Größe.');
  const name=title.replace(/["\r\n\x00-\x1f\x7f]/g,' ').slice(0,100).trim()||'Buckswood Look';
  const lines=[`TITLE "${name}"`,'# Buckswood .buck fallback',`# Input: ${input}`,`# Output: ${output}`,`# Config: ${OFX_CONFIG}`,'# Contains only the color nodes of the .buck graph; spatial effects are omitted.','# Range: Full 0-1. Apply once in the declared input/output spaces.','# Recommended interpolation: tetrahedral',`LUT_3D_SIZE ${size}`,'DOMAIN_MIN 0.0 0.0 0.0','DOMAIN_MAX 1.0 1.0 1.0'];
  for(let i=0;i<data.length;i+=3){
    const r=data[i],g=data[i+1],b=data[i+2];
    if(!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b))throw new BuckError('Nicht endlicher LUT-Wert.');
    lines.push(`${r.toFixed(9)} ${g.toFixed(9)} ${b.toFixed(9)}`);
  }
  return lines.join('\n')+'\n';
}
