import { applyLook } from '../../color/look';
import { sampleCube } from '../../color/interpolation';
import { convertImage } from '../colorspace';
import { LUMA, imageBuf } from '../field';
import { BuckError } from '../types';
import type { Buf, ImageBuf, NodeImpl, RGB, SpaceName } from '../types';
/** Spec §5.2.1: color.look@1 is the display-referred formula of src/color/look.ts. */
export const LOOK_SPACE:SpaceName='Rec.1886 Rec.709 - Display';

function imageInput(inputs:Record<string,Buf|undefined>,node:string):ImageBuf {
  const img=inputs.image;
  if(!img||img.kind!=='image')throw new BuckError(`${node}: Eingang „image“ fehlt oder ist kein Bild.`);
  if(img.data.length!==img.width*img.height*4)throw new BuckError(`${node}: Bildpuffer hat nicht die erwartete Größe.`);
  return img;
}
function requireSpace(img:ImageBuf,space:SpaceName,node:string){
  if(img.space!==space)throw new BuckError(`${node}: Eingang liegt in „${img.space}“, erwartet wird „${space}“. Bitte davor einen color.convert@1-Knoten setzen.`);
}
/** Per-pixel RGB map into a new buffer; alpha is copied unchanged. */
function mapPixels(img:ImageBuf,space:SpaceName,fn:(rgb:RGB)=>RGB):ImageBuf {
  const src=img.data,out=new Float32Array(src.length);
  for(let i=0;i<src.length;i+=4){const c=fn([src[i],src[i+1],src[i+2]]);out[i]=c[0];out[i+1]=c[1];out[i+2]=c[2];out[i+3]=src[i+3];}
  return imageBuf(img.width,img.height,space,out);
}
function convertKeepAlpha(img:ImageBuf,to:SpaceName):ImageBuf {
  if(img.space===to)return imageBuf(img.width,img.height,to,new Float32Array(img.data));
  const out=convertImage(img,to);
  if(out.width!==img.width||out.height!==img.height||out.data.length!==img.data.length||out.space!==to)throw new BuckError(`Farbraumkonvertierung nach „${to}“ lieferte einen ungültigen Puffer.`);
  const data=out.data===img.data?new Float32Array(out.data):out.data;
  for(let i=3;i<data.length;i+=4)data[i]=img.data[i];
  return {kind:'image',width:img.width,height:img.height,data,space:to};
}

export const convertNode:NodeImpl<'color.convert@1'>={type:'color.convert@1',evaluate(inputs,params){
  const img=imageInput(inputs,'color.convert@1');requireSpace(img,params.from,'color.convert@1');
  return convertKeepAlpha(img,params.to);
}};

export const lookNode:NodeImpl<'color.look@1'>={type:'color.look@1',evaluate(inputs,params,ctx){
  const img=imageInput(inputs,'color.look@1');requireSpace(img,params.space,'color.look@1');
  const look=params.look,skin=params.skinProtection,apply=(rgb:RGB)=>applyLook(rgb,look,skin);
  if(params.space===LOOK_SPACE)return mapPixels(img,LOOK_SPACE,apply);
  ctx.warn(`color.look@1 ist für „${LOOK_SPACE}“ definiert; der Eingang in „${params.space}“ wird dafür hin- und zurückkonvertiert.`);
  return convertKeepAlpha(mapPixels(convertKeepAlpha(img,LOOK_SPACE),LOOK_SPACE,apply),params.space);
}};

/** NaN maps to 0, as in OpenColorIO's CDL clamp. */
const clampCdl=(x:number)=>x>0?(x<1?x:1):0;
/**
 * ASC CDL v1.2 forward, matching OpenColorIO CDLOpCPU: SOP per channel, then saturation with Rec.709 luma.
 * 'v1.2_Fwd' clamps to [0,1] before the power and after saturation; 'noClampFwd' passes negatives through
 * the power unchanged and never clamps. NaN after slope/offset becomes 0 in both styles.
 */
