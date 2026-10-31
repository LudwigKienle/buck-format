import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bakeColorCube, bakeLookCube, serializeBuckCube } from '../src/buck/bake';
import { convertImage } from '../src/buck/colorspace';
import { isBuck, readBuck, sha256Hex, writeBuck } from '../src/buck/container';
import { heuristicDepth } from '../src/buck/depth/heuristic';
import { imageBuf, vectorField } from '../src/buck/field';
import { parseCube } from '../src/buck/nodes/color';
import { renderGraph } from '../src/buck/render';
import type { AuxChannels, BuckGraph, ImageBuf, LookParams } from '../src/buck/types';
import { checkGraph } from '../src/buck/validate';

/** End to end: fixture → writeBuck → readBuck (default parseGraph) → renderGraph with the real nodes and heuristic depth. */
const FIXTURE=readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8');
const W=64,H=36,CUBE=33;
const DISPLAY='Rec.1886 Rec.709 - Display';

/**
 * Synthetic street scene in display code values: a flat, neutral grey sky band on top (haze cues: far),
 * a saturated, textured ground below (contrast cues: near). The heuristic also puts the top of the frame far.
 */
function scene():ImageBuf {
  const img=imageBuf(W,H,DISPLAY);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4,t=y/(H-1);
    if(t<.45){img.data[i]=img.data[i+1]=img.data[i+2]=.35;}
    else{const c=((x>>2)+(y>>2))&1?.14:.3;img.data[i]=c*1.25;img.data[i+1]=c;img.data[i+2]=c*.7;}
    img.data[i+3]=1;
  }
  return img;
}
const fixture=()=>JSON.parse(FIXTURE) as BuckGraph;
/** Mean of an RGB statistic over a pixel rectangle (inclusive-exclusive). */
function mean(img:ImageBuf,x0:number,x1:number,y0:number,y1:number,f:(r:number,g:number,b:number)=>number){
  let s=0,n=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*W+x)*4;s+=f(img.data[i],img.data[i+1],img.data[i+2]);n++;}
  return s/n;
}
const luma=(r:number,g:number,b:number)=>.2126*r+.7152*g+.0722*b;
const cool=(r:number,_g:number,b:number)=>b-r,warm=(r:number,_g:number,b:number)=>r-b;
const asImage=(b:{kind:string})=>{expect(b.kind).toBe('image');return b as ImageBuf;};
const allFinite=(a:Float32Array)=>a.every(Number.isFinite);

async function build(){
  const graph=fixture();
  // Thumbnails are optional (spec §3.2); this test embeds no JPEGs, so the references are dropped.
  delete graph.meta.thumbnails;
  const files=new Map<string,Uint8Array>(),enc=new TextEncoder();
  const look=graph.nodes.find(n=>n.id==='fargo')!;
  if(look.type!=='color.look@1')throw new Error('Fixture ohne Look-Knoten');
  const lookParams=look.params as LookParams;
  files.set(lookParams.bakedLut!,enc.encode(serializeBuckCube(bakeLookCube(lookParams,CUBE),CUBE,graph.meta.name,lookParams.space,lookParams.space)));
  const baked=bakeColorCube(graph,files,CUBE),fb=graph.fallback!;
  // The fixture's fallback and the look's bakedLut share one path; the fallback (all colour nodes) wins.
  files.set(fb.cube,enc.encode(serializeBuckCube(baked.data,CUBE,graph.meta.name,fb.inputSpace,fb.outputSpace)));
  const bytes=await writeBuck(graph,files);
  return {graph,files,bytes,baked,pkg:await readBuck(bytes)};
}
// Baking and packing take a few seconds; every test shares one archive.
let built:ReturnType<typeof build>|undefined;
const roundTrip=()=>built??=build();
const rowMean=(f:Float32Array,y0:number,y1:number)=>{let s=0;for(let i=y0*W;i<y1*W;i++)s+=f[i];return s/((y1-y0)*W);};

