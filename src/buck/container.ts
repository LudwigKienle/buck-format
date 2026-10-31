import { deflateSync, Inflate } from 'fflate';
import { BUCK_MIMETYPE, BuckError, LIMITS } from './types';
import type { BuckGraph, BuckPackage, Manifest, ManifestEntry } from './types';
/**
 * .buck ZIP container (spec §3, §11.3). The central directory is parsed and validated here, before any entry is
 * inflated; fflate only decompresses single deflate streams. Layout per PKWARE APPNOTE 6.3.10 §4.3/§4.4.
 */
const SIG={local:0x04034b50,central:0x02014b50,eocd:0x06054b50,descriptor:0x08074b50,zip64Locator:0x07064b50};
const FLAG={encrypted:1,descriptor:8,strongEncryption:64,utf8:2048,maskedHeaders:8192};
// Bits 1-2 (deflate options), 3 (data descriptor) and 11 (UTF-8) are the only ones a v1 reader accepts.
const ALLOWED_FLAGS=0x080e;
// Extra fields that change how sizes, names or contents are interpreted; other ids (timestamps, uid/gid) are ignored.
const FORBIDDEN_EXTRA:Record<number,string>={0x0001:'ZIP64',0x0017:'starke Verschlüsselung',0x9901:'AES-Verschlüsselung',0x7075:'abweichender Unicode-Dateiname'};
const DOS_DATE_1980=0x0021,MADE_BY=(3<<8)|20,VERSION_NEEDED=20,REGULAR_FILE_ATTRS=(0o100644<<16)>>>0;
const PATH_RE=/^[a-z0-9._/-]+$/,SHA_RE=/^[0-9a-f]{64}$/;
const RESERVED=new Set(['mimetype','manifest.json','graph.json']);
const enc=new TextEncoder(),CHUNK=65536;
/**
 * Sum of all uncompressed entry sizes. Spec §11.3 caps archive, entry and ratio but not the total, so 64 entries × 64 MiB
 * (4 GiB from ~41 MiB at ratio 99:1) would pass; like .buckaux (aux/cache.ts) the total is bounded by the archive limit.
 */
export const TOTAL_UNPACKED_BYTES=LIMITS.archiveBytes;
function fail(message:string):never{throw new BuckError(message);}

export async function sha256Hex(bytes:Uint8Array):Promise<string>{
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(bytes:Uint8Array){let c=0xffffffff;for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&255]^(c>>>8);return(c^0xffffffff)>>>0;}

/** Fast sniff (EPUB OCF technique): stored `mimetype` without extra field at offset 0, content at byte 38. */
export function isBuck(bytes:Uint8Array):boolean{
  const mime=enc.encode(BUCK_MIMETYPE);if(bytes.length<38+mime.length)return false;
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(v.getUint32(0,true)!==SIG.local||v.getUint16(8,true)!==0||v.getUint16(26,true)!==8||v.getUint16(28,true)!==0||v.getUint32(22,true)!==mime.length)return false;
  return String.fromCharCode(...bytes.subarray(30,38))==='mimetype'&&mime.every((b,i)=>bytes[38+i]===b);
}

/** Path rules of spec §3.1 plus the allowed locations of §3.2. Returns a German reason or undefined. */
function pathProblem(path:string):string|undefined{
  if(path.includes('\\'))return `„${path}“ enthält einen Backslash.`;
  if(path.startsWith('/'))return `„${path}“ ist ein absoluter Pfad.`;
  if(/^[a-zA-Z]:/.test(path))return `„${path}“ enthält einen Laufwerksbuchstaben.`;
  if(!PATH_RE.test(path))return `„${path}“ enthält Zeichen außerhalb von [a-z0-9._/-].`;
  if(path.includes('..'))return `„${path}“ enthält „..“.`;
  if(path.split('/').some(s=>s===''||s==='.'))return `„${path}“ enthält leere Pfadsegmente oder ist ein Verzeichnis.`;
  if(path.length>255)return `„${path.slice(0,40)}…“ ist länger als 255 Zeichen.`;
  const allowed=RESERVED.has(path)||/^luts\/[^/]+\.cube$/.test(path)||/^thumbs\/(before|after)\.(jpg|png)$/.test(path)||path==='thumbs/aux-depth.png'||/^masks\/[^/]+\.png$/.test(path)||/^skies\/[^/]+\.png$/.test(path)||path==='meta/recipe.json'||/^ext\/[^/]+\/.+/.test(path);
  return allowed?undefined:`„${path}“ ist an dieser Stelle im Container nicht erlaubt.`;
}