export function cdl(rgb:RGB,slope:RGB,offset:RGB,power:RGB,saturation:number,style:'v1.2_Fwd'|'noClampFwd'):RGB {
  const clampIt=style==='v1.2_Fwd',v=[0,0,0] as RGB,[wr,wg,wb]=LUMA.rec709;
  for(let i=0;i<3;i++){
    const x=rgb[i]*slope[i]+offset[i];
    v[i]=clampIt?clampCdl(x)**power[i]:Number.isNaN(x)?0:x<0?x:x**power[i];
  }
  const y=wr*v[0]+wg*v[1]+wb*v[2];
  for(let i=0;i<3;i++){const s=y+saturation*(v[i]-y);v[i]=clampIt?clampCdl(s):s;}
  return v;
}
export const cdlNode:NodeImpl<'color.cdl@1'>={type:'color.cdl@1',evaluate(inputs,params){
  const img=imageInput(inputs,'color.cdl@1');requireSpace(img,params.space,'color.cdl@1');
  const {slope,offset,power,saturation,style}=params;
  if(style!=='v1.2_Fwd'&&style!=='noClampFwd')throw new BuckError(`color.cdl@1: unbekannter Stil „${String(style)}“.`);
  return mapPixels(img,params.space,rgb=>cdl(rgb,slope,offset,power,saturation,style));
}};

export interface ParsedCube {size:number;data:Float32Array;title?:string;domainMin:RGB;domainMax:RGB;}
/** Limits as in native/ofx (Cube.cpp): 64 KiB line, size 2–256, exact row count, finite values. */
const MAX_LINE=65536,NUMBER=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/,INTEGER=/^[+-]?\d+$/;
const trimWs=(s:string)=>s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g,'');
function readRGB(tokens:string[],lineNo:number):RGB {
  if(tokens.length!==3||!tokens.every(t=>NUMBER.test(t)))throw new BuckError(`Cube: ungültige RGB-Werte in Zeile ${lineNo}.`);
  const v=tokens.map(Number) as RGB;
  if(!v.every(Number.isFinite))throw new BuckError(`Cube: nicht endliche Werte in Zeile ${lineNo}.`);
  return v;
}
/**
 * Pure 3D Iridas/BMD (Adobe Cube 1.0) parser with the strictness of native/ofx Cube::parse. Red changes fastest,
 * so `data` is laid out exactly as sampleCube expects. 1D and shaper+3D files are refused.
 */
