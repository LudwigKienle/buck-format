import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auxKey, exportBuckaux, importBuckaux, loadAux, saveAux } from '../src/buck/aux/cache';
import { EXR_MAGIC, floatToHalf, halfToFloat, readExr, writeExr } from '../src/buck/aux/exr';
import { PERCENTILE_SAMPLE_LIMIT, normalizeDepth, percentile } from '../src/buck/aux/normalize';
import { scalarField, vectorField } from '../src/buck/field';
import { BuckError } from '../src/buck/types';
import type { AuxChannels } from '../src/buck/types';

const field=(values:number[],width=values.length,height=1)=>scalarField(width,height,Float32Array.from(values));
const range=(n:number,f=(i:number)=>i)=>Array.from({length:n},(_,i)=>f(i));
const ascii=(b:Uint8Array,start:number,end:number)=>String.fromCharCode(...b.subarray(start,end));

describe('normalizeDepth (spec §6.2)',()=>{
  it('uses linear-interpolated percentiles (type 7)',()=>{
    const s=Float32Array.from([1,2,3,4]);
    expect(percentile(s,50)).toBeCloseTo(2.5,12);expect(percentile(s,25)).toBeCloseTo(1.75,12);
    expect(percentile(s,0)).toBe(1);expect(percentile(s,100)).toBe(4);
  });
  it('maps relative-depth with 2/98 percentiles and reports scale/shift',()=>{
    const r=normalizeDepth([field(range(101))],'relative-depth','shot-percentile');
    expect(r.scale).toBeCloseTo(1/96,9);expect(r.shift).toBeCloseTo(-2/96,9);
    const out=r.frames[0].data;
    expect(out[2]).toBeCloseTo(0,6);expect(out[50]).toBeCloseTo(0.5,6);expect(out[98]).toBeCloseTo(1,6);
    expect(out[0]).toBe(0);expect(out[100]).toBe(1);
  });
  it('inverts disparity so that large = near = 0 and marks x ≤ 0 and non-finite as +Infinity',()=>{
    const values=[...range(100,i=>i+1),0,-3,NaN,Infinity,-Infinity];
    const r=normalizeDepth([field(values)],'relative-inverse','shot-percentile',0,100);
    const out=r.frames[0].data;
    expect(out[99]).toBeCloseTo(0,6);expect(out[0]).toBeCloseTo(1,6);
    for(let i=100;i<105;i++)expect(out[i]).toBe(Infinity);
    for(let i=0;i<100;i++)expect(out[i]).toBeCloseTo(Math.min(1,Math.max(0,r.scale*values[i]+r.shift)),6);
    // 1 − (x − pLow)/(pHigh − pLow) with pLow = 1, pHigh = 100
    expect(out[49]).toBeCloseTo(1-(50-1)/99,6);
    expect(r.scale).toBeLessThan(0);
  });
  it('shares one scale across all frames of a shot; per-frame uses each frame and reports the last',()=>{
    const a=field(range(51)),b=field(range(51,i=>i+50));
    const shot=normalizeDepth([a,b],'relative-depth','shot-percentile',0,100);
    expect(shot.scale).toBeCloseTo(1/100,9);
    expect(shot.frames[0].data[50]).toBeCloseTo(0.5,6);expect(shot.frames[1].data[0]).toBeCloseTo(0.5,6);
    const per=normalizeDepth([a,b],'relative-depth','per-frame',0,100);
    expect(per.frames[0].data[50]).toBeCloseTo(1,6);expect(per.frames[1].data[0]).toBeCloseTo(0,6);
    expect(per.scale).toBeCloseTo(1/50,9);expect(per.shift).toBeCloseTo(-1,9);
    expect(a.data[50]).toBe(50);
  });
  it('leaves metric and mode "none" unchanged except invalid → +Infinity',()=>{
    for(const r of [normalizeDepth([field([0.5,12,NaN])],'metric','shot-percentile'),normalizeDepth([field([0.5,12,NaN])],'relative-inverse','none')]){
      expect(Array.from(r.frames[0].data)).toEqual([0.5,12,Infinity]);expect(r.scale).toBe(1);expect(r.shift).toBe(0);
    }
  });
  it('handles flat and empty fields and rejects bad percentiles',()=>{
    const flat=normalizeDepth([field([3,3,3])],'relative-depth','shot-percentile');
    expect(flat.scale).toBe(0);expect(Array.from(flat.frames[0].data)).toEqual([0,0,0]);
    const none=normalizeDepth([field([NaN,0])],'relative-inverse','shot-percentile');
    expect(Array.from(none.frames[0].data)).toEqual([Infinity,Infinity]);
    expect(()=>normalizeDepth([],'relative-depth','shot-percentile',50,50)).toThrow(BuckError);
    expect(()=>normalizeDepth([],'relative-depth','shot-percentile',-1,98)).toThrow(BuckError);
  });
  it('subsamples deterministically above the sample limit',()=>{
    const n=PERCENTILE_SAMPLE_LIMIT/2+250_000,mk=(o:number)=>scalarField(n,1,Float32Array.from({length:n},(_,i)=>((i*7919+o)%n)/n));
    const frames=[mk(0),mk(13)];
    const a=normalizeDepth(frames,'relative-depth','shot-percentile'),b=normalizeDepth(frames,'relative-depth','shot-percentile');
    expect(a.scale).toBe(b.scale);expect(a.shift).toBe(b.shift);
    // Uniform 0…1: pLow ≈ 0.02, pHigh ≈ 0.98.
    expect(-a.shift/a.scale).toBeCloseTo(0.02,3);expect(1/a.scale-a.shift/a.scale).toBeCloseTo(0.98,3);
  });
});

