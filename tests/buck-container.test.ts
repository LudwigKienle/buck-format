import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { deflateSync, unzipSync } from 'fflate';
import { describe,expect,it } from 'vitest';
import { isBuck,readBuck,sha256Hex,writeBuck } from '../src/buck/container';
import { BUCK_MIMETYPE,BuckError,LIMITS } from '../src/buck/types';
import type { BuckGraph } from '../src/buck/types';

// validate.ts is another agent's module; the container must work with any injected parser.
const parse=(text:string)=>JSON.parse(text) as BuckGraph;
const graph=JSON.parse(readFileSync(new URL('./fixtures/buck/fargo-fog-warm.json',import.meta.url),'utf8')) as BuckGraph;
const enc=new TextEncoder(),u8=(s:string)=>enc.encode(s);
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const cube=u8('TITLE "Fargo"\nLUT_3D_SIZE 2\n'+'0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
const fixtureFiles=()=>new Map<string,Uint8Array>([['thumbs/after.jpg',new Uint8Array([255,216,255,224,1,2,3])],['luts/fargo_look_rec709_64.cube',cube],['thumbs/before.jpg',new Uint8Array([255,216,255,224,9,9])]]);

/** Hand-built ZIP writer with every header field overridable, used to craft malicious archives. */
interface Entry {name:string;data:Uint8Array;method?:number;flags?:number;madeBy?:number;versionNeeded?:number;external?:number;extra?:Uint8Array;body?:Uint8Array;crc?:number;usize?:number;csize?:number;
  local?:{name?:string;method?:number;crc?:number;zeroSizes?:boolean};descriptor?:Uint8Array;rawName?:Uint8Array;}
function zip(entries:Entry[],o:{gapAfterFirst?:number;eocd?:(v:DataView)=>void;trailing?:number;embed?:{entry:number;host:number}}={}){
  const locals:Uint8Array[]=[],centrals:Uint8Array[]=[],offsets:number[]=[];let offset=0;
  entries.forEach((e,i)=>{
    const method=e.method??8,body=e.body??(method===8?deflateSync(e.data):e.data),name=e.rawName??u8(e.name),localName=e.local?.name!==undefined?u8(e.local.name):name,extra=e.extra??new Uint8Array(0);
    const crc=e.crc??crc32(e.data),usize=e.usize??e.data.length,csize=e.csize??body.length,flags=e.flags??0x800,descriptor=e.descriptor??new Uint8Array(0);
    const local=new Uint8Array(30+localName.length+extra.length+body.length+descriptor.length),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,e.versionNeeded??20,true);lv.setUint16(6,flags,true);lv.setUint16(8,e.local?.method??method,true);lv.setUint16(12,0x21,true);
    lv.setUint32(14,e.local?.zeroSizes?0:e.local?.crc??crc,true);lv.setUint32(18,e.local?.zeroSizes?0:csize,true);lv.setUint32(22,e.local?.zeroSizes?0:usize,true);
    lv.setUint16(26,localName.length,true);lv.setUint16(28,extra.length,true);local.set(localName,30);local.set(extra,30+localName.length);local.set(body,30+localName.length+extra.length);local.set(descriptor,local.length-descriptor.length);
    const central=new Uint8Array(46+name.length+extra.length),cv=new DataView(central.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,e.madeBy??0x0314,true);cv.setUint16(6,e.versionNeeded??20,true);cv.setUint16(8,flags,true);cv.setUint16(10,method,true);cv.setUint16(14,0x21,true);
    cv.setUint32(16,crc,true);cv.setUint32(20,csize,true);cv.setUint32(24,usize,true);cv.setUint16(28,name.length,true);cv.setUint16(30,extra.length,true);cv.setUint32(38,e.external??(0o100644<<16)>>>0,true);
    offsets.push(offset);cv.setUint32(42,offset,true);central.set(name,46);central.set(extra,46+name.length);
    locals.push(local);centrals.push(central);offset+=local.length;
    if(i===0&&o.gapAfterFirst){locals.push(new Uint8Array(o.gapAfterFirst));offset+=o.gapAfterFirst;}
  });
  if(o.embed){
    // Point one central record into the payload of another entry and drop its own local record.
    const host=entries[o.embed.host];locals.splice(o.embed.entry,1);
    new DataView(centrals[o.embed.entry].buffer).setUint32(42,offsets[o.embed.host]+30+u8(host.name).length+(host.extra?.length??0),true);
  }
  const head=locals.reduce((s,l)=>s+l.length,0),cdSize=centrals.reduce((s,c)=>s+c.length,0),out=new Uint8Array(head+cdSize+22+(o.trailing??0)),v=new DataView(out.buffer);
  let p=0;for(const part of [...locals,...centrals]){out.set(part,p);p+=part.length;}
  v.setUint32(p,0x06054b50,true);v.setUint16(p+8,entries.length,true);v.setUint16(p+10,entries.length,true);v.setUint32(p+12,cdSize,true);v.setUint32(p+16,head,true);
  o.eocd?.(new DataView(out.buffer,p,22));
  return out;
}
/** A valid archive as entry list: mimetype, manifest (computed from `payload`), graph, extra files. */
function valid(payload:[string,Uint8Array][]=[['luts/a.cube',cube]],manifestFiles?:object[]):Entry[]{
  const all:[string,Uint8Array][]=[['graph.json',u8(JSON.stringify(graph))],...payload];
  const manifest={buckManifest:1,files:manifestFiles??all.map(([path,data])=>({path,size:data.length,sha256:sha(data),mediaType:'application/octet-stream'}))};
  return[{name:'mimetype',data:u8(BUCK_MIMETYPE),method:0},{name:'manifest.json',data:u8(JSON.stringify(manifest))},...all.map(([name,data])=>({name,data}))];
}
const edit=(entries:Entry[],name:string,patch:Partial<Entry>)=>entries.map(e=>e.name===name?{...e,...patch}:e);
async function rejects(bytes:Uint8Array,message:RegExp){
  const error=await readBuck(bytes,{parse}).then(()=>undefined,(e:unknown)=>e);
  expect(error).toBeInstanceOf(BuckError);expect((error as Error).message).toMatch(message);
}

