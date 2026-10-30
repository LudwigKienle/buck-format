import { describe, expect, it } from 'vitest';
import { evalAnimatable, resolveParams } from '../src/buck/keyframes';
import { BuckError } from '../src/buck/types';
import type { FogParams, Keyframes } from '../src/buck/types';

const kf=(keys:[number,number][],interp:Keyframes['interp']):Keyframes=>({keys,interp});
const sample=(k:Keyframes,a:number,b:number,steps=400)=>Array.from({length:steps+1},(_,i)=>evalAnimatable(k,a+(b-a)*i/steps));

describe('evalAnimatable', () => {
  it('passes plain numbers through', () => {
    expect(evalAnimatable(0.25,100)).toBe(0.25);
  });
  it('interpolates linearly and holds the end values outside the keys', () => {
    const k=kf([[10,0],[20,1],[40,-1]],'linear');
    expect(evalAnimatable(k,0)).toBe(0);
    expect(evalAnimatable(k,15)).toBeCloseTo(0.5,12);
    expect(evalAnimatable(k,30)).toBeCloseTo(0,12);
    expect(evalAnimatable(k,40)).toBe(-1);
    expect(evalAnimatable(k,1e9)).toBe(-1);
  });
  it('hold keeps the previous key up to the next frame', () => {
    const k=kf([[0,1],[10,2],[20,3]],'hold');
    expect(evalAnimatable(k,9.999)).toBe(1);
    expect(evalAnimatable(k,10)).toBe(2);
    expect(evalAnimatable(k,19)).toBe(2);
    expect(evalAnimatable(k,25)).toBe(3);
  });
  it('smooth hits every key and matches the Fritsch–Carlson Hermite value', () => {
    const k=kf([[0,0],[1,1],[2,3]],'smooth');
    expect(evalAnimatable(k,0)).toBe(0);expect(evalAnimatable(k,1)).toBeCloseTo(1,12);expect(evalAnimatable(k,2)).toBe(3);
    // δ = [1, 2], tangents m = [1, 1.5, 2] (no limiting): h00·0 + h10·1 + h01·1 + h11·1.5 at t = 0.5.
    expect(evalAnimatable(k,0.5)).toBeCloseTo(0.125+0.5-0.1875,12);
  });
  it('smooth never overshoots at extrema and flat sections', () => {
    const k=kf([[0,0],[10,1],[20,1],[30,0],[45,0.5]],'smooth'),v=sample(k,-5,50);
    for(const x of v){expect(x).toBeGreaterThanOrEqual(0);expect(x).toBeLessThanOrEqual(1);}
    for(const x of sample(k,10,20))expect(x).toBeCloseTo(1,12);
    // Monotone on each monotone stretch of the data.
    const rise=sample(k,0,10),fall=sample(k,20,30);
    for(let i=1;i<rise.length;i++){expect(rise[i]).toBeGreaterThanOrEqual(rise[i-1]);expect(fall[i]).toBeLessThanOrEqual(fall[i-1]);}
  });
  it('smooth applies the α²+β² ≤ 9 limiter on steep neighbours', () => {
    // δ = [0.1, 9.9] gives α = 1, β = 50 on the first segment; unlimited Hermite would overshoot 0.1 there.
    const k=kf([[0,0],[1,0.1],[2,10]],'smooth'),first=sample(k,0,1),second=sample(k,1,2);
    for(let i=1;i<first.length;i++){expect(first[i]).toBeGreaterThanOrEqual(first[i-1]);expect(first[i]).toBeLessThanOrEqual(0.1+1e-12);}
    for(let i=1;i<second.length;i++)expect(second[i]).toBeGreaterThanOrEqual(second[i-1]);
  });
  it('two keys in smooth mode give the straight line', () => {
    const k=kf([[0,2],[8,4]],'smooth');
    for(let f=0;f<=8;f++)expect(evalAnimatable(k,f)).toBeCloseTo(2+f/4,12);
  });
  it('sorts keys and lets the last key of a duplicate frame win', () => {
    const k=kf([[20,2],[0,0],[10,5],[10,1]],'linear');
    expect(evalAnimatable(k,10)).toBe(1);
    expect(evalAnimatable(k,15)).toBeCloseTo(1.5,12);
    expect(k.keys[0]).toEqual([20,2]);
  });
  it('a single key is constant', () => {
    expect(evalAnimatable(kf([[5,0.7]],'smooth'),-3)).toBe(0.7);
    expect(evalAnimatable(kf([[5,0.7]],'smooth'),30)).toBe(0.7);
  });
  it('rejects malformed keyframes with BuckError', () => {
    expect(()=>evalAnimatable(kf([],'linear'),0)).toThrow(BuckError);
    expect(()=>evalAnimatable({keys:[[0,1]],interp:'cubic'} as unknown as Keyframes,0)).toThrow(/Interpolation/);
    expect(()=>evalAnimatable(kf([[0,Number.NaN]],'linear'),0)).toThrow(BuckError);
    expect(()=>evalAnimatable(kf([[0,1]],'linear'),Number.NaN)).toThrow(BuckError);
    expect(()=>evalAnimatable('x' as unknown as number,0)).toThrow(BuckError);
  });
  it('is deterministic', () => {
    const k=kf([[0,0.1],[7,0.9],[13,0.2],[30,0.25]],'smooth');
    expect(sample(k,0,30,97)).toEqual(sample(k,0,30,97));
  });
});

describe('resolveParams', () => {
  it('resolves nested keyframes, keeps arrays and enums, and does not mutate the input', () => {
    const p:FogParams&{nested:{list:(number|Keyframes)[]}}={
      model:'linear',start:kf([[0,0],[10,1]],'linear'),end:2,density:1,color:[0.1,0.2,0.3],luminance:kf([[0,-1],[10,1]],'hold'),
      maxOpacity:0.5,skyProtect:0,nested:{list:[1,kf([[0,4],[2,8]],'linear')]},
    };
    const before=JSON.stringify(p),r=resolveParams(p,5);
    expect(r).toEqual({model:'linear',start:0.5,end:2,density:1,color:[0.1,0.2,0.3],luminance:-1,maxOpacity:0.5,skyProtect:0,nested:{list:[1,8]}});
    expect(JSON.stringify(p)).toBe(before);
    expect(r.color).not.toBe(p.color);
  });
  it('leaves {kelvin} colors and objects without keyframes intact', () => {
    expect(resolveParams({color:{kelvin:3200},flag:true,name:'x'},3)).toEqual({color:{kelvin:3200},flag:true,name:'x'});
  });
});
