import { Inflate, zipSync } from 'fflate';
import { sha256Hex } from '../container';
import { BuckError, LIMITS } from '../types';
import type { AuxChannels, ScalarField, VectorField } from '../types';
import { readExr, writeExr } from './exr';
/**
 * Analysis cache of spec §6.4. Entries are immutable: the first save under a key wins, a changed key part gives a
 * new key. Storage is IndexedDB "buckswood-buck" (object store "aux"), or an in-memory Map where IndexedDB is
 * missing or refuses to open (Node, some private modes). `.buckaux` is a ZIP with aux.json and one EXR per channel.
 */
export const AUX_DB='buckswood-buck';
const STORE='aux',AUXJSON='aux.json',enc=new TextEncoder();
function fail(message:string):never{throw new BuckError(message);}

/** SHA-256 over canonical JSON (RFC 8785 JCS: keys sorted by UTF-16 code units, ECMAScript number/string forms). */
export async function auxKey(parts:Record<string,string|number>):Promise<string>{
  const keys=Object.keys(parts).sort();
  if(!keys.length)fail('Der Cache-Schlüssel braucht mindestens einen Bestandteil.');
  for(const k of keys){const v=parts[k];if(typeof v==='number'?!Number.isFinite(v):typeof v!=='string')fail(`Cache-Schlüsselteil „${k}“ muss Text oder eine endliche Zahl sein.`);}
  return sha256Hex(enc.encode('{'+keys.map(k=>`${JSON.stringify(k)}:${JSON.stringify(parts[k])}`).join(',')+'}'));
}

function checkField(f:unknown,kind:'scalar'|'vector3',what:string){
  const x=f as ScalarField|VectorField|undefined,n=kind==='scalar'?1:3;
  const ok=!!x&&x.kind===kind&&x.data instanceof Float32Array&&Number.isInteger(x.width)&&Number.isInteger(x.height)&&x.width>=1&&x.height>=1&&x.data.length===x.width*x.height*n;
  if(!ok)fail(`Hilfskanal „${what}“ ist kein gültiges ${kind==='scalar'?'Skalar':'Vektor'}feld.`);
}
const MASK_NAME=/^[A-Za-z0-9_-]{1,64}$/;
function checkAux(aux:AuxChannels){
  if(aux.depth)checkField(aux.depth,'scalar','depth');
  if(aux.normals)checkField(aux.normals,'vector3','normals');
  const names=Object.keys(aux.masks??{});
  if(names.length>LIMITS.entries-3)fail('Zu viele Masken im Analyse-Cache.');
  for(const name of names){if(!MASK_NAME.test(name))fail(`Ungültiger Maskenname „${name}“.`);checkField(aux.masks[name],'scalar',name);}
}
// Fresh, compact buffers: a subarray view would otherwise drag its whole ArrayBuffer into storage.
const copyField=<T extends ScalarField|VectorField>(f:T):T=>({...f,data:f.data.slice()});
function copyAux(aux:AuxChannels):AuxChannels{
  const masks:Record<string,ScalarField>={};for(const k of Object.keys(aux.masks??{}).sort())masks[k]=copyField(aux.masks[k]);
  return{...(aux.depth&&{depth:copyField(aux.depth)}),...(aux.normals&&{normals:copyField(aux.normals)}),masks};
}
/** meta is stored as plain JSON so the IndexedDB copy, the memory copy and aux.json agree. */
function plainMeta(meta:object):Record<string,unknown>{
  let json:string|undefined;try{json=JSON.stringify(meta);}catch{fail('Die Cache-Metadaten sind nicht als JSON darstellbar.');}
  const out:unknown=json===undefined?undefined:JSON.parse(json);
  if(typeof out!=='object'||out===null||Array.isArray(out))fail('Die Cache-Metadaten müssen ein JSON-Objekt sein.');
  return out as Record<string,unknown>;
}