interface CentralEntry {name:string;flags:number;method:number;time:number;date:number;crc:number;csize:number;usize:number;versionNeeded:number;offset:number;dataStart:number;end:number;}

function checkExtra(v:DataView,start:number,length:number,name:string){
  let p=start;const end=start+length;
  while(p<end){
    if(p+4>end)fail(`Zusatzfeld von „${name}“ ist beschädigt.`);
    const id=v.getUint16(p,true),size=v.getUint16(p+2,true);
    if(FORBIDDEN_EXTRA[id])fail(`„${name}“ verwendet ein nicht erlaubtes Zusatzfeld (${FORBIDDEN_EXTRA[id]}).`);
    p+=4+size;
  }
  if(p!==end)fail(`Zusatzfeld von „${name}“ ist beschädigt.`);
}

/** Validates the whole archive structure without decompressing anything. */
function readDirectory(bytes:Uint8Array):CentralEntry[]{
  if(bytes.length>LIMITS.archiveBytes)fail('Die .buck-Datei ist größer als 128 MiB.');
  if(bytes.length<22)fail('Keine gültige .buck-Datei (ZIP-Endsatz fehlt).');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  // End of central directory: the last record whose comment ends exactly at the end of the file.
  let eocd=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-22-0xffff);p--)if(v.getUint32(p,true)===SIG.eocd&&p+22+v.getUint16(p+20,true)===bytes.length){eocd=p;break;}
  if(eocd<0)fail('Keine gültige .buck-Datei (ZIP-Endsatz fehlt).');
  const disk=v.getUint16(eocd+4,true),cdDisk=v.getUint16(eocd+6,true),onDisk=v.getUint16(eocd+8,true),count=v.getUint16(eocd+10,true),cdSize=v.getUint32(eocd+12,true),cdOffset=v.getUint32(eocd+16,true);
  if(count===0xffff||onDisk===0xffff||cdSize===0xffffffff||cdOffset===0xffffffff||(eocd>=20&&v.getUint32(eocd-20,true)===SIG.zip64Locator))fail('ZIP64 ist in .buck Version 1 nicht erlaubt.');
  if(disk!==0||cdDisk!==0||onDisk!==count)fail('Mehrteilige ZIP-Archive sind nicht erlaubt.');
  if(count>LIMITS.entries)fail(`Die .buck-Datei hat ${count} Einträge, erlaubt sind höchstens ${LIMITS.entries}.`);
  if(cdOffset+cdSize!==eocd)fail('Das zentrale Verzeichnis liegt nicht direkt vor dem ZIP-Endsatz.');
  const entries:CentralEntry[]=[],names=new Set<string>();
  let p=cdOffset,total=0;
  for(let i=0;i<count;i++){
    if(p+46>eocd||v.getUint32(p,true)!==SIG.central)fail('Das zentrale Verzeichnis ist beschädigt.');
    const madeBy=v.getUint16(p+4,true),versionNeeded=v.getUint16(p+6,true),flags=v.getUint16(p+8,true),method=v.getUint16(p+10,true),time=v.getUint16(p+12,true),date=v.getUint16(p+14,true);
    const crc=v.getUint32(p+16,true),csize=v.getUint32(p+20,true),usize=v.getUint32(p+24,true),nameLen=v.getUint16(p+28,true),extraLen=v.getUint16(p+30,true),commentLen=v.getUint16(p+32,true);
    const diskStart=v.getUint16(p+34,true),external=v.getUint32(p+38,true),offset=v.getUint32(p+42,true),recordEnd=p+46+nameLen+extraLen+commentLen;
    if(recordEnd>eocd)fail('Das zentrale Verzeichnis ist beschädigt.');
    const rawName=bytes.subarray(p+46,p+46+nameLen);
    if(!(flags&FLAG.utf8)&&rawName.some(b=>b>0x7f))fail('Dateinamen müssen UTF-8 (Flag Bit 11) oder ASCII sein.');
    let name='';try{name=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(rawName);}catch{fail('Ein Dateiname ist kein gültiges UTF-8.');}
    if(flags&(FLAG.encrypted|FLAG.strongEncryption|FLAG.maskedHeaders))fail(`„${name}“ ist verschlüsselt; Verschlüsselung ist nicht erlaubt.`);
    if(flags&~ALLOWED_FLAGS)fail(`„${name}“ verwendet nicht unterstützte ZIP-Flags.`);
    if(method!==0&&method!==8)fail(`„${name}“ verwendet die Kompressionsmethode ${method}; erlaubt sind nur 0 und 8.`);
    if((versionNeeded&0xff)>VERSION_NEEDED)fail(`„${name}“ benötigt ZIP-Funktionen über Version 2.0 (z. B. ZIP64).`);
    if(csize===0xffffffff||usize===0xffffffff||offset===0xffffffff)fail('ZIP64 ist in .buck Version 1 nicht erlaubt.');
    if(diskStart!==0)fail('Mehrteilige ZIP-Archive sind nicht erlaubt.');
    if(names.has(name))fail(`„${name}“ kommt im Archiv doppelt vor.`);
    names.add(name);
    const host=madeBy>>8,mode=external>>>16,type=mode&0o170000;
    if((host===3||host===19)&&type===0o120000)fail(`„${name}“ ist ein symbolischer Link.`);
    if((host===3||host===19)&&type!==0&&type!==0o100000)fail(`„${name}“ ist keine reguläre Datei.`);
    if(external&0x10||name.endsWith('/'))fail(`„${name}“ ist ein Verzeichniseintrag; erlaubt sind nur Dateien.`);
    if(host===10&&external&0x400)fail(`„${name}“ ist ein symbolischer Link.`);
    const problem=pathProblem(name);if(problem)fail(problem);
    checkExtra(v,p+46+nameLen,extraLen,name);
    if(usize>LIMITS.entryBytes)fail(`„${name}“ ist entpackt größer als 64 MiB.`);
    if(method===0&&csize!==usize)fail(`„${name}“ ist unkomprimiert, aber die Größen stimmen nicht überein.`);
    if(usize>csize*LIMITS.ratio)fail(`„${name}“ überschreitet das erlaubte Kompressionsverhältnis von ${LIMITS.ratio}:1.`);
    total+=usize;if(total>TOTAL_UNPACKED_BYTES)fail('Die .buck-Datei ist entpackt größer als 128 MiB.');
    entries.push({name,flags,method,time,date,crc,csize,usize,versionNeeded,offset,dataStart:0,end:0});
    p=recordEnd;
  }
  if(p!==eocd)fail('Das zentrale Verzeichnis ist beschädigt.');
  for(const e of entries){
    const o=e.offset;
    if(o+30>cdOffset||v.getUint32(o,true)!==SIG.local)fail(`Der lokale Header von „${e.name}“ fehlt.`);
    const nameLen=v.getUint16(o+26,true),extraLen=v.getUint16(o+28,true),localCrc=v.getUint32(o+14,true),localC=v.getUint32(o+18,true),localU=v.getUint32(o+22,true);
    const sameSizes=localCrc===e.crc&&localC===e.csize&&localU===e.usize,deferred=(e.flags&FLAG.descriptor)!==0&&localCrc===0&&localC===0&&localU===0;
    const nameBytes=enc.encode(e.name),sameName=nameLen===nameBytes.length&&bytes.subarray(o+30,o+30+nameLen).every((b,i)=>b===nameBytes[i]);
    if(v.getUint16(o+4,true)!==e.versionNeeded||v.getUint16(o+6,true)!==e.flags||v.getUint16(o+8,true)!==e.method||v.getUint16(o+10,true)!==e.time||v.getUint16(o+12,true)!==e.date||!sameName||!(sameSizes||deferred))
      fail(`Lokaler und zentraler Header von „${e.name}“ stimmen nicht überein.`);
    checkExtra(v,o+30+nameLen,extraLen,e.name);
    e.dataStart=o+30+nameLen+extraLen;e.end=e.dataStart+e.csize;
    if(e.end>cdOffset)fail(`Die Daten von „${e.name}“ reichen in das zentrale Verzeichnis.`);
    if(e.flags&FLAG.descriptor){
      // Data descriptor (APPNOTE §4.3.9), with or without its optional signature, must repeat the central values.
      const at=(q:number)=>q+12<=cdOffset&&v.getUint32(q,true)===e.crc&&v.getUint32(q+4,true)===e.csize&&v.getUint32(q+8,true)===e.usize;
      if(e.end+16<=cdOffset&&v.getUint32(e.end,true)===SIG.descriptor&&at(e.end+4))e.end+=16;
      else if(at(e.end))e.end+=12;
      else fail(`Der Datendeskriptor von „${e.name}“ stimmt nicht mit dem zentralen Verzeichnis überein.`);
    }
  }
  // Entries must tile the area before the central directory exactly: no overlap (overlap zip bombs), no hidden data.
  const sorted=[...entries].sort((a,b)=>a.offset-b.offset);let cursor=0;
  for(const e of sorted){if(e.offset!==cursor)fail(e.offset<cursor?`„${e.name}“ überlappt mit einem anderen Eintrag.`:`Vor „${e.name}“ liegen nicht verzeichnete Daten.`);cursor=e.end;}
  if(cursor!==cdOffset)fail('Zwischen den Einträgen und dem zentralen Verzeichnis liegen nicht verzeichnete Daten.');
  const first=entries[0];
  if(!first||first.name!=='mimetype'||first.offset!==0)fail('Der erste Eintrag muss „mimetype“ heißen.');
  if(first.method!==0||first.flags&FLAG.descriptor||v.getUint16(28,true)!==0)fail('„mimetype“ muss unkomprimiert und ohne Zusatzfeld gespeichert sein.');
  return entries;
}

