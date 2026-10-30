import { scalarField, vectorField } from '../field';
import { BuckError } from '../types';
import type { ScalarField, VectorField } from '../types';
/**
 * Minimal OpenEXR 2 writer/reader for the aux cache (spec §6.4): single-part scanline, NO_COMPRESSION, HALF or FLOAT
 * channels, one scanline per chunk. Layout per "OpenEXR File Layout" (openexr.com/en/latest/OpenEXRFileLayout.html):
 * magic, version, attributes (name\0 type\0 int size, value), header terminator \0, uint64 offset table, then per
 * scanline int y, int byte count and the pixels channel by channel in alphabetical channel order. Little-endian.
 */
export const EXR_MAGIC=20000630;
const PIXEL={uint:0,half:1,float:2} as const;
const COMPRESSION=['NO','RLE','ZIPS','ZIP','PIZ','PXR24','B44','B44A','DWAA','DWAB','HTJ2K256','HTJ2K32'];
const FLAG={tiled:0x200,longNames:0x400,deep:0x800,multipart:0x1000};
// Sanity bound only; real memory is bounded because uncompressed pixels must be present in the file.
const MAX_SIDE=16384;
const NAME_RE=/^[\x21-\x7e]{1,31}$/;
const REQUIRED:Record<string,string>={channels:'chlist',compression:'compression',dataWindow:'box2i',displayWindow:'box2i',lineOrder:'lineOrder',pixelAspectRatio:'float',screenWindowCenter:'v2f',screenWindowWidth:'float'};
function fail(message:string):never{throw new BuckError(message);}
// OpenEXR orders channels by byte-wise name comparison (std::map<Name>); names here are ASCII, so code units match.
const byName=(a:string,b:string)=>a<b?-1:a>b?1:0;

const f32=new Float32Array(1),u32=new Uint32Array(f32.buffer);
/** float32 → IEEE half bits, round to nearest even; overflow → ±Inf, NaN stays NaN (port of Imath imath_float_to_half). */
export function floatToHalf(value:number):number{
  f32[0]=value;const bits=u32[0],sign=(bits>>>16)&0x8000;let ui=bits&0x7fffffff;
  if(ui>=0x38800000){
    if(ui>=0x7f800000){if(ui===0x7f800000)return sign|0x7c00;const m=(ui&0x7fffff)>>>13;return sign|0x7c00|m|(m===0?1:0);}
    if(ui>0x477fefff)return sign|0x7c00;
    ui-=0x38000000;return sign|((ui+0xfff+((ui>>>13)&1))>>>13);
  }
  if(ui<0x33000001)return sign;
  const e=ui>>>23,shift=0x7e-e,m=0x800000|(ui&0x7fffff),r=(m<<(32-shift))>>>0;let out=sign|(m>>>shift);
  if(r>0x80000000||(r===0x80000000&&(out&1)!==0))out++;
  return out;
}
/** IEEE half bits → float, exact (port of Imath imath_half_to_float). */
export function halfToFloat(h:number):number{
  const hexpmant=((h<<17)>>>4)&0x0fffe000;let bits=((h>>>15)&1)<<31;
  if(hexpmant>=0x00800000){bits|=hexpmant;if(hexpmant<0x0f800000)bits+=0x38000000;else bits|=0x7f800000;}
  else if(hexpmant!==0){const lc=Math.clz32(hexpmant)-8;bits|=0x38800000;bits|=hexpmant<<lc;bits-=lc<<23;}
  u32[0]=bits>>>0;return f32[0];
}

const enc=new TextEncoder();
/**
 * Defaults follow spec §6.4: depth (scalar) as FLOAT channel "Z", normals (vector3) as HALF "N.X"/"N.Y"/"N.Z".
 * `channels[i]` names component i of the field; the file stores them alphabetically, as OpenEXR requires.
 */