describe('half floats (Imath semantics)',()=>{
  it('converts known values with round-to-nearest-even',()=>{
    expect(floatToHalf(1)).toBe(0x3c00);expect(floatToHalf(-2)).toBe(0xc000);expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(2**-14)).toBe(0x0400);expect(floatToHalf(2**-24)).toBe(0x0001);expect(floatToHalf(-0)).toBe(0x8000);
    expect(floatToHalf(1+2**-11)).toBe(0x3c00);expect(floatToHalf(1+3*2**-11)).toBe(0x3c02);
    expect(floatToHalf(65520)).toBe(0x7c00);expect(floatToHalf(Infinity)).toBe(0x7c00);expect(floatToHalf(-Infinity)).toBe(0xfc00);
    expect(floatToHalf(1e-9)).toBe(0);
    const nan=floatToHalf(NaN);expect(nan&0x7c00).toBe(0x7c00);expect(nan&0x3ff).not.toBe(0);
    expect(halfToFloat(0x3555)).toBe(0.333251953125);expect(halfToFloat(0x0001)).toBe(2**-24);
    expect(halfToFloat(0x7c00)).toBe(Infinity);expect(halfToFloat(0xfc00)).toBe(-Infinity);expect(halfToFloat(0x7e00)).toBeNaN();
    expect(Object.is(halfToFloat(0x8000),-0)).toBe(true);
  });
  it('round-trips every non-NaN half exactly',()=>{
    for(let h=0;h<65536;h++){if((h&0x7c00)===0x7c00&&(h&0x3ff))continue;expect(floatToHalf(halfToFloat(h))).toBe(h);}
  });
});