/** Inflates one entry in chunks and stops as soon as it exceeds its declared size, so a lying header cannot burn CPU. */
function extract(bytes:Uint8Array,e:CentralEntry):Uint8Array{
  const data=bytes.subarray(e.dataStart,e.dataStart+e.csize);let out:Uint8Array;
  if(e.method===0)out=data.slice();
  else{
    if(!data.length)fail(`„${e.name}“ ist nicht lesbar komprimiert.`);
    out=new Uint8Array(e.usize);let size=0;
    const inflater=new Inflate((chunk:Uint8Array)=>{
      if(size+chunk.length>e.usize)fail(`„${e.name}“ ist entpackt größer als angegeben.`);
      out.set(chunk,size);size+=chunk.length;
    });
    try{for(let p=0;;p+=CHUNK){const end=Math.min(data.length,p+CHUNK),last=end===data.length;inflater.push(data.subarray(p,end),last);if(last)break;}}
    catch(error){if(error instanceof BuckError)throw error;fail(`„${e.name}“ ist nicht lesbar komprimiert.`);}
    if(size!==e.usize)fail(`„${e.name}“ ist entpackt kleiner als angegeben.`);
  }
  if(out.length!==e.usize)fail(`Die Größe von „${e.name}“ stimmt nicht.`);
  if(crc32(out)!==e.crc)fail(`Die Prüfsumme (CRC-32) von „${e.name}“ stimmt nicht.`);
  return out;
}

