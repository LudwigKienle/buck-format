import { analyze } from '../../color/analysis';
import type { Profile } from '../../color/analysis';
import type { SpaceId } from '../../color/spaces';
import { convertPixel } from '../colorspace';
import { SKY_PRESET_LABELS } from '../nodes/sky';
import type { ImageBuf, RGB, ScalarField, SkyPreset, SpaceName } from '../types';
import { clamp, confidenceLevel, de, deSigned, depthStats, hash01, lumaOf, miredDiff, prepareWork, quantile, r4, smooth } from './common';
import type { ConfidenceLevel, DepthKind, DepthStats, SkyRegion, Work } from './common';
import { fitLightDirection } from './direction';
import type { DirectionFit } from './direction';
import { fitFog, fogColor, hazeProfile } from './haze';
import { detectLamps } from './lamps';
import type { LampResult } from './lamps';
import { estimateLight } from './light';
import type { LightEstimate } from './light';
import { fitDof, sharpnessProfile } from './sharpness';
import type { DofFit } from './sharpness';
import { classifyTime, lightWarmth, measureSky, skyRegion } from './timeofday';
import type { SkyMeasure, TimeClass } from './timeofday';
/**
 * Reference analysis 2.0 (editor feature, not part of the .buck format): one reference image → per aspect a value, a
 * confidence 0…1, a short German reason and whether it transfers to the loaded source image. Local and deterministic;
 * the reference pixels never leave this module except as derived parameters (and the LUT built in build.ts).
 */
export type AspectId='color'|'light'|'time'|'sky'|'haze'|'dof'|'direction'|'lamps';
export const ASPECT_ORDER:AspectId[]=['color','light','time','sky','haze','dof','direction','lamps'];
export interface Aspect {
  id:AspectId;title:string;value:string;confidence:number;level:ConfidenceLevel;reason:string;
  transferable:boolean;transferReason:string;defaultOn:boolean;
}
export interface ImageInput {image:ImageBuf;depth?:ScalarField;depthKind:DepthKind;}
export interface ImageFacts {work:Work;sky:SkyRegion;light:LightEstimate;depthStats:DepthStats;medianY:number;}
/** Everything build.ts needs, colors in linear Rec.709 display light (converted to the working space there). */
export interface ReferencePlan {
  exposureEV:number;saturation:number;
  lightRef:RGB;lightSrc:RGB;lightKelvin:number;lightDuv:number;
  time:TimeClass;
  sky?:SkyMeasure;skyDepth?:number;
  fog?:{start:number;density:number;maxOpacity:number;color:RGB;luminance:number;skyProtect:number};
  dof?:DofFit;
  direction?:DirectionFit;
  lamps?:LampResult;
}
export interface ReferenceReport {aspects:Aspect[];plan:ReferencePlan;ref:ImageFacts;src:ImageFacts;}

function facts(input:ImageInput,source=false):ImageFacts{
  const work=prepareWork(input.image,input.depth,input.depthKind),sky=skyRegion(work,!source||work.depthKind==='heuristic'||work.depthKind==='none'),light=estimateLight(work,sky.mask);
  const ds=depthStats(work,sky.mask),medianY=quantile(work.Y,.5,i=>!sky.mask[i]);
  return {work,sky,light,depthStats:ds,medianY:Number.isFinite(medianY)?medianY:quantile(work.Y,.5)};
}
const DEPTH_NOTE:Record<DepthKind,string>={model:'Tiefe aus dem Modell',upload:'geladene Tiefenkarte',heuristic:'Behelfstiefe (Bildheuristik)',none:'ohne Tiefe'};
const depthFactor=(k:DepthKind)=>k==='heuristic'?.55:k==='none'?0:1;
const hex=(c:RGB)=>'#'+convertPixel(c.map(v=>Math.max(0,v)) as RGB,'lin_rec709_srgb','sRGB - Display').map(v=>Math.round(clamp(v)*255).toString(16).padStart(2,'0')).join('');
const SPACE_ID:Partial<Record<SpaceName,SpaceId>>={'Rec.1886 Rec.709 - Display':'rec709','sRGB - Display':'srgb'};
export const displaySpaceId=(s:SpaceName):SpaceId=>SPACE_ID[s]??'rec709';
/**
 * Work pixels as display code values (RGBA float) for src/color/analysis.ts. Pixels are dropped (alpha 0, which analyze
 * skips) with probability 1 − weight, by a fixed hash: weighted statistics without changing src/color.
 */