interface Entry {aux:AuxChannels;meta:Record<string,unknown>;}
interface Store {get(key:string):Promise<Entry|undefined>;add(key:string,value:Entry):Promise<void>;}
function memoryStore():Store{
  const map=new Map<string,Entry>();
  return{
    async get(key){const e=map.get(key);return e&&{aux:copyAux(e.aux),meta:structuredClone(e.meta)};},
    async add(key,value){if(!map.has(key))map.set(key,{aux:copyAux(value.aux),meta:structuredClone(value.meta)});},
  };
}
function openDb(idb:IDBFactory,version?:number):Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const r=version===undefined?idb.open(AUX_DB):idb.open(AUX_DB,version);
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE);};
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
    // Another tab holds an old version open: give up instead of hanging; this session then caches in memory.
    r.onblocked=()=>reject(new Error('blocked'));
  });
}
async function idbStore(idb:IDBFactory):Promise<Store>{
  let db=await openDb(idb);
  // The database name may be shared with other Buckswood modules: add our store with a version bump when missing.
  if(!db.objectStoreNames.contains(STORE)){const next=db.version+1;db.close();db=await openDb(idb,next);}
  db.onversionchange=()=>{db.close();store=undefined;};
  const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);});
  return{
    async get(key){
      const tx=db.transaction(STORE,'readonly'),r=tx.objectStore(STORE).get(key);
      await done(tx);return r.result as Entry|undefined;
    },
    async add(key,value){
      const tx=db.transaction(STORE,'readwrite'),r=tx.objectStore(STORE).add(value,key);
      // Key exists: immutable cache, keep the first entry and let the transaction complete.
      r.onerror=e=>{if(r.error?.name==='ConstraintError')e.preventDefault();};
      await done(tx);
    },
  };
}
let store:Promise<Store>|undefined;
function getStore(){
  return store??=(async()=>{
    const idb=(globalThis as {indexedDB?:IDBFactory}).indexedDB;
    if(!idb)return memoryStore();
    try{return await idbStore(idb);}catch{return memoryStore();}
  })();
}

export async function saveAux(key:string,aux:AuxChannels,meta:object):Promise<void>{
  if(typeof key!=='string'||!key||key.length>256)fail('Ungültiger Cache-Schlüssel.');
  checkAux(aux);
  const entry={aux:copyAux(aux),meta:plainMeta(meta)},s=await getStore();
  try{await s.add(key,entry);}catch(error){fail(`Der Analyse-Cache konnte nicht gespeichert werden${error instanceof Error&&error.message?`: ${error.message}`:'.'}`);}
}
export async function loadAux(key:string):Promise<{aux:AuxChannels;meta:object}|undefined>{
  const s=await getStore();let e:Entry|undefined;
  try{e=await s.get(key);}catch{return undefined;}
  if(!e)return undefined;
  // Defensive: an entry written by another app version that no longer matches the contract is treated as a miss.
  try{checkAux(e.aux);}catch{return undefined;}
  return{aux:e.aux,meta:e.meta};
}

const MTIME=new Date(1980,0,1);
/** Deterministic .buckaux bytes: fixed entry order and DOS timestamp. Depth FLOAT "Z", normals HALF, masks FLOAT "A". */
export function exportBuckaux(aux:AuxChannels,meta:object):Uint8Array{
  checkAux(aux);
  const files:Record<string,Uint8Array>={},channels:Record<string,unknown>={};
  const add=(path:string,f:ScalarField|VectorField,bytes:Uint8Array)=>{files[path]=bytes;return{path,width:f.width,height:f.height};};
  if(aux.depth)channels.depth=add('depth.exr',aux.depth,writeExr(aux.depth,{half:false,channels:['Z']}));
  if(aux.normals)channels.normals=add('normals.exr',aux.normals,writeExr(aux.normals,{half:true,channels:['N.X','N.Y','N.Z']}));
  const masks:Record<string,unknown>={};
  Object.keys(aux.masks??{}).sort().forEach((name,i)=>{masks[name]=add(`masks/${i}.exr`,aux.masks[name],writeExr(aux.masks[name],{half:false,channels:['A']}));});
  channels.masks=masks;
  const json=enc.encode(JSON.stringify({buckaux:1,channels,meta:plainMeta(meta)},null,2));
  if(json.length>LIMITS.graphBytes)fail('„aux.json“ wäre größer als 256 KiB.');
  return zipSync({[AUXJSON]:json,...files},{level:6,mtime:MTIME});
}

const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(b:Uint8Array){let c=0xffffffff;for(let i=0;i<b.length;i++)c=CRC_TABLE[(c^b[i])&255]^(c>>>8);return(c^0xffffffff)>>>0;}
const PATH_RE=/^(aux\.json|depth\.exr|normals\.exr|masks\/(0|[1-9][0-9]?)\.exr)$/;
interface ZipEntry {name:string;method:number;crc:number;csize:number;usize:number;start:number;}

