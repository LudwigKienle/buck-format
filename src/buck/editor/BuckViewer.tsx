import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Columns2 } from 'lucide-react';
import { normalsFromDepth } from '../aux/normals';
import { toSRGB8 } from '../colorspace';
import type { BuckGraph, ImageBuf, ScalarField, VectorField } from '../types';
import { resampleDepth } from './AuxPanel';
import { maskNodes } from './chain';
import type { EditorState, RenderResult, ViewMode } from './types';
/**
 * Preview of the .buck editor. Result and mask come from the render worker (result.preview); original, depth and normals
 * are drawn here from the editor state. Depth: bright = near, dark = far (same reading as Resolve's Depth Map and
 * Depth Anything's grayscale output); invalid/sky (+Infinity) is dark magenta. Normals: RGB = n·0.5 + 0.5.
 */
type Props={state:EditorState;result?:RenderResult;busy:boolean;onView:(v:ViewMode)=>void};
interface Pixels {data:Uint8ClampedArray;width:number;height:number;}
export const INVALID_RGB=[96,0,96] as const;
/** Normals preview from depth is computed at most at this long side (main thread); an assumption for responsiveness only. */
export const NORMALS_PREVIEW_SIDE=1024;
/** Smoothing of spec §13 / the fixture, used when the graph declares no normals-from-depth source. */
export const DEFAULT_NORMALS_SMOOTHING=.002;

const to8=(v:number)=>v>0?(v<1?Math.round(v*255):255):0;
/** Depth as gray, 255 = near. Values outside 0…1 (e.g. metric depth) are stretched to the finite min…max for display. */
export function depthPreview(f:ScalarField):Pixels&{stretched:boolean} {
  const src=f.data,out=new Uint8ClampedArray(src.length*4);
  let lo=Infinity,hi=-Infinity;for(let i=0;i<src.length;i++){const v=src[i];if(Number.isFinite(v)){if(v<lo)lo=v;if(v>hi)hi=v;}}
  const stretched=lo<0||hi>1,k=stretched&&hi>lo?1/(hi-lo):1,off=stretched?lo:0;
  for(let p=0;p<src.length;p++){
    const v=src[p],i=p*4;
    if(!Number.isFinite(v)){out[i]=INVALID_RGB[0];out[i+1]=INVALID_RGB[1];out[i+2]=INVALID_RGB[2];}
    else out[i]=out[i+1]=out[i+2]=to8(1-(v-off)*k);
    out[i+3]=255;
  }
  return {data:out,width:f.width,height:f.height,stretched};
}
/** Camera-space normals (+X right, +Y up, +Z toward the camera) as RGB = n·0.5 + 0.5; (0,0,0) or non-finite = invalid. */
export function normalsPreview(f:VectorField):Pixels {
  const src=f.data,n=f.width*f.height,out=new Uint8ClampedArray(n*4);
  for(let p=0;p<n;p++){
    const x=src[p*3],y=src[p*3+1],z=src[p*3+2],i=p*4;
    if(!(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z))||x===0&&y===0&&z===0){out[i]=INVALID_RGB[0];out[i+1]=INVALID_RGB[1];out[i+2]=INVALID_RGB[2];}
    else{out[i]=to8(x*.5+.5);out[i+1]=to8(y*.5+.5);out[i+2]=to8(z*.5+.5);}
    out[i+3]=255;
  }
  return {data:out,width:f.width,height:f.height};
}
/** Smoothing of the first normals-from-depth source in the graph, else the fixture value. */
export function normalsSmoothing(graph:BuckGraph):number {
  for(const d of Object.values(graph.inputs))if(d.kind==='normals')for(const s of d.sources)if(s.type==='derive'&&s.method==='normals-from-depth@1')return s.params.smoothing;
  return DEFAULT_NORMALS_SMOOTHING;
}
/** Normals for display: the aux channel if present, otherwise derived from (a downscaled copy of) the depth. */
export function viewerNormals(aux:EditorState['aux']['channels'],smoothing:number):{field:VectorField;derived:boolean}|undefined {
  if(aux.normals)return {field:aux.normals,derived:false};
  const d=aux.depth;if(!d)return undefined;
  const s=Math.min(1,NORMALS_PREVIEW_SIDE/Math.max(d.width,d.height)),w=Math.max(1,Math.round(d.width*s)),h=Math.max(1,Math.round(d.height*s));
  return {field:normalsFromDepth(s<1?resampleDepth(d,w,h):d,smoothing),derived:true};
}
export const isMaskSelected=(graph:BuckGraph,selected?:string)=>!!selected&&maskNodes(graph).some(n=>n.id===selected);

