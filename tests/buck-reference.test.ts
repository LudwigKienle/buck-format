import { describe, expect, it } from 'vitest';
import { colorValueToRGB } from '../src/buck/colorspace';
import { scalarField } from '../src/buck/field';
import { TOD_PREFIX, emptyGraph, removeTimeOfDay, timeOfDayOf } from '../src/buck/prompt';
import { renderGraph } from '../src/buck/render';
import { analyzeReference } from '../src/buck/reference/analyze';
import type { AspectId, ReferenceReport } from '../src/buck/reference/analyze';
import { CONTRAST_TRANSFER, LUT_SIZE, REFERENCE_LUT, buildReferenceGraph, moderateTone, placeMoon } from '../src/buck/reference/build';
import { miredDiff, prepareWork, rgbToKelvin } from '../src/buck/reference/common';
import { grayWorld } from '../src/buck/reference/light';
import { LOOKS, syntheticScene } from '../src/buck/reference/synthetic';
import type { SceneContent } from '../src/buck/reference/synthetic';
import { skyRegion } from '../src/buck/reference/timeofday';
import type { ImageBuf, ScalarField, SkyPreset } from '../src/buck/types';
import { checkGraph } from '../src/buck/validate';

/**
 * Invariance test set of the reference analysis (docs/REFERENCE_ANALYSIS.md): deterministic procedural scenes
 * (src/buck/reference/synthetic.ts) in several looks. Same content + different look → the analysis tells the looks apart;
 * different content + same look → similar parameters within the documented tolerances; a large red wall (material color)
 * must not move the estimated light color much. Exact synthetic depth stands in for a depth model ('model').
 */
const DISPLAY='Rec.1886 Rec.709 - Display' as const;
const DARK:SkyPreset[]=['night','starry-night','moonrise','twilight','aurora','neon-night'];
/** Tolerances (documented in docs/REFERENCE_ANALYSIS.md). */
const TOL={miredSameLook:25,miredRedWall:20,azimuthDeg:40,hazeDensityFactor:2.5};
/** Analyses take ~0.3–1 s each and the machine is often loaded: every block gets its own generous timeout. */
const HEAVY={timeout:120_000};
const scenes=new Map<string,{image:ImageBuf;depth:ScalarField}>();
function scene(content:SceneContent,look:string,redWall=false){
  const key=`${content}-${look}-${redWall}`;let s=scenes.get(key);
  if(!s){s=syntheticScene(content,{...LOOKS[look],redWall});scenes.set(key,s);}
  return s;
}
const reports=new Map<string,ReferenceReport>();
/** Reference = content/look, source = content B in daylight (or `src`). */
function analyse(content:SceneContent,look:string,opts:{redWall?:boolean;src?:{image:ImageBuf;depth:ScalarField}}={}){
  const key=`${content}-${look}-${!!opts.redWall}-${opts.src?'custom':'B-day'}`;let r=reports.get(key);
  if(!r){
    const ref=scene(content,look,opts.redWall),src=opts.src??scene('B','day');
    r=analyzeReference({image:ref.image,depth:ref.depth,depthKind:'model'},{image:src.image,depth:src.depth,depthKind:'model'},{displaySpace:DISPLAY,srcEditorDepth:true});
    if(!opts.src)reports.set(key,r);
  }
  return r;
}
const aspect=(r:ReferenceReport,id:AspectId)=>{const a=r.aspects.find(x=>x.id===id);if(!a)throw new Error(`Aspekt ${id} fehlt`);return a;};

describe('Referenzanalyse – Grundlagen',HEAVY,()=>{
  it('rgbToKelvin trifft die Planck-Kurve der Knoten ({kelvin}) auf unter 1 % genau', ()=>{
    for(const k of [2000,2700,3200,4300,5600,6500,8000,12000]){
      const r=rgbToKelvin(colorValueToRGB({kelvin:k},'lin_rec709_srgb'));
      expect(Math.abs(r.kelvin-k)/k).toBeLessThan(.01);
      expect(Math.abs(r.duv)).toBeLessThan(.001);
    }
  });
  it('ist deterministisch: gleiche Eingabe, gleicher Plan', ()=>{
    const a=analyse('A','warm'),ref=scene('A','warm'),src=scene('B','day');
    const b=analyzeReference({image:ref.image,depth:ref.depth,depthKind:'model'},{image:src.image,depth:src.depth,depthKind:'model'},{displaySpace:DISPLAY,srcEditorDepth:true});
    expect(JSON.stringify(b.plan)).toBe(JSON.stringify(a.plan));
    expect(JSON.stringify(b.aspects)).toBe(JSON.stringify(a.aspects));
  });
  it('liefert je Aspekt Wert, Konfidenz 0…1, Begründung und Übertragbarkeit', ()=>{
    const r=analyse('A','night');
    expect(r.aspects.map(a=>a.id)).toEqual(['color','light','time','sky','haze','dof','direction','lamps']);
    for(const a of r.aspects){
      expect(a.confidence).toBeGreaterThanOrEqual(0);expect(a.confidence).toBeLessThanOrEqual(1);
      expect(a.value.length).toBeGreaterThan(0);expect(a.reason.length).toBeGreaterThan(10);expect(a.transferReason.length).toBeGreaterThan(5);
      expect(['hoch','mittel','niedrig']).toContain(a.level);
      if(a.defaultOn)expect(a.transferable).toBe(true);
    }
  });
});