function decodeText(bytes:Uint8Array,name:string){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return fail(`„${name}“ ist kein gültiges UTF-8.`);}}
const ENTRY_KEYS=['path','size','sha256','mediaType'];
function parseManifest(bytes:Uint8Array):Manifest{
  // Assumption: the spec sets no manifest size limit; 64 entries fit easily in the graph.json limit.
  if(bytes.length>LIMITS.graphBytes)fail('„manifest.json“ ist zu groß.');
  let raw:unknown;try{raw=JSON.parse(decodeText(bytes,'manifest.json'));}catch(error){if(error instanceof BuckError)throw error;fail('„manifest.json“ ist kein gültiges JSON.');}
  const isObj=(x:unknown):x is Record<string,unknown>=>typeof x==='object'&&x!==null&&!Array.isArray(x);
  const extraKey=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).find(k=>!keys.includes(k)&&!/^x-[a-z0-9-]+$/.test(k));
  if(!isObj(raw)||raw.buckManifest!==1||!Array.isArray(raw.files))fail('„manifest.json“ hat nicht die Form {"buckManifest": 1, "files": […]}.');
  const m=raw as Record<string,unknown>&{files:unknown[]},unknownTop=extraKey(m,['buckManifest','files']);
  if(unknownTop)fail(`„manifest.json“ enthält das unbekannte Feld „${unknownTop}“.`);
  const files:ManifestEntry[]=m.files.map(f=>{
    if(!isObj(f)||typeof f.path!=='string'||typeof f.sha256!=='string'||!SHA_RE.test(f.sha256)||typeof f.mediaType!=='string'||!f.mediaType||!Number.isInteger(f.size)||(f.size as number)<0)
      return fail('Ein Eintrag in „manifest.json“ braucht path, size, sha256 (64 Hex-Zeichen, klein) und mediaType.');
    const unknown=extraKey(f,ENTRY_KEYS);if(unknown)fail(`„manifest.json“ enthält das unbekannte Feld „${unknown}“.`);
    return{path:f.path,size:f.size as number,sha256:f.sha256,mediaType:f.mediaType};
  });
  return{buckManifest:1,files};
}

