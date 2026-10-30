import { clamp } from './spaces';
import type { RGB } from './spaces';
/** Six tetrahedra sharing the 000–111 diagonal. Sort fractional coordinates to choose one. */
export function sampleCube(data:Float32Array,n:number,c:RGB):RGB {
  const pos=c.map(v=>clamp(v)*(n-1)),base=pos.map(v=>Math.min(n-2,Math.floor(v))),f=pos.map((v,i)=>v-base[i]);
  const order=[0,1,2].sort((a,b)=>f[b]-f[a]),p=[...base];
  const idx=()=>((p[2]*n+p[1])*n+p[0])*3;
  const indices=[idx()];for(const axis of order){p[axis]++;indices.push(idx());}
  const weights=[1-f[order[0]],f[order[0]]-f[order[1]],f[order[1]]-f[order[2]],f[order[2]]];
  return [0,1,2].map(channel=>weights.reduce((sum,w,i)=>sum+w*data[indices[i]+channel],0)) as RGB;
}