/** Reads the archive in memory with the §11.3 hardening of .buck (no extraction to disk, bounded inflation). */
function readZip(bytes:Uint8Array):Map<string,Uint8Array>{
  if(bytes.length>LIMITS.archiveBytes)fail('Die .buckaux-Datei ist größer als 128 MiB.');
  if(bytes.length<22)fail('Keine gültige .buckaux-Datei (ZIP-Endsatz fehlt).');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let eocd=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-22-0xffff);p--)if(v.getUint32(p,true)===0x06054b50&&p+22+v.getUint16(p+20,true)===bytes.length){eocd=p;break;}
  if(eocd<0)fail('Keine gültige .buckaux-Datei (ZIP-Endsatz fehlt).');
  const count=v.getUint16(eocd+10,true),cdSize=v.getUint32(eocd+12,true),cdOffset=v.getUint32(eocd+16,true);
  if(count===0xffff||cdSize===0xffffffff||cdOffset===0xffffffff||(eocd>=20&&v.getUint32(eocd-20,true)===0x07064b50))fail('ZIP64 ist in .buckaux nicht erlaubt.');
  if(v.getUint16(eocd+4,true)!==0||v.getUint16(eocd+6,true)!==0||v.getUint16(eocd+8,true)!==count)fail('Mehrteilige ZIP-Archive sind nicht erlaubt.');
  if(count>LIMITS.entries)fail(`Die .buckaux-Datei hat ${count} Einträge, erlaubt sind höchstens ${LIMITS.entries}.`);
  if(cdOffset+cdSize!==eocd)fail('Das zentrale ZIP-Verzeichnis ist beschädigt.');
  const entries:ZipEntry[]=[];let p=cdOffset,total=0;
  for(let i=0;i<count;i++){
    if(p+46>eocd||v.getUint32(p,true)!==0x02014b50)fail('Das zentrale ZIP-Verzeichnis ist beschädigt.');
    const flags=v.getUint16(p+8,true),method=v.getUint16(p+10,true),crc=v.getUint32(p+16,true),csize=v.getUint32(p+20,true),usize=v.getUint32(p+24,true);
    const nameLen=v.getUint16(p+28,true),extraLen=v.getUint16(p+30,true),commentLen=v.getUint16(p+32,true),external=v.getUint32(p+38,true),offset=v.getUint32(p+42,true);
    if(p+46+nameLen+extraLen+commentLen>eocd)fail('Das zentrale ZIP-Verzeichnis ist beschädigt.');
    let name='';for(let k=0;k<nameLen;k++)name+=String.fromCharCode(bytes[p+46+k]);
    // Whitelist of exact names: rules out traversal, absolute paths, backslashes, directories and drive letters.
    if(!PATH_RE.test(name))fail(`„${name.slice(0,60)}“ ist in einer .buckaux-Datei nicht erlaubt.`);
    if(entries.some(e=>e.name===name))fail(`„${name}“ kommt im Archiv doppelt vor.`);
    if(flags&(1|64|8192))fail(`„${name}“ ist verschlüsselt; Verschlüsselung ist nicht erlaubt.`);
    if(method!==0&&method!==8)fail(`„${name}“ verwendet die Kompressionsmethode ${method}; erlaubt sind nur 0 und 8.`);
    if(((external>>>16)&0o170000)===0o120000)fail(`„${name}“ ist ein symbolischer Link.`);
    if(usize>LIMITS.entryBytes)fail(`„${name}“ ist entpackt größer als 64 MiB.`);
    if(method===0&&csize!==usize)fail(`„${name}“ ist unkomprimiert, aber die Größen stimmen nicht überein.`);
    // Ratio limit only for JSON: constant fields (e.g. an all-ones mask) legitimately deflate far beyond 100:1, so
    // EXR entries are bounded by the absolute entry/total limits and exact header-derived sizes in readExr.
    if(name===AUXJSON&&usize>csize*LIMITS.ratio)fail(`„${name}“ überschreitet das erlaubte Kompressionsverhältnis von ${LIMITS.ratio}:1.`);
    total+=usize;if(total>LIMITS.archiveBytes)fail('Die .buckaux-Datei ist entpackt größer als 128 MiB.');
    if(offset+30>cdOffset||v.getUint32(offset,true)!==0x04034b50)fail(`Der lokale Header von „${name}“ fehlt.`);
    const lNameLen=v.getUint16(offset+26,true),lExtra=v.getUint16(offset+28,true),lName=bytes.subarray(offset+30,offset+30+lNameLen);
    const sameName=lNameLen===nameLen&&lName.every((b,k)=>b===bytes[p+46+k]);
    const sameSizes=v.getUint32(offset+14,true)===crc&&v.getUint32(offset+18,true)===csize&&v.getUint32(offset+22,true)===usize;
    const deferred=(flags&8)!==0&&v.getUint32(offset+14,true)===0&&v.getUint32(offset+18,true)===0&&v.getUint32(offset+22,true)===0;
    if(!sameName||v.getUint16(offset+8,true)!==method||!(sameSizes||deferred))fail(`Lokaler und zentraler Header von „${name}“ stimmen nicht überein.`);
    const start=offset+30+lNameLen+lExtra;
    if(start+csize>cdOffset)fail(`Die Daten von „${name}“ reichen in das zentrale Verzeichnis.`);
    entries.push({name,method,crc,csize,usize,start});
    p+=46+nameLen+extraLen+commentLen;
  }
  const sorted=[...entries].sort((a,b)=>a.start-b.start);
  for(let i=1;i<sorted.length;i++)if(sorted[i].start<sorted[i-1].start+sorted[i-1].csize)fail(`„${sorted[i].name}“ überlappt mit einem anderen Eintrag.`);
  const out=new Map<string,Uint8Array>();
  for(const e of entries){
    const data=bytes.subarray(e.start,e.start+e.csize);let content:Uint8Array;
    if(e.method===0)content=data.slice();
    else{
      content=new Uint8Array(e.usize);let size=0;
      const inflater=new Inflate(chunk=>{if(size+chunk.length>e.usize)fail(`„${e.name}“ ist entpackt größer als angegeben.`);content.set(chunk,size);size+=chunk.length;});
      try{for(let q=0;;q+=65536){const end=Math.min(data.length,q+65536),last=end===data.length;inflater.push(data.subarray(q,end),last);if(last)break;}}
      catch(error){if(error instanceof BuckError)throw error;fail(`„${e.name}“ ist nicht lesbar komprimiert.`);}
      if(size!==e.usize)fail(`„${e.name}“ ist entpackt kleiner als angegeben.`);
    }
    if(crc32(content)!==e.crc)fail(`Die Prüfsumme (CRC-32) von „${e.name}“ stimmt nicht.`);
    out.set(e.name,content);
  }
  return out;
}