/** Reads and fully verifies a .buck file in memory (spec §3, §11.3). Throws BuckError with a German message. */
export async function readBuck(bytes:Uint8Array,opts?:{parse?:(text:string)=>BuckGraph}):Promise<BuckPackage>{
  const entries=readDirectory(bytes),contents=new Map<string,Uint8Array>();
  for(const e of entries)contents.set(e.name,extract(bytes,e));
  if(decodeText(contents.get('mimetype')!,'mimetype')!==BUCK_MIMETYPE)fail(`„mimetype“ muss genau „${BUCK_MIMETYPE}“ enthalten.`);
  const manifestBytes=contents.get('manifest.json'),graphBytes=contents.get('graph.json');
  if(!manifestBytes)fail('„manifest.json“ fehlt.');
  if(!graphBytes)fail('„graph.json“ fehlt.');
  const manifest=parseManifest(manifestBytes),listed=new Set<string>();
  for(const f of manifest.files){
    if(f.path==='mimetype'||f.path==='manifest.json')fail(`„${f.path}“ darf nicht in „manifest.json“ stehen.`);
    if(listed.has(f.path))fail(`„${f.path}“ steht doppelt in „manifest.json“.`);
    listed.add(f.path);
    const data=contents.get(f.path);
    if(!data)fail(`„${f.path}“ steht in „manifest.json“, fehlt aber im Archiv.`);
    if(data.length!==f.size)fail(`Die Größe von „${f.path}“ stimmt nicht mit „manifest.json“ überein.`);
    if(await sha256Hex(data)!==f.sha256)fail(`Der SHA-256-Hash von „${f.path}“ stimmt nicht mit „manifest.json“ überein.`);
  }
  for(const name of contents.keys())if(name!=='mimetype'&&name!=='manifest.json'&&!listed.has(name))fail(`„${name}“ fehlt in „manifest.json“.`);
  if(graphBytes.length>LIMITS.graphBytes)fail('„graph.json“ ist größer als 256 KiB.');
  const parse=opts?.parse??(await import('./validate')).parseGraph;
  const graph=parse(decodeText(graphBytes,'graph.json')),files=new Map<string,Uint8Array>();
  for(const name of [...contents.keys()].filter(n=>!RESERVED.has(n)).sort(byCodeUnit))files.set(name,contents.get(name)!);
  return{graph,files,manifest,lookId:await sha256Hex(graphBytes)};
}

/**
 * Archive paths the graph names (lut3d and mask.image files, baked look LUTs, fallback cube, thumbnails, recipe) that are
 * not in `files`, sorted. Used by the editor before saving; readBuck stays lenient and the renderer reports them per node.
 */
export function missingFiles(graph:BuckGraph,files:Map<string,Uint8Array>):string[] {
  const refs:string[]=[];
  for(const n of graph.nodes){
    if(n.type==='color.lut3d@1'||n.type==='mask.image@1')refs.push(n.params.file);
    if(n.type==='sky.replace@1'&&n.params.source==='image'&&n.params.file)refs.push(n.params.file);
    if(n.type==='color.look@1'&&n.params.bakedLut)refs.push(n.params.bakedLut);
  }
  const t=graph.meta.thumbnails;
  for(const r of [graph.fallback?.cube,t?.before,t?.after,graph.meta.recipe])if(r)refs.push(r);
  return [...new Set(refs.filter(r=>typeof r==='string'&&!files.has(r)))].sort(byCodeUnit);
}

// Code-unit order, never localeCompare: the byte layout must not depend on the user's locale.
const byCodeUnit=(a:string,b:string)=>a<b?-1:a>b?1:0;
function mediaType(path:string){return path.endsWith('.json')?'application/json':path.endsWith('.cube')?'text/plain':path.endsWith('.jpg')?'image/jpeg':path.endsWith('.png')?'image/png':'application/octet-stream';}

