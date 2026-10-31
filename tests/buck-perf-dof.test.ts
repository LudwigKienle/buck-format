import { describe, expect, it } from 'vitest';
import { dofNode } from '../src/buck/nodes/dof';
import { imageBuf, scalarField } from '../src/buck/field';
import type { DofParams, ImageBuf, Resolved, ScalarField } from '../src/buck/types';
type P=Resolved<DofParams>;
const base:P={mode:'artistic',focus:.3,focusRange:.1,blurNear:.02,blurFar:.02,maxBlur:.02,blades:0,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0};
/** Deterministic DOF scenes: a subject on a soft 3 px depth ramp, background ramp, near band, sparse highlights. */
function scene(W:number,H:number):{img:ImageBuf;depth:ScalarField} {
  const img=imageBuf(W,H,'ACEScg'),depth=scalarField(W,H);let s=12345;
  const rnd=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/2**32;};
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x,cx=x-W*.35,cy=y-H*.55,inside=cx*cx/(W*W*.02)+cy*cy/(H*H*.08)<1;
    const t=.5+.5*Math.sin(x*.21)*Math.cos(y*.17),n=rnd();
    img.data.set([inside?.25+.1*t:.6+.6*t+(n>.995?20:0),inside?.15:.5*t+.2,inside?.1:.9-.3*t,1],i*4);
    // Subject at .3 with a soft 3 px ramp (like estimated depth), background depth ramp to 1, a near band at the bottom.
    const e=Math.sqrt(cx*cx/(W*W*.02)+cy*cy/(H*H*.08)),ramp=Math.min(1,Math.max(0,(e-1)*12));
    depth.data[i]=y>H*.9?.05+.02*n:.3+ramp*(.4+.6*x/W);
  }
  return {img,depth};
}
const CASES:[string,Partial<P>][]=[
  ['far',{blurFar:.06,maxBlur:.06}],
  ['near+far hex boost',{blurNear:.05,blurFar:.08,maxBlur:.08,blades:6,rotation:15,bladeCurvature:.2,highlightBoost:1}],
  ['cat eye penta',{blurFar:.05,maxBlur:.05,blades:5,catEye:.8}],
  ['physical',{mode:'physical',focusDistance:.3,fNumber:1.4,focalLength:50,sensorWidth:36,maxBlur:.05}],
];
const params=(o:Partial<P>):P=>({...base,...o});
/** FNV-1a over the float32 bit patterns. */
function hash(a:Float32Array){const u=new Uint32Array(a.buffer,a.byteOffset,a.length);let h=0x811c9dc5;for(let i=0;i<u.length;i++){h^=u[i];h=Math.imul(h,16777619)>>>0;}return h.toString(16).padStart(8,'0');}

/**
 * Golden hashes of lens.dof@1 recorded with the implementation right after the halo fix and before the performance work
 * (lazy prefilter levels, packed per-pixel attributes, unclamped interior taps). Any change of a single output bit fails.
 */
const GOLDEN:Record<string,string>={
  '160x96 far':'876f40d1','160x96 near+far hex boost':'5080b74f','160x96 cat eye penta':'6b88fd3e','160x96 physical':'23fc4d7f',
  '97x61 far':'c8deb59b','97x61 near+far hex boost':'a5c0a60a','97x61 cat eye penta':'b7a2ffc6','97x61 physical':'ae75016b',
};
const ctx=(w:number,h:number)=>({width:w,height:h,frame:0,aux:{masks:{}},files:new Map<string,Uint8Array>(),workingLinear:'ACEScg' as const,warn:()=>{}});
describe('lens.dof@1 performance rewrite is bit-identical', () => {
  for(const [W,H] of [[160,96],[97,61]])for(const [name,o] of CASES){
    it(`${W}×${H} ${name}`, () => {
      const {img,depth}=scene(W,H),out=dofNode.evaluate({image:img,depth},params(o),ctx(W,H)) as ImageBuf;
      expect(hash(out.data)).toBe(GOLDEN[`${W}x${H} ${name}`]);
    });
  }
});