describe('Gleicher Inhalt, verschiedener Look → Analyse unterscheidet die Looks',HEAVY,()=>{
  it('Lichtfarbe: warm < 4200 K, kalt > 6200 K, Abstand > 100 Mired', ()=>{
    const warm=analyse('A','warm').ref.light.kelvin,cold=analyse('A','cold').ref.light.kelvin,day=analyse('A','day').ref.light.kelvin;
    expect(warm).toBeLessThan(4200);expect(cold).toBeGreaterThan(6200);
    expect(miredDiff(warm,cold)).toBeGreaterThan(100);
    expect(day).toBeGreaterThan(warm);expect(day).toBeLessThan(cold);
  });
  it('Tageszeit: Nacht dunkel mit Belichtung, Tag klar ohne', ()=>{
    const night=analyse('A','night'),day=analyse('A','day'),warm=analyse('A','warm');
    expect(DARK).toContain(night.plan.time.preset);
    expect(night.plan.exposureEV).toBeLessThan(-2);
    expect(aspect(night,'time').defaultOn).toBe(true);
    expect(day.plan.time.preset).toBe('clear-day');
    expect(Math.abs(day.plan.exposureEV)).toBeLessThan(.3);
    expect(aspect(day,'time').defaultOn).toBe(false);
    expect(warm.plan.time.preset).toBe('golden-hour');
  });
  it('Dunst: nur der Dunst-Look schlägt Nebel vor', ()=>{
    const haze=analyse('A','haze');
    expect(aspect(haze,'haze').defaultOn).toBe(true);
    expect(haze.plan.fog!.density).toBeGreaterThan(1);
    expect(haze.plan.fog!.maxOpacity).toBeGreaterThan(.4);
    for(const look of ['day','warm','cold','dof'])expect(aspect(analyse('A',look),'haze').defaultOn,look).toBe(false);
  });
  it('Tiefenschärfe: nur der DOF-Look schlägt Unschärfe hinten vor', ()=>{
    const dof=analyse('A','dof');
    expect(aspect(dof,'dof').defaultOn).toBe(true);
    expect(dof.plan.dof!.blurFar).toBeGreaterThan(.008);
    expect(dof.plan.dof!.focus).toBeLessThan(.5);
    for(const look of ['day','warm','cold','haze'])expect(aspect(analyse('A',look),'dof').defaultOn,look).toBe(false);
  });
});

describe('Verschiedener Inhalt, gleicher Look → ähnliche Parameter',HEAVY,()=>{
  for(const look of ['warm','cold','day','night']){
    it(`${look}: Lichtfarbe innerhalb ${TOL.miredSameLook} Mired, gleiche Tageszeit-Familie`, ()=>{
      const rs=(['A','B','C'] as SceneContent[]).map(c=>analyse(c,look));
      const k=rs.map(r=>r.ref.light.kelvin);
      for(const a of k)for(const b of k)expect(miredDiff(a,b)).toBeLessThan(TOL.miredSameLook);
      const presets=rs.map(r=>r.plan.time.preset);
      if(look==='night')for(const p of presets)expect(DARK).toContain(p);else expect(new Set(presets).size).toBe(1);
    });
  }
  it(`Dunst: Dichte innerhalb Faktor ${TOL.hazeDensityFactor}, überall vorgeschlagen`, ()=>{
    const d=(['A','B','C'] as SceneContent[]).map(c=>{const r=analyse(c,'haze');expect(aspect(r,'haze').defaultOn).toBe(true);return r.plan.fog!.density;});
    expect(Math.max(...d)/Math.min(...d)).toBeLessThan(TOL.hazeDensityFactor);
  });
  it(`Lichtrichtung: Azimut innerhalb ${TOL.azimuthDeg}°, immer von links`, ()=>{
    const az=(['A','B','C'] as SceneContent[]).map(c=>analyse(c,'day').plan.direction!.azimuth);
    for(const a of az){expect(a).toBeLessThan(-20);for(const b of az)expect(Math.abs(a-b)).toBeLessThan(TOL.azimuthDeg);}
    // Honest limit: never „hoch“ with normals derived from relative depth.
    for(const c of ['A','B','C'] as SceneContent[])expect(aspect(analyse(c,'day'),'direction').confidence).toBeLessThanOrEqual(.65);
  });
});