// Display caches keyed by the (immutable) buffers, so switching views does not recompute.
const originals=new WeakMap<ImageBuf,Pixels>(),depths=new WeakMap<ScalarField,ReturnType<typeof depthPreview>>(),normals=new WeakMap<object,Map<number,Pixels&{derived:boolean}>>();
function cached<K extends object,V>(map:WeakMap<K,V>,key:K,make:()=>V){let v=map.get(key);if(!v){v=make();map.set(key,v);}return v;}
const originalOf=(img:ImageBuf)=>cached(originals,img,()=>({data:toSRGB8(img),width:img.width,height:img.height}));
function normalsOf(aux:EditorState['aux']['channels'],smoothing:number){
  const key=aux.normals??aux.depth;if(!key)return undefined;
  const byS=cached(normals,key,()=>new Map<number,Pixels&{derived:boolean}>());
  let v=byS.get(smoothing);
  if(!v){const n=viewerNormals(aux,smoothing);if(!n)return undefined;v={...normalsPreview(n.field),derived:n.derived};byS.set(smoothing,v);}
  return v;
}

function paint(canvas:HTMLCanvasElement|null,px?:Pixels){
  if(!canvas||!px||px.data.length!==px.width*px.height*4)return;
  canvas.width=px.width;canvas.height=px.height;
  canvas.getContext('2d')?.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>,px.width,px.height),0,0);
}
function Canvas({px,label,style}:{px?:Pixels;label:string;style?:CSSProperties}){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>paint(ref.current,px),[px]);
  return <canvas ref={ref} className="buck-canvas" role="img" aria-label={label} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain',...style}}/>;
}

const VIEWS:[ViewMode,string][]=[['result','Ergebnis'],['original','Original'],['split','Vergleich'],['depth','Tiefe'],['normals','Normalen'],['mask','Maske']];
const LEGEND='hell = nah · dunkel = fern · Magenta = ungültig/Himmel';