describe('OpenEXR writer/reader',()=>{
  it('writes the documented header layout and offset table',()=>{
    const b=writeExr(field(range(12,i=>i/12),4,3)),v=new DataView(b.buffer);
    expect(Array.from(b.subarray(0,8))).toEqual([0x76,0x2f,0x31,0x01,2,0,0,0]);
    expect(v.getInt32(0,true)).toBe(EXR_MAGIC);
    expect(ascii(b,8,24)).toBe('channels\0chlist\0');
    expect(v.getInt32(24,true)).toBe(19);
    expect(ascii(b,28,30)).toBe('Z\0');expect(v.getInt32(30,true)).toBe(2);expect(v.getInt32(38,true)).toBe(1);expect(v.getInt32(42,true)).toBe(1);
    // Same attribute sequence as the official sample file (4×3, NO_COMPRESSION): its header ends at byte 295 with
    // two channels (chlist 37 bytes); ours has one channel (19 bytes) → 277, then 3 offsets → first block at 301.
    const order=['compression','dataWindow','displayWindow','lineOrder','pixelAspectRatio','screenWindowCenter','screenWindowWidth'];
    let p=47;for(const name of order){expect(ascii(b,p,p+name.length)).toBe(name);p+=name.length+1;while(b[p]!==0)p++;p++;p+=4+v.getInt32(p,true);}
    expect(b[p]).toBe(0);expect(p+1).toBe(277);
    expect([0,1,2].map(i=>Number(v.getBigUint64(277+8*i,true)))).toEqual([301,325,349]);
    expect(v.getInt32(301,true)).toBe(0);expect(v.getInt32(305,true)).toBe(16);expect(b.length).toBe(301+3*24);
    expect(v.getFloat32(309+4,true)).toBeCloseTo(1/12,7);
  });
  it('round-trips FLOAT exactly including +Infinity, NaN and -0',()=>{
    const src=field([0,-0,1/3,Infinity,NaN,1e-40,-5.5,3e38],4,2),back=readExr(writeExr(src));
    expect(back.kind).toBe('scalar');expect(back.width).toBe(4);expect(back.height).toBe(2);
    src.data.forEach((x,i)=>expect(Object.is(back.data[i],x)).toBe(true));
  });
  it('round-trips HALF normals with N.X/N.Y/N.Z in alphabetical file order',()=>{
    const data=Float32Array.from([0.1,-0.7,0.7, 1,0,0, 0,1/3,-1, Infinity,NaN,-0]);
    const src=vectorField(2,2,data),bytes=writeExr(src),back=readExr(bytes);
    expect(bytes.length).toBe(writeExr(src,{half:false}).length-2*2*3*2);
    expect(back.kind).toBe('vector3');
    data.forEach((x,i)=>{const e=halfToFloat(floatToHalf(x));if(Number.isNaN(e))expect(back.data[i]).toBeNaN();else expect(Object.is(back.data[i],e)).toBe(true);});
    // Component 0 named N.Y: stored after N.X, read back as Y.
    const swapped=readExr(writeExr(vectorField(1,1,Float32Array.from([1,2,3])),{half:false,channels:['N.Y','N.X','N.Z']}));
    expect(Array.from(swapped.data)).toEqual([2,1,3]);
    const order=new TextDecoder().decode(writeExr(src).subarray(0,80));
    expect(order.indexOf('N.X')).toBeLessThan(order.indexOf('N.Y'));expect(order.indexOf('N.Y')).toBeLessThan(order.indexOf('N.Z'));
  });
  it('rejects other profiles and damaged files',()=>{
    const good=writeExr(field([1,2,3,4],2,2));
    const at=(needle:string)=>{const s=ascii(good,0,good.length);return s.indexOf(needle);};
    const zip=good.slice();zip[at('compression\0compression\0')+28]=3;
    expect(()=>readExr(zip)).toThrow(/ZIP/);
    const tiled=good.slice();tiled[5]|=2;expect(()=>readExr(tiled)).toThrow(/Gekachelt/);
    const multi=good.slice();multi[5]|=0x10;expect(()=>readExr(multi)).toThrow(BuckError);
    const magic=good.slice();magic[0]=0;expect(()=>readExr(magic)).toThrow(/Magic/);
    expect(()=>readExr(good.subarray(0,good.length-1))).toThrow(BuckError);
    const uint=good.slice();new DataView(uint.buffer).setInt32(at('Z\0')+2,0,true);expect(()=>readExr(uint)).toThrow(/UINT/);
    const offset=good.slice(),tableAt=good.length-2*(8+8)-16;new DataView(offset.buffer).setUint32(tableAt,good.length,true);
    expect(()=>readExr(offset)).toThrow(/Offset/);
    const missing=good.slice();missing[at('lineOrder\0')]='x'.charCodeAt(0);expect(()=>readExr(missing)).toThrow(/lineOrder/);
    expect(()=>writeExr(field([1,2],2,2))).toThrow(BuckError);
    expect(()=>writeExr(field([1]),{channels:['Z','Y']})).toThrow(BuckError);
  });
});