describe('Licht von Materialfarbe trennen',HEAVY,()=>{
  it(`rote Wand verschiebt die geschätzte Lichtfarbe um weniger als ${TOL.miredRedWall} Mired (Gray World deutlich mehr)`, ()=>{
    for(const c of ['A','B','C'] as SceneContent[])for(const look of ['day','warm','cold']){
      const plain=analyse(c,look),wall=analyse(c,look,{redWall:true});
      const est=miredDiff(plain.ref.light.kelvin,wall.ref.light.kelvin);
      const gw=miredDiff(rgbToKelvin(grayWorld(plain.ref.work,plain.ref.sky.mask)).kelvin,rgbToKelvin(grayWorld(wall.ref.work,wall.ref.sky.mask)).kelvin);
      expect(est,`${c} ${look}`).toBeLessThan(TOL.miredRedWall);
      expect(gw,`${c} ${look}`).toBeGreaterThan(2*est);
      expect(wall.ref.light.materialShare).toBeGreaterThan(.15);
    }
  });
});

describe('Übertragbarkeit',HEAVY,()=>{
  it('ohne Himmel im Ausgangsbild ist der Himmel nicht übertragbar', ()=>{
    const s=scene('B','day'),W=s.image.width,y0=Math.ceil(s.image.height*.45),H=s.image.height-y0;
    const image:ImageBuf={...s.image,height:H,data:s.image.data.slice(y0*W*4)},depth=scalarField(W,H,s.depth.data.slice(y0*W));
    const r=analyse('A','night',{src:{image,depth}});
    const sky=aspect(r,'sky');
    expect(sky.transferable).toBe(false);expect(sky.defaultOn).toBe(false);
    expect(sky.transferReason).toMatch(/kein Himmel/);
    // Exposure still transfers.
    expect(aspect(r,'time').transferable).toBe(true);
  });
  it('flache Tiefe: Dunst und Tiefenschärfe „zu flach“', ()=>{
    const s=scene('B','day'),depth=scalarField(s.image.width,s.image.height,new Float32Array(s.image.width*s.image.height).fill(.5));
    for(let i=0;i<depth.data.length;i++)if(!Number.isFinite(s.depth.data[i]))depth.data[i]=Infinity;
    const r=analyse('A','haze',{src:{image:s.image,depth}});
    expect(aspect(r,'haze').transferable).toBe(false);expect(aspect(r,'haze').transferReason).toMatch(/zu flach/);
    expect(aspect(r,'dof').transferable).toBe(false);
  });
  it('Lampen: Referenz ohne Lampen → nicht übertragbar', ()=>{
    const a=aspect(analyse('A','day'),'lamps');
    expect(a.transferable).toBe(false);expect(a.transferReason).toMatch(/keine Lampen/);
  });
});