describe('buck container roundtrip and determinism',()=>{
  it('roundtrips the fixture graph with embedded files and derives the look id from graph.json',async()=>{
    const bytes=await writeBuck(graph,fixtureFiles()),pkg=await readBuck(bytes,{parse});
    expect(pkg.graph).toEqual(graph);
    expect([...pkg.files.keys()]).toEqual(['luts/fargo_look_rec709_64.cube','thumbs/after.jpg','thumbs/before.jpg']);
    expect(pkg.files.get('luts/fargo_look_rec709_64.cube')).toEqual(cube);
    const graphBytes=u8(JSON.stringify(graph,null,2));
    expect(pkg.lookId).toBe(sha(graphBytes));expect(await sha256Hex(graphBytes)).toBe(sha(graphBytes));
    expect(pkg.manifest.files.map(f=>f.path)).toEqual(['graph.json','luts/fargo_look_rec709_64.cube','thumbs/after.jpg','thumbs/before.jpg']);
    expect(pkg.manifest.files.find(f=>f.path==='graph.json')).toMatchObject({sha256:pkg.lookId,size:graphBytes.length,mediaType:'application/json'});
    expect(pkg.manifest.files.find(f=>f.path==='thumbs/after.jpg')?.mediaType).toBe('image/jpeg');
  });
  it('writes byte-identical archives regardless of map insertion order',async()=>{
    const reversed=new Map([...fixtureFiles()].reverse()),a=await writeBuck(graph,fixtureFiles()),b=await writeBuck(graph,reversed);
    expect(sha(a)).toBe(sha(b));expect(a.length).toBe(b.length);
  });
  it('writes mimetype first and stored, readable by the sniffer and by an independent unzip',async()=>{
    const bytes=await writeBuck(graph,fixtureFiles()),v=new DataView(bytes.buffer);
    expect(isBuck(bytes)).toBe(true);expect(new TextDecoder().decode(bytes.subarray(30,38))).toBe('mimetype');
    expect(new TextDecoder().decode(bytes.subarray(38,38+BUCK_MIMETYPE.length))).toBe(BUCK_MIMETYPE);
    expect(v.getUint16(8,true)).toBe(0);expect(v.getUint16(12,true)).toBe(0x21);expect(v.getUint16(10,true)).toBe(0);
    const unzipped=unzipSync(bytes);
    expect(Object.keys(unzipped)).toEqual(['mimetype','manifest.json','graph.json','luts/fargo_look_rec709_64.cube','thumbs/after.jpg','thumbs/before.jpg']);
    expect(new TextDecoder().decode(unzipped['graph.json'])).toBe(JSON.stringify(graph,null,2));
  });
  it('stores entries whose deflate ratio would exceed the reader limit, so own files always reopen',async()=>{
    const zeros=new Uint8Array(1<<20),bytes=await writeBuck(graph,new Map([['ext/test/zeros.bin',zeros]]));
    expect(bytes.length).toBeGreaterThan(zeros.length);
    expect((await readBuck(bytes,{parse})).files.get('ext/test/zeros.bin')).toEqual(zeros);
  },30000); // 1 MiB deep equality is slow on a loaded machine
  it('accepts a valid hand-built archive with ASCII names without the UTF-8 flag and with data descriptors',async()=>{
    const entries=valid().map(e=>e.name==='mimetype'?{...e,flags:0}:e);
    expect((await readBuck(zip(entries),{parse})).files.get('luts/a.cube')).toEqual(cube);
    const withDescriptor=edit(entries,'luts/a.cube',{flags:0x808,local:{zeroSizes:true}}),cubeEntry=withDescriptor.find(e=>e.name==='luts/a.cube')!;
    const body=deflateSync(cube),desc=new Uint8Array(16),dv=new DataView(desc.buffer);
    dv.setUint32(0,0x08074b50,true);dv.setUint32(4,crc32(cube),true);dv.setUint32(8,body.length,true);dv.setUint32(12,cube.length,true);
    cubeEntry.body=body;cubeEntry.descriptor=desc;
    expect((await readBuck(zip(withDescriptor),{parse})).files.get('luts/a.cube')).toEqual(cube);
    cubeEntry.descriptor=desc.slice(4);
    expect((await readBuck(zip(withDescriptor),{parse})).files.get('luts/a.cube')).toEqual(cube);
    dv.setUint32(12,cube.length+1,true);cubeEntry.descriptor=desc;
    await rejects(zip(withDescriptor),/Datendeskriptor/);
  });
  it('sniffs only real .buck files',()=>{
    expect(isBuck(new Uint8Array(10))).toBe(false);
    expect(isBuck(zip(edit(valid(),'mimetype',{data:u8('application/zip')})))).toBe(false);
    expect(isBuck(zip(edit(valid(),'mimetype',{method:8})))).toBe(false);
  });
});

