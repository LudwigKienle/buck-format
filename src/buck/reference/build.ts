import { analyze } from '../../color/analysis';
import type { Profile } from '../../color/analysis';
import { DEFAULT_SETTINGS, buildModel, makeCube } from '../../color/engine';
import { serializeBuckCube } from '../bake';
import { convertImage, convertPixel, lumaWeights } from '../colorspace';
import { defaultNode, ensureConversions, ensureInputs, insertByLevel } from '../editor/chain';
import { TOD_PREFIX, applyTimeOfDay, isTimeOfDayNode } from '../prompt';
import { imageBuf, scalarField } from '../field';
import { SKY_PRESET_LABELS, skyPresetParams } from '../nodes/sky';
import { renderGraph } from '../render';
import { FORMAT_VERSION, LIMITS } from '../types';
import type { BuckGraph, BuckNode, ColorValue, ImageBuf, NodeOf, RGB, ScalarField, SkyParams, SkyPreset, SpaceName } from '../types';
import { colorWeights, displaySpaceId, weightedPixels } from './analyze';
import type { AspectId, ReferenceReport } from './analyze';
import { clamp, de, deSigned, downDepth, hash01, lumaOf, r4, workSize } from './common';
import type { SkyRegion } from './common';
/**
 * Selected reference aspects → a complete .buck graph for the loaded source image, in the editor's levels (chain.ts LEVELS):
 * Licht (exposure/light color CDL, relight, practicals) → Atmosphäre (sky via the time-of-day switch, fog) → Optik (depth of
 * field) → Grade (time-of-day grade, 3D-LUT last, inserted with insertByLevel).
 * The LUT is fitted last, against a reduced render of the source through all other chosen nodes (with the editor's own depth),
 * so exposure, sky and fog are not counted twice. ensureConversions/ensureInputs (chain.ts) add conversions and inputs.
 */
export const REFERENCE_LUT='luts/reference_64.cube';
export const LUT_SIZE=64;
export interface BuildInput {
  base:BuckGraph;report:ReferenceReport;selected:ReadonlySet<AspectId>;fileName:string;
  /** Source image as the editor holds it (tagged with colorManagement.input) and the editor's depth, if any. */
  source:ImageBuf;sourceDepth?:ScalarField;
}
export interface BuildResult {graph:BuckGraph;files:Map<string,Uint8Array>;applied:string[];}
const clip=(s:string,max:number)=>s.length>max?`${s.slice(0,max-1)}…`:s;
const r2=(x:number)=>Math.round(x*100)/100;

/** Box downscale of an image buffer to the work size (same size as the analysis copy, so the weights line up). */
function downImage(img:ImageBuf,w:number,h:number):ImageBuf{
  if(img.width===w&&img.height===h)return img;
  const W=img.width,H=img.height,src=img.data,out=imageBuf(w,h,img.space),o=out.data;
  for(let y=0;y<h;y++){
    const y0=Math.floor(y*H/h),y1=Math.max(y0+1,Math.floor((y+1)*H/h));
    for(let x=0;x<w;x++){
      const x0=Math.floor(x*W/w),x1=Math.max(x0+1,Math.floor((x+1)*W/w)),n=(y1-y0)*(x1-x0),d=(y*w+x)*4;
      for(let c=0;c<4;c++){let s=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++)s+=src[(yy*W+xx)*4+c];o[d+c]=s/n;}
    }
  }
  return out;
}
function finishGraph(g:BuckGraph){return ensureInputs(ensureConversions(g));}
/** Bounds of the contrast transfer per half of the tone range (below/above the median). */
export const CONTRAST_TRANSFER:[number,number]=[.75,1.3];
/**
 * Tone transfer between different image contents: the reference median (key) is kept, its spread around the median only
 * within CONTRAST_TRANSFER of the source spread, and the shape of the source distribution is kept. Without this a desert
 * reference (mid tones only) flattens a terrace with deep shadows: contrast depends on content as much as on the look.
 * Color statistics (mean, covariance) stay those of the reference; buildModel bounds them itself.
 */