describe('.buck end to end',{timeout:60000},()=>{
  it('writes and reads the fixture losslessly through the default validator',async()=>{
    const {graph,files,bytes,pkg}=await roundTrip();
    expect(checkGraph(graph)).toEqual([]);
    expect(isBuck(bytes)).toBe(true);
    expect(pkg.graph).toEqual(graph);
    expect([...pkg.files.keys()]).toEqual([...files.keys()].sort());
    for(const [path,data] of files)expect(pkg.files.get(path)).toEqual(data);
    expect(pkg.lookId).toBe(await sha256Hex(new TextEncoder().encode(JSON.stringify(graph,null,2))));
    expect(await writeBuck(pkg.graph,pkg.files)).toEqual(bytes);
  });

  it('renders the read-back graph with heuristic depth: finite, fog cools and lifts the background, relight warms the left',async()=>{
    const {pkg,graph}=await roundTrip(),src=scene(),depth=heuristicDepth(src);
    // The stand-in depth marks a detected sky as +Infinity (invalid), like a depth model; everything else stays in 0…1.
    expect(depth.data.every(v=>v===Infinity||(v>=0&&v<=1))).toBe(true);
    expect(rowMean(depth.data,0,6)).toBeGreaterThan(.75);expect(rowMean(depth.data,H-6,H)).toBeLessThan(.25);

    const aux:AuxChannels={depth,masks:{}},opts={frame:0,aux,files:pkg.files};
    const full=renderGraph(pkg.graph,src,opts);
    const out=asImage(full.output);
    expect(out.space).toBe(DISPLAY);
    expect(full.bypassed).toEqual([]);
    expect(allFinite(out.data)).toBe(true);
    // Same graph object before and after the container: bit-identical render (spec §7).
    expect(asImage(renderGraph(graph,src,opts).output).data).toEqual(out.data);
    expect(asImage(renderGraph(pkg.graph,src,opts).output).data).toEqual(out.data);

    const noFog=asImage(renderGraph(pkg.graph,src,{...opts,forceBypass:['fog']}).output);
    const sky:[number,number,number,number]=[0,W,0,6];
    expect(mean(out,...sky,luma)).toBeGreaterThan(mean(noFog,...sky,luma)+.03);
    // Colder is judged before the Fargo look: its whiteClean neutralizes bright, near-white areas on purpose.
    const pre=(forceBypass:string[])=>asImage(renderGraph(pkg.graph,src,{...opts,target:'toDisplay',forceBypass}).output);
    const fogged=pre([]),clear=pre(['fog']),ratio=(r:number,_g:number,b:number)=>b/r;
    expect(mean(fogged,...sky,ratio)).toBeGreaterThan(mean(clear,...sky,ratio)+.02);
    expect(mean(fogged,...sky,cool)).toBeGreaterThan(mean(clear,...sky,cool)+.01);
    // The near ground is outside bgMask and below fog.start: practically untouched by the fog.
    const ground:[number,number,number,number]=[0,W,H-6,H];
    expect(Math.abs(mean(out,...ground,luma)-mean(noFog,...ground,luma))).toBeLessThan(.01);

    const noKey=asImage(renderGraph(pkg.graph,src,{...opts,forceBypass:['warmKey']}).output);
    const leftGround:[number,number,number,number]=[0,W/2,H-10,H];
    expect(mean(out,...leftGround,warm)).toBeGreaterThan(mean(noKey,...leftGround,warm)+.01);
  });

  it('lights left-facing surfaces warmer than right-facing ones (azimuth −70°)',async()=>{
    const {pkg}=await roundTrip(),src=scene(),depth=heuristicDepth(src);
    // Convex surface: normals turn from facing left (x = 0) to facing right (x = W).
    const normals=vectorField(W,H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const nx=((x+.5)/W)*1.6-.8,i=(y*W+x)*3;normals.data[i]=nx;normals.data[i+2]=Math.sqrt(1-nx*nx);}
    const opts={frame:0,files:pkg.files},aux:AuxChannels={depth,normals,masks:{}};
    const lit=asImage(renderGraph(pkg.graph,src,{...opts,aux}).output),flat=asImage(renderGraph(pkg.graph,src,{...opts,aux,forceBypass:['warmKey']}).output);
    const gain=(x0:number,x1:number)=>mean(lit,x0,x1,H-10,H,warm)-mean(flat,x0,x1,H-10,H,warm);
    expect(gain(0,16)).toBeGreaterThan(.01);
    expect(gain(0,16)).toBeGreaterThan(gain(W-16,W)+.005);
  });

  it('stores a fallback cube that parses back to the baked data and matches the render of the colour nodes',async()=>{
    const {pkg,baked,graph}=await roundTrip(),fb=graph.fallback!;
    expect(baked.covers).toEqual(['toLinear','toDisplay','fargo']);
    expect(baked.omits).toEqual(fb.omits);
    const cube=parseCube(new TextDecoder().decode(pkg.files.get(fb.cube)!));
    expect(cube.size).toBe(CUBE);
    expect(cube.domainMin).toEqual([0,0,0]);expect(cube.domainMax).toEqual([1,1,1]);
    let max=0;for(let i=0;i<baked.data.length;i++)max=Math.max(max,Math.abs(cube.data[i]-baked.data[i]));
    expect(max).toBeLessThan(1e-7);
    // Lattice point (r,g,b) = grid index / (N−1): the cube reproduces the graph with fog and relight bypassed.
    const probe=imageBuf(1,1,DISPLAY,new Float32Array([4/32,16/32,28/32,1]));
    const r=asImage(renderGraph(pkg.graph,probe,{frame:0,aux:{masks:{}},files:pkg.files,forceBypass:['warmKey','fog']}).output);
    const at=(4+CUBE*16+CUBE*CUBE*28)*3;
    for(let c=0;c<3;c++)expect(cube.data[at+c]).toBeCloseTo(r.data[c],6);
    // Sanity: the ACEScg working space really is in the loop (a display→linear→display trip is not the identity cube).
    expect(convertImage(probe,'ACEScg').data[0]).not.toBeCloseTo(probe.data[0],3);
  });
});