export function BuckViewer({state,result,busy,onView}:Props){
  const {graph,source,aux,view,selected}=state,ch=aux.channels,maskOk=isMaskSelected(graph,selected);
  const [split,setSplit]=useState(50),[splitFocus,setSplitFocus]=useState(false);
  useEffect(()=>{if(view==='mask'&&!maskOk)onView('result');},[view,maskOk,onView]);

  const enabled=(v:ViewMode)=>v==='depth'?!!ch.depth:v==='normals'?!!(ch.normals||ch.depth):v==='mask'?maskOk:!!source;
  const resultPx:Pixels|undefined=result&&{data:result.preview,width:result.width,height:result.height};
  const original=source&&(view==='original'||view==='split')?originalOf(source.image):undefined;
  const depth=view==='depth'&&ch.depth?cached(depths,ch.depth,()=>depthPreview(ch.depth!)):undefined;
  const nrm=view==='normals'?normalsOf(ch,normalsSmoothing(graph)):undefined;
  const maskName=maskOk?graph.nodes.find(n=>n.id===selected)?.label??selected:undefined;

  let main:Pixels|undefined,label='',empty='',info='';
  switch(view){
    case 'original':main=original;label='Ausgangsbild in sRGB';empty='Bitte ein Ausgangsbild laden.';break;
    case 'depth':main=depth;label='Tiefenkarte als Graustufen';empty='Keine Tiefe vorhanden. Im Bereich Hilfskanäle eine Tiefe schätzen oder laden.';info=depth?`${LEGEND}${depth.stretched?' · Anzeige auf Wertebereich gestreckt':''}`:'';break;
    case 'normals':main=nrm;label='Normalen als Farbbild';empty='Keine Normalen und keine Tiefe vorhanden.';info=nrm?`RGB = Normale · 0,5 + 0,5 (Rot = rechts, Grün = oben, Blau = zur Kamera)${nrm.derived?' · Vorschau, aus der Tiefe abgeleitet':''}`:'';break;
    case 'mask':main=resultPx;label=`Maske ${maskName??''}`;empty=source?'Maske wird berechnet …':'Bitte ein Ausgangsbild laden.';info=maskName?`Maske „${maskName}“: weiß = volle Wirkung`:'';break;
    default:main=resultPx;label='Ergebnis des Graphen';empty=source?'Ergebnis wird berechnet …':'Bitte ein Ausgangsbild laden.';
  }
  const showSplit=view==='split'&&!!original;
  const frame=showSplit?original:main??(source?{width:source.image.width,height:source.image.height}:undefined);
  const dims=frame?`${frame.width} × ${frame.height} px`:'';
  const timing=result&&(view==='result'||view==='split'||view==='mask')?` · Renderzeit ${Math.round(result.ms).toLocaleString('de-DE')} ms`:'';

  return <section className="buck-viewer" aria-label="Vorschau">
    <div className="buck-row buck-viewer-toolbar">
      <div className="buck-segmented segmented" role="group" aria-label="Ansicht">
        {VIEWS.filter(([v])=>v!=='mask'||maskOk).map(([v,text])=><button key={v} type="button" aria-pressed={view===v} disabled={!enabled(v)&&view!==v} onClick={()=>onView(v)}>{text}</button>)}
      </div>
    </div>
    <div className="buck-viewer-stage" style={{position:'relative',width:'100%',aspectRatio:frame?`${frame.width}/${frame.height}`:'16/9',background:'#0b0c0d',overflow:'hidden'}}>
      {showSplit?<>
        <Canvas px={original} label="Original (links)"/>
        {resultPx&&<Canvas px={resultPx} label="Ergebnis (rechts)" style={{clipPath:`inset(0 0 0 ${split}%)`}}/>}
        <div className="buck-split-line" aria-hidden="true" style={{position:'absolute',top:0,bottom:0,left:`${split}%`,width:2,marginLeft:-1,background:'#fff',boxShadow:splitFocus?'0 0 0 2px var(--accent, #d9f27a)':undefined,pointerEvents:'none'}}>
          <span style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',display:'grid',placeItems:'center',width:28,height:28,borderRadius:14,background:'#fff',color:'#111'}}><Columns2 size={16}/></span>
        </div>
        <input type="range" min={0} max={100} step={1} value={split} aria-label="Vergleichstrenner: links Original, rechts Ergebnis" aria-valuetext={`${split} % Original`}
          onChange={e=>setSplit(Number(e.target.value))} onFocus={()=>setSplitFocus(true)} onBlur={()=>setSplitFocus(false)}
          style={{position:'absolute',inset:0,width:'100%',height:'100%',margin:0,opacity:0,cursor:'ew-resize'}}/>
        <span className="buck-image-label image-label left">Original</span>
        <span className="buck-image-label image-label right">{resultPx?'Ergebnis':'Ergebnis wird berechnet …'}</span>
      </>:main?<Canvas px={main} label={label}/>:<p className="buck-viewer-empty" style={{position:'absolute',inset:0,display:'grid',placeItems:'center',margin:0,padding:16,textAlign:'center'}}>{empty}</p>}
      <div className="buck-overlay" role="status" aria-live="polite" style={busy?{position:'absolute',top:8,right:8,padding:'4px 10px',borderRadius:4,background:'rgba(0,0,0,.65)',color:'#fff'}:{position:'absolute',width:1,height:1,overflow:'hidden',clip:'rect(0 0 0 0)'}}>{busy?'Wird berechnet …':''}</div>
    </div>
    <p className="buck-viewer-info buck-note" style={{display:'block'}}>{dims}{timing}{info&&<><br/>{info}</>}</p>
  </section>;
}