describe('analysis cache',()=>{
  afterEach(()=>{delete (globalThis as {indexedDB?:unknown}).indexedDB;vi.resetModules();});
  it('auxKey hashes canonical JSON independent of key order',async()=>{
    const k=await auxKey({model:'vda-small-rel@1',low:2,file:'A001.mov'});
    expect(k).toBe(createHash('sha256').update('{"file":"A001.mov","low":2,"model":"vda-small-rel@1"}').digest('hex'));
    expect(await auxKey({file:'A001.mov',model:'vda-small-rel@1',low:2})).toBe(k);
    expect(await auxKey({file:'A001.mov',model:'vda-small-rel@1',low:3})).not.toBe(k);
    await expect(auxKey({a:NaN})).rejects.toThrow(BuckError);await expect(auxKey({})).rejects.toThrow(BuckError);
  });
  const sample=():AuxChannels=>({depth:field([0,0.5,1,Infinity],2,2),normals:vectorField(2,2,Float32Array.from(range(12,i=>(i%3)/3))),masks:{subject:field([0,0.25,0.5,1],2,2)}});
  it('saves and loads in memory without IndexedDB; entries are immutable copies',async()=>{
    const aux=sample(),key=await auxKey({shot:'memory'});
    expect(await loadAux(key)).toBeUndefined();
    await saveAux(key,aux,{scale:-0.5,shift:1});
    aux.depth!.data[0]=9;
    await saveAux(key,{masks:{}},{other:true});
    const got=await loadAux(key);
    expect(got!.meta).toEqual({scale:-0.5,shift:1});expect(got!.aux.depth!.data[0]).toBe(0);expect(got!.aux.depth!.data[3]).toBe(Infinity);
    got!.aux.masks.subject.data[0]=7;expect((await loadAux(key))!.aux.masks.subject.data[0]).toBe(0);
    await expect(saveAux(key,{depth:field([1,2],3,1),masks:{}},{})).rejects.toThrow(BuckError);
  });
  it('uses IndexedDB and adds its store to a database another module created',async()=>{
    const fake=fakeIndexedDB();fake.dbs.set('buckswood-buck',{version:3,stores:new Map([['models',new Map()]])});
    (globalThis as {indexedDB?:unknown}).indexedDB=fake.factory;
    const cache=await import('../src/buck/aux/cache');
    await cache.saveAux('k1',sample(),{n:1});await cache.saveAux('k1',{masks:{}},{n:2});
    const rec=fake.dbs.get('buckswood-buck')!;
    expect(rec.version).toBe(4);expect([...rec.stores.keys()].sort()).toEqual(['aux','models']);
    const got=await cache.loadAux('k1');
    expect(got!.meta).toEqual({n:1});expect(Array.from(got!.aux.masks.subject.data)).toEqual([0,0.25,0.5,1]);
    expect(await cache.loadAux('missing')).toBeUndefined();
  });
  it('falls back to memory when IndexedDB refuses to open',async()=>{
    (globalThis as {indexedDB?:unknown}).indexedDB={open(){const r:Record<string,unknown>={error:new Error('denied')};setTimeout(()=>(r.onerror as ()=>void)());return r;}};
    const cache=await import('../src/buck/aux/cache');
    await cache.saveAux('k',sample(),{});expect((await cache.loadAux('k'))!.aux.depth!.width).toBe(2);
  });
});