export function moderateTone(ref:Profile,src:Profile):Profile{
  const r=ref.quantiles,s=src.quantiles,mr=r[3],ms=s[3];
  const k=(a:number,b:number)=>clamp(Math.abs(b)>1e-4?a/b:1,CONTRAST_TRANSFER[0],CONTRAST_TRANSFER[1]);
  const lo=k(mr-r[1],ms-s[1]),hi=k(r[5]-mr,s[5]-ms);
  const q=s.map((v,i)=>clamp(mr+(v-ms)*(i<3?lo:i>3?hi:1)));
  for(let i=1;i<q.length;i++)q[i]=Math.max(q[i],q[i-1]);
  return {...ref,quantiles:q,lowInformation:ref.lowInformation&&src.lowInformation};
}
/**
 * The reference moon at the same height above the horizon, moved sideways to the nearest column where the source sky can
 * show it (the reference position may be covered by a building in the source); lowered into the frame if it would sit above it.
 */
export function placeMoon(x:number,height:number,radius:number,sky:SkyRegion,w:number,h:number){
  let hgt=height;if(sky.horizon-hgt-radius<0)hgt=Math.round((sky.horizon-2*radius)*1e3)/1e3;
  const y=sky.horizon-hgt,at=(px:number,py:number)=>{const i=Math.floor(px*w),j=Math.floor(py*w);return i>=0&&j>=0&&i<w&&j<h&&sky.mask[j*w+i]===1;};
  const fits=(cx:number)=>at(cx,y)&&at(cx-radius,y)&&at(cx+radius,y)&&at(cx,y-radius)&&at(cx,y+radius);
  if(fits(x))return {x,height:hgt};
  for(let k=1;k<=100;k++)for(const sgn of [-1,1]){const cx=Math.round((x+sgn*k*.01)*1e3)/1e3;if(cx>=radius&&cx<=1-radius&&fits(cx))return {x:cx,height:hgt};}
  return {x,height:hgt};
}