export function parseCube(text:string):ParsedCube {
  const lines=text.split('\n');
  let size=0,expected=0,rows=0,data=new Float32Array(0),title:string|undefined,domainMin:RGB=[0,0,0],domainMax:RGB=[1,1,1];
  let minSeen=false,maxSeen=false,rangeSeen=false;
  for(let n=0;n<lines.length;n++){
    let line=lines[n];const lineNo=n+1;
    if(line.length>MAX_LINE)throw new BuckError(`Cube: Zeile ${lineNo} ist länger als 64 KiB.`);
    if(n===0&&line.charCodeAt(0)===0xfeff)line=line.slice(1);
    // '#' inside a quoted title is literal; outside a quote it starts a comment.
    let quoted=false;
    for(let i=0;i<line.length;i++){if(line[i]==='"')quoted=!quoted;else if(line[i]==='#'&&!quoted){line=line.slice(0,i);break;}}
    line=trimWs(line);if(!line)continue;
    const tokens=line.split(/[ \t\v\f\r]+/),key=tokens[0];
    if(key==='TITLE'){
      const t=trimWs(line.slice(5));
      if(t.length<2||t[0]!=='"'||t[t.length-1]!=='"')throw new BuckError(`Cube: TITLE muss in Anführungszeichen stehen (Zeile ${lineNo}).`);
      title=t.slice(1,-1);continue;
    }
    if(key==='LUT_3D_SIZE'){
      const v=tokens.length===2&&INTEGER.test(tokens[1])?Number(tokens[1]):NaN;
      if(size||rows||!(v>=2&&v<=256))throw new BuckError('Cube: LUT_3D_SIZE muss genau einmal vor den Daten stehen und eine ganze Zahl von 2 bis 256 sein.');
      size=v;expected=v*v*v;data=new Float32Array(expected*3);continue;
    }
    if(key==='DOMAIN_MIN'||key==='DOMAIN_MAX'){
      const isMin=key==='DOMAIN_MIN';
      if((isMin?minSeen:maxSeen)||rangeSeen||rows)throw new BuckError(`Cube: doppelte oder zu späte Domain-Angabe (Zeile ${lineNo}).`);
      const v=readRGB(tokens.slice(1),lineNo);
      if(isMin){domainMin=v;minSeen=true;}else{domainMax=v;maxSeen=true;}
      continue;
    }
    if(key==='LUT_3D_INPUT_RANGE'){
      const ok=tokens.length===3&&NUMBER.test(tokens[1])&&NUMBER.test(tokens[2]),lo=Number(tokens[1]),hi=Number(tokens[2]);
      if(rangeSeen||minSeen||maxSeen||rows||!ok||!Number.isFinite(lo)||!Number.isFinite(hi)||!(hi>lo))throw new BuckError(`Cube: ungültiges oder doppeltes LUT_3D_INPUT_RANGE (Zeile ${lineNo}).`);
      rangeSeen=true;domainMin=[lo,lo,lo];domainMax=[hi,hi,hi];continue;
    }
    if(key==='LUT_1D_SIZE'||key==='LUT_1D_INPUT_RANGE')throw new BuckError('Cube: 1D- und Shaper+3D-LUTs werden nicht unterstützt; bitte eine reine 3D-.cube verwenden.');
    if(!size)throw new BuckError(`Cube: LUT_3D_SIZE fehlt vor den Daten (Zeile ${lineNo}).`);
    if(rows>=expected)throw new BuckError('Cube: mehr RGB-Zeilen als LUT_3D_SIZE³.');
    const v=readRGB(tokens,lineNo);
    data[rows*3]=v[0];data[rows*3+1]=v[1];data[rows*3+2]=v[2];rows++;
  }
  if(!size||rows!==expected)throw new BuckError(`Cube: es müssen genau LUT_3D_SIZE³ RGB-Zeilen vorhanden sein (gefunden ${rows}, erwartet ${expected}).`);
  for(let i=0;i<3;i++)if(!(domainMax[i]>domainMin[i]))throw new BuckError('Cube: die Domain muss in jedem Kanal einen positiven Bereich haben.');
  return title===undefined?{size,data,domainMin,domainMax}:{size,data,title,domainMin,domainMax};
}
/** Domain-normalized tetrahedral sample like native Cube::sample: out-of-domain clamps, NaN maps to the low edge, output unclamped. */
export function sampleParsedCube(cube:ParsedCube,rgb:RGB):RGB {
  const n=[0,0,0] as RGB;
  for(let i=0;i<3;i++){const t=(rgb[i]-cube.domainMin[i])/(cube.domainMax[i]-cube.domainMin[i]);n[i]=Number.isNaN(t)?0:t;}
  return sampleCube(cube.data,cube.size,n);
}
const cubeCache=new WeakMap<Uint8Array,ParsedCube|BuckError>();
/** Parsed cubes are cached per bytes object; a parse failure is cached as well so it is not repeated every frame. */
export function cubeFromBytes(bytes:Uint8Array):ParsedCube {
  let hit=cubeCache.get(bytes);
  if(!hit){
    try{hit=parseCube(new TextDecoder('utf-8').decode(bytes));}
    catch(e){hit=e instanceof BuckError?e:new BuckError(`Cube: ${e instanceof Error?e.message:String(e)}`);}
    cubeCache.set(bytes,hit);
  }
  if(hit instanceof BuckError)throw hit;
  return hit;
}
export const lut3dNode:NodeImpl<'color.lut3d@1'>={type:'color.lut3d@1',evaluate(inputs,params,ctx){
  const img=imageInput(inputs,'color.lut3d@1');requireSpace(img,params.inputSpace,'color.lut3d@1');
  const bytes=ctx.files.get(params.file);
  if(!bytes)throw new BuckError(`color.lut3d@1: LUT-Datei „${params.file}“ fehlt im Paket.`);
  const cube=cubeFromBytes(bytes);
  return mapPixels(img,params.outputSpace,rgb=>sampleParsedCube(cube,rgb));
}};
