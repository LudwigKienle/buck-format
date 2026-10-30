import type { Profile } from './color/analysis';
import { analyze } from './color/analysis';
import { clamp, convert, gamutMap } from './color/spaces';
import type { RGB, SpaceId } from './color/spaces';
import { decode as decodePng } from 'fast-png';
import { inspectPngEncoding } from './color/png-metadata';
export interface ImageAsset {name:string;url:string;width:number;height:number;pixels:Uint8ClampedArray;floatPixels?:Float32Array;profile:Profile;encoding:SpaceId;originalWidth:number;originalHeight:number;precision:string;}
export async function readImage(file:File):Promise<ImageAsset>{
  if(file.size>50*1024*1024)throw new Error('Bitte ein Bild unter 50 MB verwenden.');
  if(!/^image\/(png|jpeg|webp)$/.test(file.type))throw new Error('Unterstützt werden PNG, JPG und WebP.');
  const url=URL.createObjectURL(file);
  try{
    if(file.type==='image/png'){
      const buffer=await file.arrayBuffer(),header=new DataView(buffer);
      if(buffer.byteLength>29&&header.getUint8(24)===16){
        if(header.getUint32(16)*header.getUint32(20)>16000000)throw new Error('16-Bit-PNG: Bitte auf maximal 16 Megapixel verkleinern.');
        const png=decodePng(buffer,{checkCrc:true}),metadata=inspectPngEncoding(buffer);
        // An embedded profile must be interpreted by the browser; raw16 fallback never discards ICC silently.
        if(!png.iccEmbeddedProfile&&metadata.raw&&[1,2,3,4].includes(png.channels)){
          const asset=await loadAsset(url,file.name),floats=new Float32Array(asset.width*asset.height*4);
          for(let y=0;y<asset.height;y++)for(let x=0;x<asset.width;x++){
            const source=(Math.min(png.height-1,Math.floor((y+.5)*png.height/asset.height))*png.width+Math.min(png.width-1,Math.floor((x+.5)*png.width/asset.width)))*png.channels,target=(y*asset.width+x)*4;
            for(let k=0;k<3;k++)floats[target+k]=png.data[source+(png.channels<=2?0:k)]/65535;
            floats[target+3]=png.channels===2||png.channels===4?png.data[source+png.channels-1]/65535:1;
          }
          return{...asset,floatPixels:floats,profile:analyze(floats,metadata.encoding),encoding:metadata.encoding,precision:metadata.label};
        }
        const asset=await loadAsset(url,file.name);return{...asset,precision:metadata.label};
      }
    }
    return await loadAsset(url,file.name);
  }catch(error){URL.revokeObjectURL(url);throw error;}
}
export async function loadAsset(url:string,name:string):Promise<ImageAsset>{
  const img=new Image();img.src=url;await img.decode();
  if(img.naturalWidth*img.naturalHeight>100000000)throw new Error('Das Bild ist zu groß. Bitte auf maximal 100 Megapixel verkleinern.');
  const scale=Math.min(1,1100/Math.max(img.naturalWidth,img.naturalHeight)),width=Math.max(1,Math.round(img.naturalWidth*scale)),height=Math.max(1,Math.round(img.naturalHeight*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'})!;
  ctx.drawImage(img,0,0,width,height);const pixels=ctx.getImageData(0,0,width,height).data;
  return{name,url,width,height,pixels,profile:analyze(pixels),encoding:'srgb',originalWidth:img.naturalWidth,originalHeight:img.naturalHeight,precision:'sRGB / ICC · 8 Bit'};
}
export function reinterpret(asset:ImageAsset,encoding:SpaceId):ImageAsset{return{...asset,encoding,profile:analyze(asset.floatPixels||asset.pixels,encoding)};}
export function originalDisplay(asset:ImageAsset):Uint8ClampedArray {
  if(asset.encoding==='srgb'&&!asset.floatPixels)return asset.pixels;
  const pixels=new Uint8ClampedArray(asset.pixels);
  const raw=asset.floatPixels||asset.pixels,scale=asset.floatPixels?1:255;
  for(let i=0;i<pixels.length;i+=4){const c=gamutMap(convert([raw[i]/scale,raw[i+1]/scale,raw[i+2]/scale],asset.encoding,'srgb'),'srgb');for(let k=0;k<3;k++)pixels[i+k]=Math.round(clamp(c[k])*255);pixels[i+3]=Math.round(raw[i+3]/scale*255);}
  return pixels;
}
/** Deterministic demo target. The downloaded cube is fitted from these actual image statistics. */
export async function demoReference(source:ImageAsset):Promise<ImageAsset>{
  const pixels=new Uint8ClampedArray(source.pixels);
  for(let i=0;i<pixels.length;i+=4){let c=convert([pixels[i]/255,pixels[i+1]/255,pixels[i+2]/255],'srgb','rec709');const y=.2126*c[0]+.7152*c[1]+.0722*c[2];c=c.map((v,k)=>.035+.93*(clamp(v)**1.08)+[.024,0,-.018][k]*(.3+.7*y)) as RGB;c=gamutMap(convert(c,'rec709','srgb'),'srgb');for(let k=0;k<3;k++)pixels[i+k]=Math.round(clamp(c[k])*255);}
  const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
  canvas.getContext('2d')!.putImageData(new ImageData(pixels,source.width,source.height),0,0);
  return{...source,name:'Villa · warmer Referenzlook',url:canvas.toDataURL('image/png'),pixels,profile:analyze(pixels)};
}
export function download(content:BlobPart,name:string,type:string){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
export function safeName(name:string){return name.replace(/[^a-zA-Z0-9äöüÄÖÜß._-]+/g,'_').replace(/^\.+/,'').slice(0,100)||'Buckswood_Look';}