export function buildReferenceGraph(input:BuildInput):BuildResult{
  const {base,report,selected}=input,plan=report.plan,cm=structuredClone(base.colorManagement),L=cm.working.linear,on=(id:AspectId)=>selected.has(id);
  const toW=(c:RGB):RGB=>(L==='lin_rec709_srgb'?c:convertPixel(c,'lin_rec709_srgb',L)).map(v=>r4(clamp(v,0,16))) as RGB;
  const lw=lumaWeights(L),yW=(c:RGB)=>lw[0]*c[0]+lw[1]*c[1]+lw[2]*c[2];
  const user:BuckNode[]=[],masks:BuckNode[]=[],applied:string[]=[];
  const lightColor=(rgb:RGB,kelvin:number,duv:number):ColorValue=>Math.abs(duv)<=.02?{kelvin:Math.round(clamp(kelvin,1667,25000))}:toW(rgb);
  // 1. Exposure (time of day) and light color (white balance) share one CDL in the linear working space.
  const useEv=on('time')&&Math.abs(plan.exposureEV)>=.1,useWb=on('light'),gain=useEv?2**plan.exposureEV:1;
  if(useEv||useWb){
    let ratio:RGB=[1,1,1];
    if(useWb){const a=toW(plan.lightRef),b=toW(plan.lightSrc);ratio=a.map((v,i)=>v/Math.max(1e-4,b[i])) as RGB;const y=yW(ratio);ratio=ratio.map(v=>clamp(v/y,.4,2.5)) as RGB;}
    const n=defaultNode('color.cdl@1','exposure') as NodeOf<'color.cdl@1'>;
    const label=[useEv?`Belichtung ${deSigned(plan.exposureEV)} EV`:'',useWb?`Lichtfarbe ≈ ${plan.lightKelvin} K`:''].filter(Boolean).join(' · ');
    user.push({...n,label:clip(`Referenz · ${label}`,LIMITS.nameChars),params:{...n.params,slope:ratio.map(v=>r4(v*gain)) as RGB,saturation:useEv?plan.saturation:1,space:L,style:'noClampFwd'}});
    applied.push(label);
  }
  // 2. Directional light.
  if(on('direction')&&plan.direction){
    const d=plan.direction,m=defaultNode('mask.depthRange@1','refNearMask') as NodeOf<'mask.depthRange@1'>;
    masks.push({...m,label:'Referenz · Vorder- und Mittelgrund',params:{...m.params,near:0,far:.6,feather:.12}});
    const n=defaultNode('light.relight@1','relight') as NodeOf<'light.relight@1'>,intensity=r2(clamp(.3+2.5*d.strength,.2,1.2));
    user.push({...n,label:clip(`Referenz · Licht Azimut ${d.azimuth}° / Elevation ${d.elevation}°`,LIMITS.nameChars),inputs:{...n.inputs,mask:m.id},
      params:{...n.params,azimuth:d.azimuth,elevation:clamp(d.elevation,-90,90),color:lightColor(plan.lightRef,plan.lightKelvin,plan.lightDuv),intensity,softness:.6}});
    applied.push(`Licht ${d.azimuth}°/${d.elevation}°`);
  }
  // 3. Practicals (threshold follows the exposure in front of them, as in prompt.ts).
  if(on('lamps')&&plan.lamps?.color){
    const l=plan.lamps,n=defaultNode('light.practicals@1','practicals') as NodeOf<'light.practicals@1'>;
    user.push({...n,label:clip(`Referenz · Lampen ≈ ${l.kelvin} K`,LIMITS.nameChars),
      params:{...n.params,threshold:r4(Math.max(.001,.9*gain)),color:lightColor(l.color!,l.kelvin??2700,l.duv??0),intensity:l.intensity??1.5,recolor:.6}});
    applied.push(`Lampen ≈ ${l.kelvin} K`);
  }
  let sky:{preset:SkyPreset;params:SkyParams;label:string}|undefined;
  // 4. Sky with measured colors (the preset only documents the category and supplies the remaining defaults).
  if(on('sky')&&plan.sky&&plan.skyDepth!==undefined){
    const s=plan.sky,preset=plan.time.preset,p=skyPresetParams(preset,L);
    const yz=Math.max(1e-5,lumaOf(s.zenith)),yh=Math.max(1e-5,lumaOf(s.horizon)),ev=clamp(Math.log2(Math.sqrt(yz*yh)/.18),-10,10),base=.18*2**ev;
    const rel=(c:RGB)=>toW(c.map(v=>v/base) as RGB);
    p.zenith=rel(s.zenith);p.horizon=rel(s.horizon);p.exposure=r2(ev);p.glowColor=p.horizon;p.glow=r2((p.glow as number)*.3);
    if(s.gradientPower!==undefined)p.gradientPower=r2(s.gradientPower);
    p.clouds=r2(Math.min(.95,s.clouds));if(s.cloudColor&&s.clouds>.12)p.cloudColor=rel(s.cloudColor);
    p.stars=r2(s.stars);p.milkyWay=0;p.skyDepth=plan.skyDepth;
    if(s.moon){const m=placeMoon(s.moon.x,s.moon.height,clamp(s.moon.radius,.001,.2),report.src.sky,report.src.work.w,report.src.work.h);
      p.moon={x:m.x,height:m.height,radius:clamp(s.moon.radius,.001,.2),intensity:s.moon.intensity,color:{kelvin:clamp(s.moon.kelvin,1667,25000)}};}else delete p.moon;
    sky={preset,params:p,label:clip(`Referenz · Himmel ${SKY_PRESET_LABELS[preset].label} (gemessen)`,LIMITS.nameChars)};
    applied.push(`Himmel ${SKY_PRESET_LABELS[preset].label}`);
  }
  // 5. Haze.
  if(on('haze')&&plan.fog){
    const f=plan.fog,n=defaultNode('atmos.fog@1','fog') as NodeOf<'atmos.fog@1'>;
    user.push({...n,label:clip(`Referenz · Dunst Dichte ${de(f.density,2)} ab ${de(f.start,2)}`,LIMITS.nameChars),
      params:{...n.params,model:'exponential',start:f.start,density:clamp(f.density,0,20),color:toW(f.color),luminance:f.luminance,maxOpacity:f.maxOpacity,skyProtect:f.skyProtect}});
    applied.push('Dunst');
  }
  // 6. Depth of field.
  if(on('dof')&&plan.dof&&(plan.dof.blurFar>0||plan.dof.blurNear>0)){
    const d=plan.dof,n=defaultNode('lens.dof@1','dof') as NodeOf<'lens.dof@1'>;
    user.push({...n,label:clip(`Referenz · Fokus ${de(d.focus,2)}`,LIMITS.nameChars),params:{...n.params,mode:'artistic',focus:d.focus,focusRange:d.focusRange,blurNear:d.blurNear,blurFar:d.blurFar,maxBlur:d.maxBlur}});
    applied.push(`Tiefenschärfe Fokus ${de(d.focus,2)}`);
  }
  const meta={...structuredClone(base.meta),name:clip(`Referenz · ${input.fileName.trim()||'Bild'}`,LIMITS.nameChars)};
  delete meta.prompt;delete meta.thumbnails;
  const assemble=(image:BuckNode[]):BuckGraph=>{
    let prev='$source';const chain=image.map(n=>{const c={...n,inputs:{...n.inputs,image:prev}} as BuckNode;prev=n.id;return c;});
    const nodes=[...masks,...chain];
    if(!nodes.length)nodes.push({id:'auto-identity',type:'color.convert@1',label:'Durchreichen',inputs:{image:'$source'},params:{from:cm.input,to:cm.output}}),prev='auto-identity';
    return finishGraph({format:'buck',formatVersion:FORMAT_VERSION,minReaderVersion:'1.0',meta,colorManagement:cm,inputs:{},models:{},nodes,output:prev});
  };
  let graph=assemble(user);
  // The sky goes through the editor's time-of-day switch (prompt.ts applyTimeOfDay), so the switch shows the reference's time
  // of day and „Wie aufgenommen“ removes it again. Its sky gets the measured values; of its coupled nodes only the preset grade
  // (tod-grade) stays: exposure, light, lamps and haze come from the measurement (or were deliberately left unchecked), and
  // the switch's adaptations of our own nodes (fog luminance, lamp threshold) are undone. The residual LUT then compensates
  // the grade like any other node in front of it.
  if(sky){
    const own=new Map(graph.nodes.map(n=>[n.id,n])),measured=sky;
    const tod=applyTimeOfDay(graph,measured.preset).graph;
    graph=finishGraph({...tod,nodes:tod.nodes.flatMap(n=>{
      // Own nodes: our params/label again (no switch record), but the new wiring of the rebuilt chain.
      if(!isTimeOfDayNode(n)){const o=own.get(n.id);return [o?{...o,inputs:n.inputs} as BuckNode:n];}
      if(n.id===`${TOD_PREFIX}sky`&&n.type==='sky.replace@1')return [{...n,label:measured.label,params:measured.params} as BuckNode];
      return n.id===`${TOD_PREFIX}grade`?[n]:[];
    })});
  }
  const files=new Map<string,Uint8Array>();
  // 7. Color: LUT from the reference against the source rendered through everything above.
  if(on('color')){
    const display=cm.working.display,{w,h}=workSize(input.source.width,input.source.height);
    if(w!==report.src.work.w||h!==report.src.work.h)throw new Error('Analyse und Ausgangsbild passen nicht zusammen – bitte neu analysieren.');
    const small=downImage(input.source,w,h),depth=input.sourceDepth?scalarField(w,h,downDepth(input.sourceDepth,w,h)):undefined;
    const r=renderGraph(graph,small,{frame:0,aux:{...(depth?{depth}:{}),masks:{}},files:new Map()});
    if(r.output.kind!=='image')throw new Error('Die Vorschau der Referenzkette lieferte kein Bild.');
    const pre=convertImage(r.output,display).data,weights=colorWeights(report.src),px=new Float32Array(w*h*4);
    for(let i=0;i<w*h;i++){for(let c=0;c<3;c++)px[i*4+c]=clamp(pre[i*4+c]);px[i*4+3]=hash01(i,2)<Math.max(.15,weights[i])?1:0;}
    const id=displaySpaceId(display),settings={...DEFAULT_SETTINGS,input:id,output:id,size:LUT_SIZE as 64,strength:1,mode:'reference' as const};
    const srcProfile=analyze(px,id),model=buildModel(moderateTone(analyze(weightedPixels(report.ref.work,colorWeights(report.ref),display),id),srcProfile),srcProfile,settings);
    const text=serializeBuckCube(makeCube(model),LUT_SIZE,`${meta.name} · Referenz-LUT`,display as SpaceName,display as SpaceName);
    files.set(REFERENCE_LUT,new TextEncoder().encode(text));
    const n=defaultNode('color.lut3d@1','refLut') as NodeOf<'color.lut3d@1'>;
    graph=insertByLevel(graph,{...n,label:'Referenz · Farbabgleich (64³-LUT)',inputs:{image:'$source'},params:{file:REFERENCE_LUT,inputSpace:display,outputSpace:display}},{edge:'end'});
    applied.push('Farbabgleich 64³-LUT');
  }
  return {graph,files,applied};
}