export function weightedPixels(work:Work,weights:Float32Array|undefined,display:SpaceName,seed=1){
  const n=work.w*work.h,out=new Float32Array(n*4);
  for(let i=0;i<n;i++){
    const c=convertPixel([work.rgb[i*3],work.rgb[i*3+1],work.rgb[i*3+2]],'lin_rec709_srgb',display);
    out[i*4]=clamp(c[0]);out[i*4+1]=clamp(c[1]);out[i*4+2]=clamp(c[2]);
    out[i*4+3]=!weights||hash01(i,seed)<Math.max(.15,weights[i])?1:0;
  }
  return out;
}
/** Material weights for the color match: the light-estimate weights, sky and clipped pixels at full weight again. */
export function colorWeights(f:ImageFacts){
  const n=f.work.w*f.work.h,w=new Float32Array(n);
  for(let i=0;i<n;i++)w[i]=f.light.weights[i]>0?f.light.weights[i]:1;
  return w;
}
function tendency(ref:Profile,src:Profile){
  const lin=(v:number)=>Math.max(1e-4,v)**2.4,key=Math.log2(lin(ref.quantiles[3])/lin(src.quantiles[3]));
  const con=(ref.quantiles[5]-ref.quantiles[1])/Math.max(.02,src.quantiles[5]-src.quantiles[1]);
  const sat=Math.sqrt((ref.covariance[0]+ref.covariance[2])/Math.max(1e-6,src.covariance[0]+src.covariance[2]));
  return {key,con,sat,text:`Key ${deSigned(key)} Blenden · Kontrast ×${de(con,2)} · Sättigung ×${de(sat,2)}`};
}
/** Sky threshold for the source: invalid depth → 2 (default), a sky found in the image over finite depth → its depth floor. */
function sourceSky(src:ImageFacts):{skyDepth?:number;reason:string}{
  const {sky,work}=src;
  if(sky.kind==='none')return {reason:work.depthKind==='model'||work.depthKind==='upload'?'Im Ausgangsbild wurde kein Himmel gefunden (die Tiefe hat keine ungültigen Werte).':'Im Ausgangsbild wurde kein Himmel gefunden.'};
  if(sky.kind==='depth')return {skyDepth:2,reason:`Himmel im Ausgangsbild: ${Math.round(sky.share*100)} % (ungültige Tiefe).`};
  if(work.depthKind==='none')return {reason:'Das Ausgangsbild hat noch keine Tiefe; ohne sie kann sky.replace@1 den Himmel nicht abgrenzen.'};
  const n=work.w*work.h,t=quantile(work.depth,.1,i=>sky.mask[i]===1);
  let fp=0,s=0;for(let i=0;i<n;i++){if(sky.mask[i])s++;else if(work.depth[i]>=t)fp++;}
  if(!Number.isFinite(t)||fp>.35*s)return {reason:'Der Himmel des Ausgangsbilds lässt sich mit dessen Tiefe nicht sauber abgrenzen (zu viel Fernes mit gleicher Tiefe).'};
  return {skyDepth:Math.round(clamp(t,.5,1)*100)/100,reason:`Himmel im Ausgangsbild: ${Math.round(sky.share*100)} % (im Bild gefunden, Grenze bei Tiefe ${de(t,2)} – mit echter Tiefe sauberer).`};
}