describe('Übernehmen → vollständiger .buck-Graph',HEAVY,()=>{
  it('Nacht-Referenz: CDL, Himmel und LUT, gültig, rendert dunkler', ()=>{
    const r=analyse('A','night'),src=scene('B','day');
    const selected=new Set(r.aspects.filter(a=>a.defaultOn&&a.transferable).map(a=>a.id));
    expect(selected.has('color')&&selected.has('time')&&selected.has('sky')).toBe(true);
    const b=buildReferenceGraph({base:emptyGraph('x'),report:r,selected,fileName:'nacht.png',source:src.image,sourceDepth:src.depth});
    expect(checkGraph(b.graph)).toEqual([]);
    expect(b.graph.meta.name).toBe('Referenz · nacht.png');
    const types=b.graph.nodes.map(n=>n.type);
    for(const t of ['color.cdl@1','sky.replace@1','color.lut3d@1'])expect(types).toContain(t);
    // The sky runs through the time-of-day switch: measured colors on tod-sky, „Wie aufgenommen“ removes it again.
    const sky=b.graph.nodes.find(n=>n.id===`${TOD_PREFIX}sky`);
    expect(sky?.type).toBe('sky.replace@1');
    expect(timeOfDayOf(b.graph)).toBe(r.plan.time.preset);
    if(sky?.type==='sky.replace@1')expect(sky.label).toMatch(/gemessen/);
    expect(b.graph.nodes.some(n=>n.id===`${TOD_PREFIX}exposure`||n.id===`${TOD_PREFIX}light`)).toBe(false);
    const asShot=removeTimeOfDay(b.graph);
    expect(asShot.nodes.some(n=>n.type==='sky.replace@1')).toBe(false);expect(checkGraph(asShot)).toEqual([]);
    // Level order: the LUT is the last image node before the output conversion.
    const users=b.graph.nodes.filter(n=>!n.id.startsWith('auto-')&&!n.type.startsWith('mask.'));
    expect(users[users.length-1].type).toBe('color.lut3d@1');
    const lut=b.graph.nodes.find(n=>n.type==='color.lut3d@1');
    expect(lut?.type==='color.lut3d@1'&&lut.params.file).toBe(REFERENCE_LUT);
    const text=new TextDecoder().decode(b.files.get(REFERENCE_LUT));
    expect(text).toContain(`LUT_3D_SIZE ${LUT_SIZE}`);expect(text.trim().split('\n').filter(l=>/^-?\d/.test(l)).length).toBe(LUT_SIZE**3);
    expect(Object.values(b.graph.inputs).some(d=>d.kind==='depth')).toBe(true);
    const out=renderGraph(b.graph,src.image,{frame:0,aux:{depth:src.depth,masks:{}},files:b.files});
    expect(out.bypassed).toEqual([]);
    const med=(img:ImageBuf)=>{const y:number[]=[];for(let i=0;i<img.data.length;i+=4)y.push(.2126*img.data[i]+.7152*img.data[i+1]+.0722*img.data[i+2]);y.sort((p,q)=>p-q);return y[y.length>>1];};
    expect(med(out.output as ImageBuf)).toBeLessThan(med(src.image)*.6);
  });
  it('nichts ausgewählt → gültiger Durchreiche-Graph ohne Dateien', ()=>{
    const r=analyse('A','day'),src=scene('B','day');
    const b=buildReferenceGraph({base:emptyGraph('x'),report:r,selected:new Set(),fileName:'tag.png',source:src.image,sourceDepth:src.depth});
    expect(checkGraph(b.graph)).toEqual([]);expect(b.files.size).toBe(0);
  });
  it('Dunst- und DOF-Look erzeugen Nebel- bzw. Tiefenschärfeknoten', ()=>{
    const src=scene('B','day');
    for(const [look,type] of [['haze','atmos.fog@1'],['dof','lens.dof@1']] as const){
      const r=analyse('A',look),selected=new Set(r.aspects.filter(a=>a.defaultOn&&a.transferable).map(a=>a.id));
      const b=buildReferenceGraph({base:emptyGraph('x'),report:r,selected,fileName:`${look}.png`,source:src.image,sourceDepth:src.depth});
      expect(checkGraph(b.graph)).toEqual([]);expect(b.graph.nodes.map(n=>n.type)).toContain(type);
    }
  });
  it('Kontrastübertragung ist begrenzt (Inhalt bestimmt Kontrast mit)', ()=>{
    const base={mean:[0,0] as [number,number],covariance:[.01,0,.01] as [number,number,number],count:1000,clipped:0,palette:[],lowInformation:false};
    const src={...base,quantiles:[.02,.05,.2,.4,.6,.85,.95]},ref={...base,quantiles:[.3,.32,.38,.45,.5,.55,.58]};
    const m=moderateTone(ref,src);
    expect(m.quantiles[3]).toBeCloseTo(.45,6);
    const spread=(q:number[])=>q[5]-q[1];
    expect(spread(m.quantiles)/spread(src.quantiles)).toBeGreaterThanOrEqual(CONTRAST_TRANSFER[0]-1e-9);
    for(let i=1;i<7;i++)expect(m.quantiles[i]).toBeGreaterThanOrEqual(m.quantiles[i-1]);
  });
  it('Mond rückt seitlich in den sichtbaren Himmel des Ausgangsbilds', ()=>{
    const s=scene('B','day'),work=prepareWork(s.image,s.depth,'model'),sky=skyRegion(work);
    // Mask out the right half of the sky (a "building"), the reference moon sits there.
    for(let i=0;i<sky.mask.length;i++)if(i%work.w>work.w*.5)sky.mask[i]=0;
    const m=placeMoon(.8,.1,.02,sky,work.w,work.h);
    expect(m.x).toBeLessThan(.5);expect(m.height).toBeCloseTo(.1,6);
  });
});