function jsonDepth(x:unknown,depth=1):number{
  if(typeof x!=='object'||x===null)return depth-1;
  let max=depth;for(const v of Object.values(x)){max=Math.max(max,jsonDepth(v,depth+1));if(max>LIMITS.jsonDepth)break;}
  return max;
}
const isObj=(x:unknown):x is Record<string,unknown>=>typeof x==='object'&&x!==null&&!Array.isArray(x);

export function importBuckaux(bytes:Uint8Array):{aux:AuxChannels;meta:Record<string,unknown>}{
  const files=readZip(bytes),raw=files.get(AUXJSON);
  if(!raw)fail('„aux.json“ fehlt in der .buckaux-Datei.');
  if(raw.length>LIMITS.graphBytes)fail('„aux.json“ ist größer als 256 KiB.');
  let doc:unknown;
  try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail('„aux.json“ ist kein gültiges JSON.');}
  if(jsonDepth(doc)>LIMITS.jsonDepth)fail(`„aux.json“ ist tiefer verschachtelt als ${LIMITS.jsonDepth} Ebenen.`);
  if(!isObj(doc)||doc.buckaux!==1||!isObj(doc.channels)||!isObj(doc.meta))fail('„aux.json“ hat nicht die Form {"buckaux": 1, "channels": {…}, "meta": {…}}.');
  const used=new Set([AUXJSON]);
  const load=(ref:unknown,path:string,kind:'scalar'|'vector3',what:string)=>{
    if(!isObj(ref)||ref.path!==path||!Number.isInteger(ref.width)||!Number.isInteger(ref.height))fail(`„aux.json“: Eintrag „${what}“ ist ungültig.`);
    const data=files.get(path);if(!data)fail(`„${path}“ fehlt in der .buckaux-Datei.`);
    used.add(path);
    const field=readExr(data);
    if(field.kind!==kind)fail(`„${path}“ hat die falsche Kanalzahl für „${what}“.`);
    if(field.width!==ref.width||field.height!==ref.height)fail(`„${path}“ hat nicht die in „aux.json“ angegebene Größe.`);
    return field;
  };
  const ch=doc.channels,aux:AuxChannels={masks:{}};
  if(ch.depth!==undefined)aux.depth=load(ch.depth,'depth.exr','scalar','depth') as ScalarField;
  if(ch.normals!==undefined)aux.normals=load(ch.normals,'normals.exr','vector3','normals') as VectorField;
  if(ch.masks!==undefined){
    const masks=ch.masks;
    if(!isObj(masks))fail('„aux.json“: „masks“ ist ungültig.');
    Object.keys(masks).sort().forEach((name,i)=>{
      if(!MASK_NAME.test(name))fail(`„aux.json“: ungültiger Maskenname „${name.slice(0,60)}“.`);
      aux.masks[name]=load(masks[name],`masks/${i}.exr`,'scalar',name) as ScalarField;
    });
  }
  const unknown=Object.keys(ch).find(k=>k!=='depth'&&k!=='normals'&&k!=='masks');
  if(unknown)fail(`„aux.json“ enthält den unbekannten Kanal „${unknown.slice(0,60)}“.`);
  for(const name of files.keys())if(!used.has(name))fail(`„${name}“ wird in „aux.json“ nicht verwendet.`);
  return{aux,meta:doc.meta};
}