describe('buck writer rejects invalid input',()=>{
  it.each([['../x.cube'],['luts/A.cube'],['scripts/run.js'],['mimetype'],['graph.json'],['luts\\a.cube']])('refuses path %s',async(path)=>{
    await expect(writeBuck(graph,new Map([[path,cube]]))).rejects.toBeInstanceOf(BuckError);
  });
  it('refuses more entries than the limit',async()=>{
    const files=new Map(Array.from({length:LIMITS.entries-2},(_,i)=>[`ext/v/${i}.bin`,new Uint8Array([i])] as [string,Uint8Array]));
    await expect(writeBuck(graph,files)).rejects.toThrow(/höchstens 64/);
  });
  it('refuses a graph.json above 256 KiB',async()=>{
    await expect(writeBuck({...graph,meta:{...graph.meta,prompt:'x'.repeat(LIMITS.graphBytes)}},new Map())).rejects.toThrow(/256 KiB/);
  });
});

describe('buck reader rejects malicious archives before inflating',()=>{
  it('archive larger than 128 MiB',()=>rejects(new Uint8Array(LIMITS.archiveBytes+1),/128 MiB/));
  it('missing end record or trailing bytes after it',async()=>{
    await rejects(new Uint8Array(100),/ZIP-Endsatz/);
    await rejects(zip(valid(),{trailing:3}),/ZIP-Endsatz/);
  });
  it('more than 64 entries',()=>rejects(zip(valid(Array.from({length:63},(_,i)=>[`ext/v/${i}.bin`,new Uint8Array([i])]))),/66 Einträge/));
  it('compression method other than 0 and 8',()=>rejects(zip(edit(valid(),'luts/a.cube',{method:12,body:cube})),/Kompressionsmethode 12/));
  it('encryption flag',()=>rejects(zip(edit(valid(),'luts/a.cube',{flags:0x801})),/verschlüsselt/));
  it('unsupported flag bits',()=>rejects(zip(edit(valid(),'luts/a.cube',{flags:0x820})),/nicht unterstützte ZIP-Flags/));
  it('ZIP64 markers in the end record, the version field or an extra field',async()=>{
    await rejects(zip(valid(),{eocd:v=>{v.setUint16(8,0xffff,true);v.setUint16(10,0xffff,true);}}),/ZIP64/);
    await rejects(zip(edit(valid(),'luts/a.cube',{versionNeeded:45})),/ZIP64/);
    const extra=new Uint8Array(20),ev=new DataView(extra.buffer);ev.setUint16(0,1,true);ev.setUint16(2,16,true);
    await rejects(zip(edit(valid(),'luts/a.cube',{extra})),/ZIP64/);
  });
  it('Info-ZIP unicode path extra field that could rename an entry',async()=>{
    const extra=new Uint8Array(4),ev=new DataView(extra.buffer);ev.setUint16(0,0x7075,true);
    await rejects(zip(edit(valid(),'luts/a.cube',{extra})),/Unicode-Dateiname/);
  });
  it('malformed extra field',()=>rejects(zip(edit(valid(),'luts/a.cube',{extra:new Uint8Array([1,2,3])})),/Zusatzfeld/));
  it('multi-disk archives',()=>rejects(zip(valid(),{eocd:v=>v.setUint16(4,1,true)}),/Mehrteilige/));
  it('non-ASCII names without the UTF-8 flag and invalid UTF-8',async()=>{
    await rejects(zip(edit(valid(),'luts/a.cube',{flags:0,rawName:new Uint8Array([...u8('luts/'),0xe4,...u8('.cube')])})),/UTF-8 \(Flag Bit 11\) oder ASCII/);
    await rejects(zip(edit(valid(),'luts/a.cube',{rawName:new Uint8Array([...u8('luts/'),0xff,...u8('.cube')])})),/kein gültiges UTF-8/);
  });
  it.each([
    ['../evil.cube',/„\.\.“/],['luts/../graph.json',/„\.\.“/],['/luts/a.cube',/absoluter Pfad/],['luts\\a.cube',/Backslash/],['C:/luts/a.cube',/Laufwerksbuchstaben/],
    ['luts/Ä.cube',/Zeichen außerhalb/],['LUTS/a.cube',/Zeichen außerhalb/],['luts//a.cube',/leere Pfadsegmente/],['scripts/run.js',/nicht erlaubt/],['luts/sub/a.cube',/nicht erlaubt/],['thumbs/evil.svg',/nicht erlaubt/],
  ])('path %s',(name,message)=>rejects(zip(edit(valid(),'luts/a.cube',{name})),message));
  it('duplicate names',()=>rejects(zip([...valid(),{name:'luts/a.cube',data:cube}]),/doppelt/));
  it('symbolic links and other non-regular files in external attributes',async()=>{
    await rejects(zip(edit(valid(),'luts/a.cube',{external:(0o120777<<16)>>>0})),/symbolischer Link/);
    await rejects(zip(edit(valid(),'luts/a.cube',{madeBy:0x1314,external:(0o120755<<16)>>>0})),/symbolischer Link/);
    await rejects(zip(edit(valid(),'luts/a.cube',{madeBy:0x0a14,external:0x400})),/symbolischer Link/);
    await rejects(zip(edit(valid(),'luts/a.cube',{external:(0o060644<<16)>>>0})),/keine reguläre Datei/);
  });
  it('directory entries',()=>rejects(zip(edit(valid(),'luts/a.cube',{madeBy:0x0014,external:0x10})),/Verzeichniseintrag/));
  it('declared uncompressed size above 64 MiB',()=>rejects(zip(edit(valid(),'luts/a.cube',{usize:LIMITS.entryBytes+1})),/größer als 64 MiB/));
  it('declared compression ratio above 100:1',()=>rejects(zip(edit(valid(),'luts/a.cube',{usize:cube.length*1000})),/Kompressionsverhältnis/));
  it('stored entries whose sizes differ',()=>rejects(zip(edit(valid(),'luts/a.cube',{method:0,usize:cube.length-1})),/Größen stimmen nicht/));
  it('local and central header mismatch',async()=>{
    await rejects(zip(edit(valid(),'luts/a.cube',{local:{name:'luts/b.cube'}})),/stimmen nicht überein/);
    await rejects(zip(edit(valid(),'luts/a.cube',{local:{method:0}})),/stimmen nicht überein/);
    await rejects(zip(edit(valid(),'luts/a.cube',{local:{crc:1}})),/stimmen nicht überein/);
    await rejects(zip(edit(valid(),'luts/a.cube',{local:{zeroSizes:true}})),/stimmen nicht überein/);
  });
  it('hidden data between entries',()=>rejects(zip(valid(),{gapAfterFirst:7}),/nicht verzeichnete Daten/));
  it('overlapping entries (overlap zip bomb)',async()=>{
    // A stored entry whose payload is a complete second local record; the central directory lists both.
    const inner=zip([{name:'luts/b.cube',data:cube,method:0}]),innerLocal=inner.subarray(0,30+'luts/b.cube'.length+cube.length);
    const entries=edit(edit(valid([['luts/a.cube',innerLocal],['luts/b.cube',cube]]),'luts/a.cube',{method:0}),'luts/b.cube',{method:0});
    await rejects(zip(entries,{embed:{entry:4,host:3}}),/überlappt/);
  });
  it('mimetype not first, compressed or with wrong content',async()=>{
    const [mime,...rest]=valid();
    await rejects(zip([rest[0],mime,...rest.slice(1)]),/erste Eintrag/);
    await rejects(zip([{...mime,method:8},...rest]),/unkomprimiert/);
    await rejects(zip([{...mime,extra:new Uint8Array([0x55,0x54,0,0])},...rest]),/ohne Zusatzfeld/);
    await rejects(zip([{...mime,data:u8(BUCK_MIMETYPE+'\n')},...rest]),/genau/);
  });
});

