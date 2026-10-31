import { describe, expect, it } from 'vitest';
import { imageBuf } from '../src/buck/field';
import { handleJob } from '../src/buck/render.worker';
import type { RenderDone, RenderJob, RenderReply } from '../src/buck/render.worker';
import { DRAFT_MIN_MS, DRAFT_MIN_PIXELS, downscaleImage, PREVIEW_SCALE, previewSize, RenderQueue, wantDraft } from '../src/buck/editor/useBuckRender';
import type { QueuedJob, WorkerLike } from '../src/buck/editor/useBuckRender';
import type { BuckGraph } from '../src/buck/types';

const CM={config:'ofx-native-v1.5_aces-v1.3_ocio-v2.3',input:'sRGB - Display' as const,output:'sRGB - Display' as const,working:{linear:'ACEScg' as const,display:'sRGB - Display' as const}};
const identity:BuckGraph={format:'buck',formatVersion:'1.0',minReaderVersion:'1.0',meta:{name:'T'},colorManagement:CM,inputs:{},models:{},output:'id',
  nodes:[{id:'id',type:'color.convert@1',inputs:{image:'$source'},params:{from:'sRGB - Display',to:'sRGB - Display'}}]};

describe('reduced preview (spec §10)', () => {
  it('halves the size (rounding up) and box-averages, edge blocks included', () => {
    expect(previewSize(1100,619,PREVIEW_SCALE)).toEqual([550,310]);
    expect(previewSize(1920,1080,PREVIEW_SCALE)).toEqual([960,540]);
    expect(previewSize(7,5,1)).toEqual([7,5]);
    const img=imageBuf(3,3,'sRGB - Display');for(let i=0;i<9;i++)img.data.set([i,2*i,0,1],i*4);
    const h=downscaleImage(img,.5);
    expect([h.width,h.height,h.space]).toEqual([2,2,'sRGB - Display']);
    expect(Array.from(h.data.slice(0,4))).toEqual([(0+1+3+4)/4,(0+2+6+8)/4,0,1]);
    expect(Array.from(h.data.slice(4,8))).toEqual([(2+5)/2,(4+10)/2,0,1]);
    expect(Array.from(h.data.slice(12,16))).toEqual([8,16,0,1]);
    expect(downscaleImage(img,1)).toBe(img);
  });
  it('drafts only for slow renders (or large images before the first timing)', () => {
    expect(wantDraft(1920,1080)).toBe(true);
    expect(wantDraft(256,256)).toBe(256*256>=DRAFT_MIN_PIXELS);
    expect(wantDraft(1920,1080,DRAFT_MIN_MS-1)).toBe(false);
    expect(wantDraft(400,300,DRAFT_MIN_MS)).toBe(true);
    expect(wantDraft(20,10,1e4)).toBe(false);
  });
  it('the worker renders the downscaled source and echoes the scale', () => {
    const src=imageBuf(4,2,'sRGB - Display');for(let i=0;i<8;i++)src.data.set([.5,.25,1,1],i*4);
    const half=downscaleImage(src,.5),job:RenderJob={jobId:1,graph:identity,source:{width:half.width,height:half.height,data:half.data,space:half.space},aux:{masks:{}},files:[],frame:0,scale:.5};
    const r=handleJob(job,undefined,()=>0).reply as RenderDone;
    expect([r.width,r.height,r.scale]).toEqual([2,1,.5]);
    expect((handleJob({...job,scale:undefined},undefined,()=>0).reply as RenderDone).scale).toBeUndefined();
  });
});

/** Fake worker: records posts, replies on demand. */
class FakeWorker implements WorkerLike {
  posted:RenderJob[]=[];terminated=false;
  onmessage:((e:MessageEvent<RenderReply>)=>void)|null=null;onerror:((e:ErrorEvent)=>void)|null=null;
  postMessage(job:RenderJob){this.posted.push(job);}
  terminate(){this.terminated=true;}
  reply(jobId:number){this.onmessage?.({data:{jobId,width:1,height:1,preview:new Uint8ClampedArray(4),warnings:[],bypassed:[],ms:1}} as unknown as MessageEvent<RenderReply>);}
}
const item=(jobId:number,gen:number,scale=1):QueuedJob=>({job:{jobId} as RenderJob,gen,scale});

describe('RenderQueue', () => {
  const setup=()=>{
    const workers:FakeWorker[]=[],got:[number,number][]=[];
    const q=new RenderQueue(()=>{const w=new FakeWorker();workers.push(w);return w;},(r,it)=>got.push([r.jobId,it.gen]),()=>got.push([-1,-1]));
    return {q,workers,got};
  };
  it('keeps only the newest job while a draft runs (throttling)', () => {
    const {q,workers,got}=setup();
    q.send(item(1,1,.5));q.send(item(2,2,.5));q.send(item(3,3,.5));
    expect(workers[0].posted.map(j=>j.jobId)).toEqual([1]);
    workers[0].reply(1);
    expect(workers[0].posted.map(j=>j.jobId)).toEqual([1,3]);
    workers[0].reply(3);
    expect(got).toEqual([[1,1],[3,3]]);expect(q.busy).toBe(false);
  });
  it('a draft is followed by the full job of the same generation', () => {
    const {q,workers}=setup();
    q.send(item(1,1,.5));q.send(item(2,1,1));
    workers[0].reply(1);expect(workers[0].posted.map(j=>j.jobId)).toEqual([1,2]);
  });
  it('terminates a stale full-resolution job and starts the new one at once', () => {
    const {q,workers,got}=setup();
    q.send(item(1,1,1));q.send(item(2,2,.5));
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].posted.map(j=>j.jobId)).toEqual([2]);
    workers[0].reply(1); // a late message of the terminated worker is ignored
    workers[1].reply(2);
    expect(got).toEqual([[2,2]]);
  });
  it('does not kill a full job for a newer job of the same generation', () => {
    const {q,workers}=setup();
    q.send(item(1,1,1));q.send(item(2,1,1));
    expect(workers).toHaveLength(1);expect(workers[0].terminated).toBe(false);
  });
  it('drops everything on a crash and respawns on the next job', () => {
    const {q,workers,got}=setup();
    q.send(item(1,1,1));q.send(item(2,1,1));
    workers[0].onerror?.({preventDefault(){}} as ErrorEvent);
    expect(got).toEqual([[-1,-1]]);expect(workers[0].terminated).toBe(true);
    q.send(item(3,2,1));expect(workers[1].posted.map(j=>j.jobId)).toEqual([3]);
  });
});
