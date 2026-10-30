import { Unzlib } from 'fflate';
import { BuckError, LIMITS } from './types';
/**
 * PNG gate in front of fast-png, which inflates IDAT and iCCP without any output limit. Walks the chunk list (PNG 3 §5.3),
 * checks IHDR (§11.2.1) against LIMITS.imageSide, inflates the IDAT stream in small pieces and aborts as soon as it exceeds the
 * exact size of the filtered scanlines (§7.3 one filter byte per scanline, §8.1 Adam7, §9.1 empty passes carry no bytes).
 * Returns a copy with only IHDR, PLTE, tRNS, IDAT and IEND: masks and depth maps are data (spec §11.4), so iCCP, zTXt, APNG
 * frames etc. never reach the decoder. Chunks are copied with their CRC, so fast-png's checkCrc still covers them.
 */
const CHANNELS:Record<number,number>={0:1,2:3,3:1,4:2,6:4};
const DEPTHS:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
// Adam7 as [x0, y0, dx, dy] per pass.
const ADAM7=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
const KEEP=new Set(['IHDR','PLTE','tRNS','IDAT','IEND']);
const SIGNATURE=[137,80,78,71,13,10,26,10];
// fflate inflates one push completely into one buffer (0.8.3 Inflate.prototype.c), and deflate expands at most ~1032:1,
// so 4 KiB pieces keep every intermediate buffer below ~4.2 MB.
const PIECE=4096;

/** Bytes of the decompressed, filtered image data (§7.3, §8.1, §9.1). */
export function pngDataBytes(width:number,height:number,bitsPerPixel:number,interlaced:boolean):number {
  const rows=(w:number,h:number)=>w>0&&h>0?h*(1+Math.ceil(w*bitsPerPixel/8)):0;
  if(!interlaced)return rows(width,height);
  let sum=0;for(const [x0,y0,dx,dy] of ADAM7)sum+=rows(Math.ceil((width-x0)/dx),Math.ceil((height-y0)/dy));
  return sum;
}
export const hasPngMagic=(b:Uint8Array)=>b.length>=8&&SIGNATURE.every((v,i)=>b[i]===v);

/** Checks size and decompressed volume before any full decode; `what` names the file in German errors. */
export function sanitizePng(bytes:Uint8Array,what:string):{png:Uint8Array;width:number;height:number} {
  const fail=(m:string):never=>{throw new BuckError(`${what}: ${m}`);};
  if(!hasPngMagic(bytes))fail('kein PNG.');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),kept:Uint8Array[]=[bytes.subarray(0,8)];
  let p=8,width=0,height=0,expected=-1,inflated=0,ended=false,idatDone=false,seenIdat=false;
  const inflater=new Unzlib(chunk=>{inflated+=chunk.length;if(inflated>expected)fail('Die Bilddaten sind entpackt größer, als der Bildkopf erlaubt (Dekompressionsbombe?).');});
  const push=(data:Uint8Array,final:boolean)=>{
    try{for(let o=0;o<data.length;o+=PIECE)inflater.push(data.subarray(o,Math.min(data.length,o+PIECE)),false);if(final)inflater.push(new Uint8Array(0),true);}
    catch(e){if(e instanceof BuckError)throw e;fail('Die Bilddaten sind nicht lesbar komprimiert.');}
  };
  while(!ended){
    if(p+12>bytes.length)fail('Die Datei endet vor dem IEND-Chunk.');
    const len=v.getUint32(p),type=String.fromCharCode(...bytes.subarray(p+4,p+8)),end=p+12+len;
    if(len>0x7fffffff||end>bytes.length)fail(`Chunk „${type}“ reicht über das Dateiende.`);
    if(!/^[A-Za-z]{4}$/.test(type))fail('Ungültiger Chunk-Typ.');
    if(p===8&&(type!=='IHDR'||len!==13))fail('Der erste Chunk muss IHDR sein.');
    if(type==='IHDR'){
      if(p!==8)fail('IHDR kommt mehrfach vor.');
      width=v.getUint32(p+8);height=v.getUint32(p+12);
      const depth=bytes[p+16],color=bytes[p+17],interlace=bytes[p+20];
      if(!(width>=1&&height>=1&&width<=LIMITS.imageSide&&height<=LIMITS.imageSide))fail(`Das Bild ist ${width}×${height} Pixel groß, erlaubt sind höchstens ${LIMITS.imageSide}×${LIMITS.imageSide}.`);
      if(!DEPTHS[color]?.includes(depth)||bytes[p+18]!==0||bytes[p+19]!==0||interlace>1)fail('Ungültiger Bildkopf (Farbtyp, Bittiefe, Kompression oder Interlacing).');
      expected=pngDataBytes(width,height,CHANNELS[color]*depth,interlace===1);
    }
    if(type==='IDAT'){
      if(idatDone)fail('Die IDAT-Chunks folgen nicht direkt aufeinander.');
      seenIdat=true;push(bytes.subarray(p+8,p+8+len),false);
    }else if(seenIdat)idatDone=true;
    if(type==='IEND')ended=true;
    if(KEEP.has(type))kept.push(bytes.subarray(p,end));
    else if(type.charCodeAt(0)<97)fail(`Unbekannter kritischer Chunk „${type}“.`);
    p=end;
  }
  if(!seenIdat)fail('Die Datei enthält keine Bilddaten (IDAT).');
  push(new Uint8Array(0),true);
  if(inflated!==expected)fail('Die Bilddaten sind kleiner, als der Bildkopf angibt.');
  const out=new Uint8Array(kept.reduce((s,c)=>s+c.length,0));let o=0;for(const c of kept){out.set(c,o);o+=c.length;}
  return {png:out,width,height};
}