export function writeExr(field:ScalarField|VectorField,opts:{half?:boolean;channels?:string[]}={}):Uint8Array{
  const {width,height,data}=field,n=field.kind==='scalar'?1:3;
  const names=opts.channels??(n===1?['Z']:['N.X','N.Y','N.Z']),half=opts.half??field.kind==='vector3';
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_SIDE||height>MAX_SIDE)fail(`EXR: ungültige Bildgröße ${width}×${height}.`);
  if(data.length!==width*height*n)fail('EXR: Die Datenlänge passt nicht zur Bildgröße.');
  if(names.length!==n)fail(`EXR: ${n} Kanalnamen erwartet, ${names.length} angegeben.`);
  if(names.some(c=>!NAME_RE.test(c))||new Set(names).size!==n)fail('EXR: Kanalnamen müssen eindeutig sein und aus 1–31 druckbaren ASCII-Zeichen bestehen.');
  const order=names.map((name,component)=>({name,component})).sort((a,b)=>byName(a.name,b.name));
  const bpc=half?2:4,type=half?PIXEL.half:PIXEL.float,lineBytes=width*n*bpc;
  const chlist:number[]=[];
  const int=(arr:number[],x:number)=>arr.push(x&255,(x>>>8)&255,(x>>>16)&255,(x>>>24)&255);
  for(const c of order){chlist.push(...enc.encode(c.name),0);int(chlist,type);chlist.push(0,0,0,0);int(chlist,1);int(chlist,1);}
  chlist.push(0);
  const box=[0,0,width-1,height-1],boxBytes:number[]=[];for(const b of box)int(boxBytes,b);
  const float=(x:number)=>{f32[0]=x;return [u32[0]&255,(u32[0]>>>8)&255,(u32[0]>>>16)&255,u32[0]>>>24];};
  const attrs:[string,string,number[]][]=[
    ['channels','chlist',chlist],['compression','compression',[0]],['dataWindow','box2i',boxBytes],['displayWindow','box2i',boxBytes],
    ['lineOrder','lineOrder',[0]],['pixelAspectRatio','float',float(1)],['screenWindowCenter','v2f',[...float(0),...float(0)]],['screenWindowWidth','float',float(1)],
  ];
  const head:number[]=[];int(head,EXR_MAGIC);int(head,2);
  for(const [name,t,value] of attrs){head.push(...enc.encode(name),0,...enc.encode(t),0);int(head,value.length);head.push(...value);}
  head.push(0);
  const tableAt=head.length,dataAt=tableAt+8*height,chunk=8+lineBytes,out=new Uint8Array(dataAt+height*chunk),v=new DataView(out.buffer);
  out.set(head);
  for(let y=0;y<height;y++){
    const at=dataAt+y*chunk;
    v.setUint32(tableAt+8*y,at%0x100000000,true);v.setUint32(tableAt+8*y+4,Math.floor(at/0x100000000),true);
    v.setInt32(at,y,true);v.setInt32(at+4,lineBytes,true);
    let p=at+8;
    for(const c of order)for(let x=0;x<width;x++){
      const value=data[(y*width+x)*n+c.component];
      if(half){v.setUint16(p,floatToHalf(value),true);p+=2;}else{v.setFloat32(p,value,true);p+=4;}
    }
  }
  return out;
}

interface Channel {name:string;type:number;}
/**
 * Reads exactly the profile writeExr produces (any channel names, HALF/FLOAT, NO_COMPRESSION, scanline, single part).
 * One channel gives a ScalarField; three channels whose names end in X/Y/Z (e.g. N.X) give a VectorField.
 */