describe('.buckaux',()=>{
  const aux=():AuxChannels=>({depth:field([0,0.5,1,Infinity,0.25,0.75],3,2),normals:vectorField(3,2,Float32Array.from(range(18,i=>Math.sin(i)))),masks:{subject:field([0,1,0.5,0.1,0.2,0.3],3,2),sky:field([1,1,1,0,0,0],3,2)}});
  it('round-trips depth (float), normals (half) and masks with meta, deterministically',()=>{
    const src=aux(),meta={normalization:{scale:-0.0104,shift:1.02},model:'vda-small-rel@1',generator:'Buckswood Auto LUT'};
    const bytes=exportBuckaux(src,meta);
    expect(exportBuckaux(src,meta)).toEqual(bytes);
    const {aux:back,meta:m}=importBuckaux(bytes);
    expect(m).toEqual(meta);
    expect(Array.from(back.depth!.data)).toEqual(Array.from(src.depth!.data));
    expect(Array.from(back.normals!.data)).toEqual(Array.from(src.normals!.data,x=>halfToFloat(floatToHalf(x))));
    expect(Object.keys(back.masks).sort()).toEqual(['sky','subject']);
    expect(Array.from(back.masks.subject.data)).toEqual(Array.from(src.masks.subject.data));
    expect(importBuckaux(exportBuckaux({masks:{}},{})).aux).toEqual({masks:{}});
  });
  const auxJson=(channels:object)=>new TextEncoder().encode(JSON.stringify({buckaux:1,channels,meta:{}}));
  const depthExr=writeExr(field([1,2],2,1));
  it('rejects paths, extra or missing entries and inconsistent sizes',()=>{
    const ok={depth:{path:'depth.exr',width:2,height:1}};
    expect(importBuckaux(zipSync({'aux.json':auxJson(ok),'depth.exr':depthExr})).aux.depth!.width).toBe(2);
    expect(()=>importBuckaux(zipSync({'aux.json':auxJson(ok),'../depth.exr':depthExr}))).toThrow(/nicht erlaubt/);
    expect(()=>importBuckaux(zipSync({'aux.json':auxJson(ok),'/etc/passwd':depthExr}))).toThrow(/nicht erlaubt/);
    expect(()=>importBuckaux(zipSync({'aux.json':auxJson(ok),'depth.exr':depthExr,'normals.exr':depthExr}))).toThrow(/nicht verwendet/);
    expect(()=>importBuckaux(zipSync({'depth.exr':depthExr}))).toThrow(/aux\.json/);
    expect(()=>importBuckaux(zipSync({'aux.json':auxJson({depth:{path:'depth.exr',width:3,height:1}}),'depth.exr':depthExr}))).toThrow(/Größe/);
    expect(()=>importBuckaux(zipSync({'aux.json':auxJson({normals:{path:'normals.exr',width:2,height:1}}),'normals.exr':depthExr}))).toThrow(/Kanalzahl/);
    expect(()=>importBuckaux(zipSync({'aux.json':auxJson({depth:{path:'other.exr',width:2,height:1}}),'depth.exr':depthExr}))).toThrow(BuckError);
    expect(()=>importBuckaux(new Uint8Array(10))).toThrow(BuckError);
  });
  it('rejects compression bombs, oversized declarations and corrupt data',()=>{
    const bomb=new TextEncoder().encode(JSON.stringify({buckaux:1,channels:{},meta:{pad:' '.repeat(200_000)}}));
    expect(()=>importBuckaux(zipSync({'aux.json':bomb},{level:9}))).toThrow(/Kompressionsverhältnis/);
    const stored=zipSync({'aux.json':auxJson({depth:{path:'depth.exr',width:2,height:1}}),'depth.exr':depthExr},{level:0});
    const corrupt=stored.slice();corrupt[corrupt.length-200]^=0xff;
    expect(()=>importBuckaux(corrupt)).toThrow(/CRC-32/);
    const big=stored.slice(),v=new DataView(big.buffer),eocd=big.length-22,cd=v.getUint32(eocd+16,true);
    v.setUint32(cd+24,65*1024*1024,true);
    expect(()=>importBuckaux(big)).toThrow(/64 MiB/);
    const deep=new TextEncoder().encode(JSON.stringify({buckaux:1,channels:{},meta:JSON.parse('{"a":'.repeat(20)+'1'+'}'.repeat(20))}));
    expect(()=>importBuckaux(zipSync({'aux.json':deep}))).toThrow(/verschachtelt/);
  });
});

/** Minimal IndexedDB stand-in: versioned databases, upgrade callback, one request per transaction. */
function fakeIndexedDB(){
  type Rec={version:number;stores:Map<string,Map<string,unknown>>};
  const dbs=new Map<string,Rec>(),later=(f:()=>void)=>setTimeout(f,0);
  const makeDb=(rec:Rec)=>({
    get version(){return rec.version;},
    objectStoreNames:{contains:(n:string)=>rec.stores.has(n)},
    createObjectStore:(n:string)=>{rec.stores.set(n,new Map());},
    close(){},onversionchange:null as unknown,
    transaction(name:string){
      const store=rec.stores.get(name);if(!store)throw new Error('NotFoundError');
      const tx:Record<string,unknown>&{error:unknown}={error:null};let aborted=false;
      const finish=()=>later(()=>aborted?(tx.onabort as ()=>void)?.():(tx.oncomplete as ()=>void)?.());
      tx.objectStore=()=>({
        get(key:string){const r:Record<string,unknown>={};later(()=>{r.result=structuredClone(store.get(key));finish();});return r;},
        add(value:unknown,key:string){const r:Record<string,unknown>={};later(()=>{
          if(store.has(key)){r.error={name:'ConstraintError'};let prevented=false;(r.onerror as (e:object)=>void)?.({preventDefault(){prevented=true;}});if(!prevented){aborted=true;tx.error=r.error;}}
          else store.set(key,structuredClone(value));
          finish();});return r;},
      });
      return tx;
    },
  });
  const factory={open(name:string,version?:number){
    const r:Record<string,unknown>={};
    later(()=>{
      let rec=dbs.get(name);if(!rec){rec={version:0,stores:new Map()};dbs.set(name,rec);}
      const target=version??Math.max(1,rec.version);
      r.result=makeDb(rec);
      if(target>rec.version){rec.version=target;(r.onupgradeneeded as ()=>void)?.();}
      (r.onsuccess as ()=>void)();
    });
    return r;
  }};
  return{dbs,factory};
}