/**
 * Writes byte-identical archives for identical input: fixed DOS time 1980-01-01 00:00, fixed attributes, no extra
 * fields, order mimetype, manifest.json, graph.json, then the remaining paths sorted. Identity across fflate releases
 * is not guaranteed because the deflate encoder may change; the container stays valid either way.
 */
export async function writeBuck(graph:BuckGraph,files:Map<string,Uint8Array>):Promise<Uint8Array>{
  const paths=[...files.keys()].sort(byCodeUnit);
  for(const path of paths){
    if(RESERVED.has(path))fail(`„${path}“ wird vom Container selbst geschrieben.`);
    const problem=pathProblem(path);if(problem)fail(problem);
    if(files.get(path)!.length>LIMITS.entryBytes)fail(`„${path}“ ist größer als 64 MiB.`);
  }
  if(paths.length+3>LIMITS.entries)fail(`Eine .buck-Datei darf höchstens ${LIMITS.entries} Einträge haben.`);
  const graphBytes=enc.encode(JSON.stringify(graph,null,2));
  if(graphBytes.length>LIMITS.graphBytes)fail('„graph.json“ ist größer als 256 KiB.');
  // Own files must reopen: the manifest is at most graphBytes, mimetype is tiny.
  if(paths.reduce((s,p)=>s+files.get(p)!.length,graphBytes.length+LIMITS.graphBytes)>TOTAL_UNPACKED_BYTES)fail('Die .buck-Datei wäre entpackt größer als 128 MiB.');
  const payload:[string,Uint8Array][]=[['graph.json',graphBytes],...paths.map(p=>[p,files.get(p)!] as [string,Uint8Array])];
  const manifest:Manifest={buckManifest:1,files:await Promise.all(payload.map(async([path,data])=>({path,size:data.length,sha256:await sha256Hex(data),mediaType:mediaType(path)})))};
  const entries:[string,Uint8Array][]=[['mimetype',enc.encode(BUCK_MIMETYPE)],['manifest.json',enc.encode(JSON.stringify(manifest,null,2))],...payload];
  const locals:Uint8Array[]=[],centrals:Uint8Array[]=[];let offset=0;
  for(const [i,[name,data]] of entries.entries()){
    const deflated=i===0?undefined:deflateSync(data,{level:9});
    // Store when deflate does not help or would exceed the reader's ratio limit (e.g. long runs of identical rows).
    const useDeflate=deflated!==undefined&&deflated.length<data.length&&data.length<=deflated.length*LIMITS.ratio;
    const body=useDeflate?deflated!:data,nameBytes=enc.encode(name),crc=crc32(data);
    const common=(h:DataView,at:number)=>{h.setUint16(at,VERSION_NEEDED,true);h.setUint16(at+2,FLAG.utf8,true);h.setUint16(at+4,useDeflate?8:0,true);h.setUint16(at+6,0,true);h.setUint16(at+8,DOS_DATE_1980,true);h.setUint32(at+10,crc,true);h.setUint32(at+14,body.length,true);h.setUint32(at+18,data.length,true);h.setUint16(at+22,nameBytes.length,true);h.setUint16(at+24,0,true);};
    const local=new Uint8Array(30+nameBytes.length+body.length),lv=new DataView(local.buffer);
    lv.setUint32(0,SIG.local,true);common(lv,4);local.set(nameBytes,30);local.set(body,30+nameBytes.length);
    const central=new Uint8Array(46+nameBytes.length),cv=new DataView(central.buffer);
    cv.setUint32(0,SIG.central,true);cv.setUint16(4,MADE_BY,true);common(cv,6);cv.setUint32(38,REGULAR_FILE_ATTRS,true);cv.setUint32(42,offset,true);central.set(nameBytes,46);
    locals.push(local);centrals.push(central);offset+=local.length;
  }
  const cdSize=centrals.reduce((s,c)=>s+c.length,0),out=new Uint8Array(offset+cdSize+22),ov=new DataView(out.buffer);
  let p=0;for(const part of [...locals,...centrals]){out.set(part,p);p+=part.length;}
  ov.setUint32(p,SIG.eocd,true);ov.setUint16(p+8,entries.length,true);ov.setUint16(p+10,entries.length,true);ov.setUint32(p+12,cdSize,true);ov.setUint32(p+16,offset,true);
  if(out.length>LIMITS.archiveBytes)fail('Die .buck-Datei würde größer als 128 MiB.');
  return out;
}