export function readExr(bytes:Uint8Array):ScalarField|VectorField{
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),len=bytes.length;
  if(len<8||v.getInt32(0,true)!==EXR_MAGIC)fail('Keine OpenEXR-Datei (Magic Number fehlt).');
  const version=v.getUint32(4,true);
  if((version&0xff)!==2)fail(`OpenEXR-Version ${version&0xff} wird nicht unterstützt (erwartet 2).`);
  if(version&FLAG.tiled)fail('Gekachelte OpenEXR-Dateien werden nicht unterstützt.');
  if(version&FLAG.deep)fail('Deep-OpenEXR-Dateien werden nicht unterstützt.');
  if(version&FLAG.multipart)fail('Multi-Part-OpenEXR-Dateien werden nicht unterstützt.');
  if(version&~(0xff|FLAG.longNames))fail('Die OpenEXR-Datei setzt reservierte Versions-Flags.');
  const maxName=version&FLAG.longNames?255:31;
  let p=8;
  const str=(limit:number,what:string)=>{
    const start=p;while(p<len&&bytes[p]!==0){if(p-start>=limit)fail(`EXR: ${what} ist zu lang.`);p++;}
    if(p>=len)fail('EXR: Der Header ist abgeschnitten.');
    let s='';for(let i=start;i<p;i++)s+=String.fromCharCode(bytes[i]);p++;return s;
  };
  const attrs=new Map<string,{type:string;at:number;size:number}>();
  for(;;){
    if(p>=len)fail('EXR: Der Header ist abgeschnitten.');
    if(bytes[p]===0){p++;break;}
    const name=str(maxName,'Ein Attributname'),type=str(maxName,'Ein Attributtyp');
    if(!name||!type)fail('EXR: Leerer Attributname oder -typ.');
    if(p+4>len)fail('EXR: Der Header ist abgeschnitten.');
    const size=v.getInt32(p,true);p+=4;
    if(size<0||p+size>len)fail(`EXR: Attribut „${name}“ hat eine ungültige Größe.`);
    if(attrs.has(name))fail(`EXR: Attribut „${name}“ kommt doppelt vor.`);
    attrs.set(name,{type,at:p,size});p+=size;
  }
  for(const [name,type] of Object.entries(REQUIRED)){
    const a=attrs.get(name);if(!a)fail(`EXR: Pflichtattribut „${name}“ fehlt.`);
    if(a.type!==type)fail(`EXR: Attribut „${name}“ hat den Typ „${a.type}“ statt „${type}“.`);
  }
  const get=(name:string,size:number)=>{const a=attrs.get(name)!;if(a.size!==size)fail(`EXR: Attribut „${name}“ hat eine ungültige Größe.`);return a.at;};
  const compression=bytes[get('compression',1)];
  if(compression!==0)fail(`EXR-Kompression ${COMPRESSION[compression]??compression} wird nicht unterstützt; erwartet wird NO_COMPRESSION.`);
  const lineOrder=bytes[get('lineOrder',1)];
  if(lineOrder>1)fail('EXR: Zeilenreihenfolge RANDOM_Y ist für Scanline-Dateien nicht erlaubt.');
  get('displayWindow',16);get('pixelAspectRatio',4);get('screenWindowCenter',8);get('screenWindowWidth',4);
  const dw=get('dataWindow',16),xMin=v.getInt32(dw,true),yMin=v.getInt32(dw+4,true),xMax=v.getInt32(dw+8,true),yMax=v.getInt32(dw+12,true);
  // Box2i bounds are inclusive.
  const width=xMax-xMin+1,height=yMax-yMin+1;
  if(!(width>=1&&height>=1&&width<=MAX_SIDE&&height<=MAX_SIDE))fail(`EXR: ungültiges Datenfenster ${width}×${height}.`);
  const ch=attrs.get('channels')!,channels:Channel[]=[];
  {
    let q=ch.at;const end=ch.at+ch.size;
    for(;;){
      if(q>=end)fail('EXR: Die Kanalliste ist beschädigt.');
      if(bytes[q]===0){q++;break;}
      const start=q;while(q<end&&bytes[q]!==0)q++;
      if(q>=end||q-start>maxName)fail('EXR: Die Kanalliste ist beschädigt.');
      let name='';for(let i=start;i<q;i++)name+=String.fromCharCode(bytes[i]);q++;
      if(q+16>end)fail('EXR: Die Kanalliste ist beschädigt.');
      const type=v.getInt32(q,true),xs=v.getInt32(q+8,true),ys=v.getInt32(q+12,true);q+=16;
      if(!/^[\x21-\x7e]+$/.test(name))fail('EXR: Kanalnamen müssen druckbares ASCII sein.');
      if(type===PIXEL.uint)fail(`EXR: Kanal „${name}“ ist UINT; unterstützt werden nur HALF und FLOAT.`);
      if(type!==PIXEL.half&&type!==PIXEL.float)fail(`EXR: Kanal „${name}“ hat den unbekannten Pixeltyp ${type}.`);
      if(xs!==1||ys!==1)fail(`EXR: Kanal „${name}“ ist unterabgetastet; erwartet wird 1×1.`);
      if(channels.some(c=>c.name===name))fail(`EXR: Kanal „${name}“ kommt doppelt vor.`);
      channels.push({name,type});
    }
    if(q!==end)fail('EXR: Die Kanalliste ist beschädigt.');
  }
  channels.sort((a,b)=>byName(a.name,b.name));
  let component:number[];
  if(channels.length===1)component=[0];
  else if(channels.length===3){
    const axis=channels.map(c=>c.name.slice(c.name.lastIndexOf('.')+1));
    component=axis.map(a=>'XYZ'.indexOf(a));
    if(component.some(c=>c<0)||new Set(component).size!==3)fail('EXR: Drei Kanäle müssen auf X, Y und Z enden (z. B. N.X, N.Y, N.Z).');
  }else fail(`EXR: ${channels.length} Kanäle; erwartet werden 1 (Tiefe/Maske) oder 3 (Normalen).`);
  const n=channels.length,lineBytes=width*channels.reduce((s,c)=>s+(c.type===PIXEL.half?2:4),0);
  const tableAt=p;
  if(tableAt+8*height+height*(8+lineBytes)>len)fail('EXR: Die Datei ist kürzer als ihre Pixeldaten.');
  const out=new Float32Array(width*height*n),seen=new Uint8Array(height);
  for(let i=0;i<height;i++){
    const lo=v.getUint32(tableAt+8*i,true),hi=v.getUint32(tableAt+8*i+4,true),at=lo+hi*0x100000000;
    if(at<tableAt+8*height||at+8+lineBytes>len)fail('EXR: Ein Eintrag der Offset-Tabelle zeigt außerhalb der Datei.');
    const y=v.getInt32(at,true)-yMin,size=v.getInt32(at+4,true);
    if(y<0||y>=height)fail('EXR: Eine Scanline liegt außerhalb des Datenfensters.');
    if(seen[y])fail('EXR: Eine Scanline kommt doppelt vor.');
    if(size!==lineBytes)fail('EXR: Eine Scanline hat die falsche Größe (komprimiert?).');
    seen[y]=1;
    let q=at+8;
    channels.forEach((c,ci)=>{
      const k=component[ci];
      if(c.type===PIXEL.half)for(let x=0;x<width;x++,q+=2)out[(y*width+x)*n+k]=halfToFloat(v.getUint16(q,true));
      else for(let x=0;x<width;x++,q+=4)out[(y*width+x)*n+k]=v.getFloat32(q,true);
    });
  }
  return n===1?scalarField(width,height,out):vectorField(width,height,out);
}