export function analyzeReference(refIn:ImageInput,srcIn:ImageInput,opts:{displaySpace:SpaceName;srcEditorDepth:boolean}):ReferenceReport{
  const ref=facts(refIn),src=facts(srcIn,true),aspects:Aspect[]=[],add=(a:Omit<Aspect,'level'>)=>aspects.push({...a,confidence:Math.round(clamp(a.confidence)*100)/100,level:confidenceLevel(a.confidence)});
  const spaceId=displaySpaceId(opts.displaySpace);
  // Color: auto-LUT tendency on material-weighted pixels (the LUT itself is fitted in build.ts after the other nodes).
  const pr=analyze(weightedPixels(ref.work,colorWeights(ref),opts.displaySpace),spaceId),ps=analyze(weightedPixels(src.work,colorWeights(src),opts.displaySpace),spaceId),t=tendency(pr,ps);
  add({id:'color',title:'Farbe (3D-LUT)',value:t.text,confidence:.85*(pr.lowInformation?.55:1)*(pr.clipped>.03?.85:1),
    reason:`Auto-LUT-Abgleich (Tonwertkurve aus Perzentilen, Farbmatrix aus Kovarianzen), eingebettet als 64³-LUT. Gerechnet wird gegen das Ausgangsbild nach den übrigen gewählten Knoten, damit nichts doppelt wirkt. Große gesättigte Materialflächen zählen weniger (Referenz ${Math.round(ref.light.materialShare*100)} %).`,
    transferable:true,transferReason:'Farbabgleich ist immer übertragbar.',defaultOn:true});
  // Light vs. material color.
  const md=miredDiff(ref.light.kelvin,src.light.kelvin);
  add({id:'light',title:'Lichtfarbe (von Materialfarbe getrennt)',value:`≈ ${ref.light.kelvin} K · Duv ${deSigned(ref.light.duv,3)} (Ausgangsbild ≈ ${src.light.kelvin} K)`,confidence:ref.light.confidence,
    reason:`Gray-Edge, White-Patch und großskalige Beleuchtung stimmen auf ${de(ref.light.spreadDeg)}° überein; ${Math.round(ref.light.materialShare*100)} % der Fläche als Materialfarbe heruntergewichtet. Wird als Weißabgleich (CDL im linearen Raum) übertragen.`,
    transferable:true,transferReason:md<12?'Lichtfarbe wie im Ausgangsbild – kaum Wirkung.':'Lichtfarbe wird von Ausgangs- auf Referenzlicht umgestimmt.',defaultOn:ref.light.confidence>=.4&&md>=12});
  // Haze profiles first: the haze amount also separates a sandstorm from a hazy golden hour.
  const flat=ref.depthStats.flat||src.depthStats.flat;
  const rp=hazeProfile(ref.work,ref.sky.mask),sp=hazeProfile(src.work,src.sky.mask),fit=flat?undefined:fitFog(rp,sp);
  // Time of day + scene exposure.
  const skyM=measureSky(ref.work,ref.sky),hasSky=!!skyM;
  const skyY=skyM?Math.sqrt(Math.max(1e-6,lumaOf(skyM.zenith))*Math.max(1e-6,lumaOf(skyM.horizon))):undefined;
  const warm=(c:RGB)=>Math.log(Math.max(1e-4,c[0])/Math.max(1e-4,c[2]));
  const time=classifyTime({skyEV:skyY!==undefined?Math.log2(skyY/.18):undefined,warmH:skyM?warm(skyM.horizon):undefined,warmZ:skyM?warm(skyM.zenith):undefined,
    sceneEV:Math.log2(Math.max(1e-5,ref.medianY)/.18),clouds:skyM?.clouds??0,stars:skyM?.stars??0,moon:!!skyM?.moon,moonHeight:skyM?.moon?.height,lightWarm:lightWarmth(ref.light.rgb),haze:fit?.amount??0,
    green:skyM?Math.max(skyM.zenith[1]/Math.max(skyM.zenith[0],skyM.zenith[2]),skyM.horizon[1]/Math.max(skyM.horizon[0],skyM.horizon[2])):0,
    magenta:skyM?Math.min(skyM.horizon[0],skyM.horizon[2])/Math.max(1e-4,skyM.horizon[1]):0},hasSky);
  const ev=Math.round(clamp(Math.log2(Math.max(1e-5,ref.medianY)/Math.max(1e-5,src.medianY)),-4,1.5)*10)/10;
  // Night grades desaturate (prompt.ts uses CDL saturation 0.75 for night); here measured: √ of the chroma ratio, 0.6…1.
  const saturation=ev<=-.7?Math.round(clamp(Math.sqrt(t.sat),.6,1)*100)/100:1;
  const dark=['night','starry-night','moonrise','twilight','blue-hour','storm','aurora','neon-night'].includes(time.preset);
  const label=(p:SkyPreset)=>SKY_PRESET_LABELS[p].label;
  add({id:'time',title:'Tageszeit & Belichtung',value:`${label(time.preset)} (2. Wahl: ${label(time.second)}) · Szene ${deSigned(ev)} EV gegenüber dem Ausgangsbild`,confidence:time.confidence,
    reason:`Nächster Prototyp aus ${hasSky?'Himmelshelligkeit, Himmelsfarbe am Horizont und im Zenit, ':'Lichtfarbe (kein Himmel in der Referenz), '}Szenenhelligkeit${hasSky?' und Wolkenstruktur':''}. Belichtung: Median der Nicht-Himmel-Luminanz, Referenz gegen Ausgangsbild.`,
    transferable:true,transferReason:ev<=-.7?`Szenenbelichtung ${deSigned(ev)} EV${saturation<.99?` und Sättigung ×${de(saturation,2)}`:''} im linearen Raum (Day-for-Night-Prinzip), vor Licht und Himmel.`:ev>=.7?'Die Referenz ist heller; das übernimmt die Tonwertkurve der LUT (keine zusätzliche Belichtung).':'Kein deutlicher Helligkeitsunterschied; den Rest übernimmt die LUT.',defaultOn:ev<=-.7||(dark&&ev<-.3)});
  // Sky.
  const ss=sourceSky(src);
  if(skyM){
    const extras=[skyM.clouds>.12?`Wolken ${Math.round(skyM.clouds*100)} %`:'',skyM.stars>.05?`Sterne ${Math.round(skyM.stars*100)} %`:'',skyM.moon?'Mond':''].filter(Boolean).join(', ');
    add({id:'sky',title:'Himmel',value:`${label(time.preset)} · Zenit ${hex(skyM.zenith)} · Horizont ${hex(skyM.horizon)}${extras?' · '+extras:''}`,confidence:(ref.sky.kind==='depth'?.85:.65)*smooth(.02,.08,ref.sky.share)*(ss.skyDepth===undefined||ss.skyDepth===2?1:.6),
      reason:`Himmel der Referenz: ${Math.round(ref.sky.share*100)} % der Fläche (${ref.sky.kind==='depth'?'ungültige Tiefe':'im Bild gefunden'}); Farben als Median je Kanal gemessen, Sterne und Mond gezählt bzw. geortet. Prozeduraler Himmel mit diesen Farben statt nur mit dem Preset (Kategorie „${label(time.preset)}“ liefert nur die übrigen Vorgaben). Konfidenz = Güte der Himmelsmessung.`,
      transferable:ss.skyDepth!==undefined,transferReason:ss.reason+(ss.skyDepth!==undefined&&ss.skyDepth<2?' Darum nicht vorausgewählt: Kanten zum Himmel werden mit der Behelfstiefe sichtbar unsauber.':''),defaultOn:ss.skyDepth===2&&ref.sky.share>=.03});
  }else add({id:'sky',title:'Himmel',value:'kein Himmel in der Referenz',confidence:0,reason:'In der Referenz wurde keine Himmelsfläche gefunden (weder ungültige Tiefe noch eine glatte Fläche am oberen Rand).',
    transferable:false,transferReason:'Ohne Himmel in der Referenz gibt es nichts zu übertragen.',defaultOn:false});
  // Haze.
  let fog:ReferencePlan['fog'];
  if(fit){
    const {color,luminance}=fogColor(rp.A);
    const skyHaze=skyM?Math.abs(Math.log(lumaOf(skyM.horizon)/lumaOf(rp.A)))<.5&&Math.abs(warm(skyM.horizon)-warm(rp.A))<.15:false;
    fog={start:fit.start,density:fit.density,maxOpacity:fit.maxOpacity,color,luminance,skyProtect:skyHaze?0:.3};
  }
  const hazeConf=fit?clamp(Math.sqrt(fit.r2))*clamp(fit.amount/.25)*depthFactor(ref.work.depthKind):0;
  add({id:'haze',title:'Dunst',value:fit?(fit.amount<.06?'kein zusätzlicher Dunst gegenüber dem Ausgangsbild':`+${Math.round(fit.amount*100)} % Deckkraft in der Ferne · Beginn ${de(fit.start,2)} · Dichte ${de(fit.density,2)} · Farbe ${hex(rp.A)}`):flat?'nicht messbar':'zu wenig Tiefenstufen',
    confidence:hazeConf,reason:`Dark-Channel-Prior je Tiefenstufe (${DEPTH_NOTE[ref.work.depthKind]}), Referenz minus Ausgangsbild, angepasst an das Modell von atmos.fog@1${fit?` (R² ${de(fit.r2,2)})`:''}. Farbe = Luftlicht nach He et al.`,
    transferable:!flat&&!!fit,transferReason:flat?`Szene zu flach für Dunst (${ref.depthStats.flat?'Referenz':'Ausgangsbild'}: zu wenig Tiefenumfang oder keine Tiefe).`:fit?'Dunst wird über die Tiefe des Ausgangsbilds aufgebaut.':'Zu wenige belegte Tiefenstufen.',
    defaultOn:!flat&&!!fit&&fit.amount>=.06&&hazeConf>=.35});
  // Depth of field.
  const dof=flat?undefined:fitDof(sharpnessProfile(ref.work,ref.sky.mask),sharpnessProfile(src.work,src.sky.mask),ref.work.w);
  const dofConf=dof?clamp(dof.textured*1.1)*(.35+.65*dof.evidence)*depthFactor(ref.work.depthKind):0;
  const blurry=!!dof&&dof.evidence>=.35&&(dof.blurFar>=.002||dof.blurNear>=.002);
  if(dof&&!blurry){dof.blurNear=0;dof.blurFar=0;}
  add({id:'dof',title:'Tiefenschärfe',value:dof?(blurry?`Fokus bei Tiefe ${de(dof.focus,2)} (±${de(dof.focusRange/2,2)}) · Unschärfe vorn ${de(dof.blurNear*100,2)} % · hinten ${de(dof.blurFar*100,2)} % der Bildbreite`:'keine zusätzliche Unschärfe erkennbar'):flat?'nicht messbar':'zu wenig Textur',
    confidence:dofConf,reason:`Feindetail-Anteil (|Y−G₁Y| / |Y−G₄Y|) je Tiefenstufe, über eine Kalibrierkurve in Gauß-Unschärfe umgerechnet, Referenz gegen Ausgangsbild. ${dof&&dof.textured<.7?'Wenig Textur in Teilen der Tiefe – Konfidenz reduziert.':''}`.trim(),
    transferable:!flat&&!!dof,transferReason:flat?'Szene zu flach für Tiefenschärfe (zu wenig Tiefenumfang).':dof?'Unschärfe über die Tiefe des Ausgangsbilds.':'Zu wenig texturierte Tiefenstufen.',defaultOn:blurry&&dofConf>=.4});
  // Light direction.
  const dir=fitLightDirection(ref.work,ref.sky.mask,ref.light.weights),srcDir=fitLightDirection(src.work,src.sky.mask,src.light.weights);
  const side=dir?(Math.abs(dir.azimuth)>135?'Gegenlicht':dir.azimuth<-25?'von links':dir.azimuth>25?'von rechts':'von vorn'):'';
  add({id:'direction',title:'Lichtrichtung',value:dir?`${side} · Azimut ${dir.azimuth}° · Elevation ${dir.elevation}°`:'nicht bestimmbar',confidence:dir?.confidence??0,
    reason:dir?`Lambert-Ausgleichsrechnung auf ${dir.samples} Pixeln mit Normalen aus der ${DEPTH_NOTE[ref.work.depthKind]} (R² ${de(dir.r2,2)}, Normalenstreuung ${de(dir.spread,3)}). Albedo, Schlagschatten und Glanz stören – Richtung nur bei hoher Konfidenz verlässlich.`:'Zu wenige geeignete Flächen oder keine Tiefe.',
    transferable:!!dir&&srcIn.depthKind!=='none',transferReason:dir?'Zusatzlicht aus dieser Richtung über die Normalen des Ausgangsbilds, Farbe = geschätzte Lichtfarbe.':'Ohne Richtung kein Vorschlag.',defaultOn:!!dir&&dir.confidence>=.5});
  // Practical lamps.
  const lamps=detectLamps(ref.work,undefined,ref.sky.mask),srcLamps=detectLamps(src.work,.9,src.sky.mask);
  const hasLamps=lamps.share>=2e-4&&!!lamps.color,srcHas=srcLamps.share>=1e-4;
  add({id:'lamps',title:'Lampen',value:hasLamps?`leuchtende Lampen (${de(lamps.share*100,2)} % der Fläche) · ≈ ${lamps.kelvin} K`:'keine leuchtenden Lampen gefunden',confidence:hasLamps?clamp(.4+lamps.share*400)*(Math.abs(lamps.duv??0)>.03?.8:1):0,
    reason:'Erkennung wie light.practicals@1 (Helligkeitsschwelle relativ zum Bild, Kontrast zur Umgebung, Größenband); Farbe aus dem Lichthof um die meist weiß beschnittenen Kerne.',
    transferable:hasLamps&&srcHas,transferReason:!hasLamps?'Die Referenz zeigt keine Lampen.':srcHas?'Helle, kompakte Lichtquellen im Ausgangsbild werden zum Leuchten gebracht.':'Im Ausgangsbild gibt es keine hellen, kompakten Lichtquellen; Lichtpunkte lassen sich im Knoten von Hand setzen.',defaultOn:hasLamps&&srcHas});
  if(!opts.srcEditorDepth)for(const a of aspects)if(['sky','haze','dof','direction','lamps'].includes(a.id)&&a.transferable)a.transferReason+=' Hinweis: Im Editor liegt für das Ausgangsbild noch keine Tiefe vor – der Knoten wird bis dahin überbrückt.';
  const plan:ReferencePlan={exposureEV:ev,saturation,lightRef:ref.light.rgb,lightSrc:src.light.rgb,lightKelvin:ref.light.kelvin,lightDuv:ref.light.duv,time,sky:skyM,skyDepth:ss.skyDepth,fog,dof,direction:dir,lamps:hasLamps?lamps:undefined};
  if(dir&&srcDir)plan.direction={...dir,strength:r4(Math.max(0,dir.strength-.5*srcDir.strength))};
  aspects.sort((a,b)=>ASPECT_ORDER.indexOf(a.id)-ASPECT_ORDER.indexOf(b.id));
  return {aspects,plan,ref,src};
}