describe('buck reader verifies contents after inflating',()=>{
  it('actual size above or below the declared size',async()=>{
    await rejects(zip(edit(valid(),'luts/a.cube',{usize:cube.length-1,crc:crc32(cube)})),/größer als angegeben/);
    await rejects(zip(edit(valid(),'luts/a.cube',{usize:cube.length+1,crc:crc32(cube)})),/kleiner als angegeben/);
  });
  it('CRC-32 mismatch',()=>rejects(zip(edit(valid(),'luts/a.cube',{crc:crc32(cube)^1})),/CRC-32/));
  it('corrupt deflate data',()=>rejects(zip(edit(valid(),'luts/a.cube',{body:deflateSync(cube).subarray(0,5)})),/nicht lesbar komprimiert/));
  it('missing manifest.json or graph.json',async()=>{
    await rejects(zip(valid().filter(e=>e.name!=='manifest.json')),/„manifest\.json“ fehlt/);
    await rejects(zip(valid([],[]).filter(e=>e.name!=='graph.json')),/„graph\.json“ fehlt/);
  });
  it('malformed manifest',async()=>{
    await rejects(zip(edit(valid(),'manifest.json',{data:u8('{')})),/kein gültiges JSON/);
    await rejects(zip(edit(valid(),'manifest.json',{data:u8('{"buckManifest":2,"files":[]}')})),/nicht die Form/);
    await rejects(zip(edit(valid(),'manifest.json',{data:u8('{"buckManifest":1,"files":[],"script":"x"}')})),/unbekannte Feld „script“/);
  });
  it('manifest entry with bad fields or listing reserved files',async()=>{
    const g=u8(JSON.stringify(graph)),good={path:'graph.json',size:g.length,sha256:sha(g),mediaType:'application/json'},c={path:'luts/a.cube',size:cube.length,sha256:sha(cube),mediaType:'text/plain'};
    await rejects(zip(valid(undefined,[good,{...c,sha256:sha(cube).toUpperCase()}])),/64 Hex-Zeichen/);
    await rejects(zip(valid(undefined,[good,c,{path:'mimetype',size:1,sha256:sha(cube),mediaType:'text/plain'}])),/darf nicht in „manifest\.json“/);
    await rejects(zip(valid(undefined,[good,c,c])),/doppelt in „manifest\.json“/);
    await rejects(zip(valid(undefined,[good,{...c,url:'https://x'}])),/unbekannte Feld „url“/);
  });
  it('file listed in the manifest but missing, or present but not listed',async()=>{
    const g=u8(JSON.stringify(graph)),good={path:'graph.json',size:g.length,sha256:sha(g),mediaType:'application/json'};
    await rejects(zip(valid(undefined,[good])),/„luts\/a\.cube“ fehlt in „manifest\.json“/);
    await rejects(zip(valid(undefined,[good,{path:'luts/a.cube',size:cube.length,sha256:sha(cube),mediaType:'text/plain'},{path:'luts/b.cube',size:1,sha256:sha(cube),mediaType:'text/plain'}])),/fehlt aber im Archiv/);
  });
  it('hash or size mismatch against the manifest',async()=>{
    const g=u8(JSON.stringify(graph)),good={path:'graph.json',size:g.length,sha256:sha(g),mediaType:'application/json'};
    await rejects(zip(valid(undefined,[good,{path:'luts/a.cube',size:cube.length,sha256:sha(u8('other')),mediaType:'text/plain'}])),/SHA-256/);
    await rejects(zip(valid(undefined,[good,{path:'luts/a.cube',size:cube.length+1,sha256:sha(cube),mediaType:'text/plain'}])),/Größe von „luts\/a\.cube“/);
  });
  it('graph.json above 256 KiB, before parsing',async()=>{
    let called=false;const big=u8(' '.repeat(LIMITS.graphBytes+1));
    const entries=edit(valid([]),'graph.json',{data:big,method:0}),manifest={buckManifest:1,files:[{path:'graph.json',size:big.length,sha256:sha(big),mediaType:'application/json'}]};
    const error=await readBuck(zip(edit(entries,'manifest.json',{data:u8(JSON.stringify(manifest))})),{parse:t=>{called=true;return parse(t);}}).catch((e:unknown)=>e);
    expect((error as Error).message).toMatch(/256 KiB/);expect(called).toBe(false);
  });
  it('propagates parser errors unchanged',async()=>{
    const error=await readBuck(await writeBuck(graph,new Map()),{parse:()=>{throw new BuckError('Knoten unbekannt.');}}).catch((e:unknown)=>e);
    expect((error as Error).message).toBe('Knoten unbekannt.');
  });
});
