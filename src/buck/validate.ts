import type { BuckGraph, BuckNode, NodeType, PortKind, SpaceName } from './types';
import { BuckError, LIMITS, LINEAR_SPACES, OFX_CONFIG, PORTS, SKY_PRESETS, SPACE_NAMES } from './types';
/**
 * Strict reader for graph.json (docs/BUCK_FORMAT.md §4–§6, §11). checkGraph collects every problem as a German
 * sentence in a fixed order; parseGraph throws the first one. Structural rules are mirrored in docs/schema/buck-1.0.schema.json.
 */
type Obj=Record<string,unknown>;
type Range=[number,number];
type Report=(message:string)=>void;
const UNIT:Range=[0,1],SIGNED:Range=[-1,1],TINT:Range=[-.3,.3];
// Safety bounds the spec leaves open (§11.4 demands finite, range-checked numbers). Generous by intent; tighten with the spec.
const DEPTH:Range=[0,1e4],EV:Range=[-10,10],LIN_COLOR:Range=[0,16],BLUR:Range=[0,.05],POINT:Range=[-4,4];
// Kim et al. cubic-spline Planckian locus is defined for 1667–25000 K; any implementation is safe inside it.
const KELVIN:Range=[1667,25000];
/** Value ranges of every numeric parameter (dotted paths for nested fields). Also the slider ranges of the editor. */
export const PARAM_RANGES:Record<NodeType,Record<string,Range>>={
  'color.convert@1':{},
  'color.look@1':{'look.shadows':TINT,'look.midtones':TINT,'look.highlights':TINT,'look.whiteClean':UNIT,'look.skinProtect':UNIT,'look.skinHue':SIGNED,'look.key':SIGNED,'look.contrast':SIGNED,'look.saturation':SIGNED,skinProtection:UNIT},
  // ASC CDL: slope >= 0, power > 0, saturation >= 0 (CLF spec, ASC_CDL); upper bounds and offset are safety bounds.
  'color.cdl@1':{slope:[0,16],offset:[-4,4],power:[0,16],saturation:[0,16]},
  'color.lut3d@1':{},
  'atmos.fog@1':{start:DEPTH,end:DEPTH,density:[0,20],color:LIN_COLOR,'color.kelvin':KELVIN,luminance:EV,maxOpacity:UNIT,skyProtect:UNIT},
  // f/0.5 is the aplanatic limit in air (NA = 1); sensor/focal bounds cover large format with margin.
  'lens.dof@1':{focus:UNIT,focusRange:UNIT,blurNear:BLUR,blurFar:BLUR,focusDistance:[.01,1e4],fNumber:[.5,128],focalLength:[1,2000],sensorWidth:[1,100],maxBlur:BLUR,blades:[0,12],rotation:[-360,360],bladeCurvature:UNIT,catEye:UNIT,highlightBoost:UNIT},
  'light.relight@1':{azimuth:[-180,180],elevation:[-90,90],color:LIN_COLOR,'color.kelvin':KELVIN,intensity:EV,softness:UNIT,preserveHighlights:UNIT,skinProtect:UNIT},
  // §9.2: depthRange needs feather >= 0.02 depth units.
  'mask.depthRange@1':{near:DEPTH,far:DEPTH,feather:[.02,1e4]},
  'mask.gradient@1':{start:POINT,end:POINT,center:POINT,radius:[0,4],feather:[0,4]},
  'mask.luma@1':{low:LIN_COLOR,high:LIN_COLOR,softness:LIN_COLOR},
  'mask.input@1':{},
  'mask.image@1':{},
  'mask.combine@1':{},
  'mask.refine@1':{blur:BLUR,grow:[-.05,.05],gamma:[0,10]},
  // Sky/practicals bounds are safety bounds of this implementation (coordinates in image widths, y up to H/W).
  'sky.replace@1':{zenith:LIN_COLOR,'zenith.kelvin':KELVIN,horizon:LIN_COLOR,'horizon.kelvin':KELVIN,horizonY:[-1,2],gradientPower:[.05,10],exposure:EV,
    glow:[0,8],glowColor:LIN_COLOR,'glowColor.kelvin':KELVIN,stars:UNIT,milkyWay:UNIT,clouds:UNIT,cloudContrast:UNIT,cloudScale:[.01,4],cloudColor:LIN_COLOR,'cloudColor.kelvin':KELVIN,
    aurora:[0,4],'moon.x':[-1,2],'moon.height':[-1,2],'moon.radius':[.001,.2],'moon.intensity':EV,'moon.color':LIN_COLOR,'moon.color.kelvin':KELVIN,skyDepth:DEPTH,edge:BLUR,spill:UNIT},
  'light.practicals@1':{threshold:[.001,16],softness:[0,4],contrast:[0,6],minSize:BLUR,maxSize:[0,.25],intensity:EV,glow:[0,8],glowRadius:[0,.1],throw:[0,.5],falloff:[0,3],
    color:LIN_COLOR,'color.kelvin':KELVIN,recolor:UNIT,'points.x':[-1,2],'points.y':[-1,2],'points.radius':[.001,.2],'points.intensity':EV,'points.color':LIN_COLOR,'points.color.kelvin':KELVIN},
  // Optics (§5.3.6–§5.3.8): safety bounds of this implementation. Grain size 0.0002…0.01 image widths ≈ 0.4…19 px at 1920 px.
  'lens.vignette@1':{strength:SIGNED,exposure:[-8,4],radius:[0,2],softness:[0,2],roundness:UNIT,center:POINT},
  'film.grain@1':{size:[.0002,.01],intensity:[0,2],response:UNIT,chroma:UNIT,seed:[0,65535]},
  'film.halation@1':{threshold:[.01,16],knee:[0,6],radius:[0,.1],intensity:[0,4],color:LIN_COLOR,'color.kelvin':KELVIN,bloom:[0,2],bloomRadius:[0,.1]},
};
/** Parameters whose lower bound is exclusive (CDL power > 0, §9.2 feather/softness > 0, positive radius and gamma). */
const EXCLUSIVE_MIN=new Set(['color.cdl@1:power','mask.gradient@1:radius','mask.gradient@1:feather','mask.luma@1:softness','mask.refine@1:gamma']);

type Kind='num'|'int'|'anim'|'rgb'|'color'|'point'|'bool'|'space'|'enum'|'text'|'texts'|'file'|'look'|'inputRef'|'object'|'list';
/** `fields`: closed sub-object ('object', or every item of a 'list' with at most `max` items); ranges as `name.field`. */
interface Field {k:Kind;opt?:boolean;of?:readonly string[];re?:RegExp;fields?:Record<string,Field>;max?:number}
const f=(k:Kind,extra:Omit<Field,'k'>={}):Field=>({k,...extra}),o=(k:Kind,extra:Omit<Field,'k'>={}):Field=>({k,opt:true,...extra});
const LUT_FILE=/^luts\/[a-z0-9_-][a-z0-9._-]{0,99}\.cube$/,MASK_FILE=/^masks\/[a-z0-9_-][a-z0-9._-]{0,99}\.png$/;
const SKY_FILE=/^skies\/[a-z0-9_-][a-z0-9._-]{0,99}\.png$/;
const THUMB_FILE=/^thumbs\/[a-z0-9_-][a-z0-9._-]{0,99}\.(jpg|jpeg|png)$/,RECIPE_FILE=/^meta\/[a-z0-9_-][a-z0-9._-]{0,99}\.json$/;
const PATH_HINTS=new Map<RegExp,string>([[LUT_FILE,'luts/<name>.cube'],[MASK_FILE,'masks/<name>.png'],[THUMB_FILE,'thumbs/<name>.jpg|.png'],[RECIPE_FILE,'meta/<name>.json'],[SKY_FILE,'skies/<name>.png']]);
const ANIM=f('anim');
const SPECS:Record<NodeType,Record<string,Field>>={
  'color.convert@1':{from:f('space'),to:f('space')},
  'color.look@1':{space:f('space'),look:f('look'),skinProtection:f('num'),prompt:o('text'),understood:o('texts'),bakedLut:o('file',{re:LUT_FILE})},
  'color.cdl@1':{slope:f('rgb'),offset:f('rgb'),power:f('rgb'),saturation:f('num'),style:f('enum',{of:['v1.2_Fwd','noClampFwd']}),space:f('space')},
  'color.lut3d@1':{file:f('file',{re:LUT_FILE}),inputSpace:f('space'),outputSpace:f('space')},
  'atmos.fog@1':{model:f('enum',{of:['exponential','linear']}),start:ANIM,end:o('anim'),density:ANIM,color:f('color'),luminance:ANIM,maxOpacity:ANIM,skyProtect:ANIM},
  'lens.dof@1':{mode:f('enum',{of:['artistic','physical']}),focus:o('anim'),focusRange:o('anim'),blurNear:o('anim'),blurFar:o('anim'),focusDistance:o('anim'),fNumber:o('anim'),focalLength:o('anim'),sensorWidth:o('anim'),maxBlur:ANIM,blades:f('int'),rotation:ANIM,bladeCurvature:ANIM,catEye:ANIM,highlightBoost:ANIM},
  'light.relight@1':{azimuth:ANIM,elevation:ANIM,color:f('color'),intensity:ANIM,softness:ANIM,mode:f('enum',{of:['add']}),preserveHighlights:ANIM,skinProtect:o('anim')},
  'mask.depthRange@1':{near:ANIM,far:ANIM,feather:ANIM,invert:f('bool')},
  'mask.gradient@1':{shape:f('enum',{of:['linear','radial']}),start:o('point'),end:o('point'),center:o('point'),radius:o('anim'),feather:ANIM,invert:f('bool')},
  'mask.luma@1':{low:ANIM,high:ANIM,softness:ANIM,space:f('space')},
  'mask.input@1':{input:f('inputRef'),channel:f('enum',{of:['r','g','b','a','luma']})},
  'mask.image@1':{file:f('file',{re:MASK_FILE}),fit:f('enum',{of:['stretch','contain','cover']})},
  'mask.combine@1':{op:f('enum',{of:['multiply','max','min','subtract','screen']})},
  'mask.refine@1':{blur:ANIM,grow:ANIM,gamma:ANIM},
  'sky.replace@1':{source:f('enum',{of:['procedural','image']}),preset:f('enum',{of:SKY_PRESETS}),zenith:f('color'),horizon:f('color'),horizonY:o('anim'),gradientPower:ANIM,exposure:ANIM,
    glow:ANIM,glowColor:f('color'),stars:ANIM,milkyWay:ANIM,clouds:ANIM,cloudContrast:ANIM,cloudScale:ANIM,cloudColor:f('color'),aurora:ANIM,
    moon:o('object',{fields:{x:f('num'),height:ANIM,radius:ANIM,intensity:ANIM,color:o('color')}}),file:o('file',{re:SKY_FILE}),skyDepth:ANIM,edge:ANIM,spill:ANIM},
  'light.practicals@1':{threshold:ANIM,softness:ANIM,contrast:ANIM,minSize:ANIM,maxSize:ANIM,intensity:ANIM,glow:ANIM,glowRadius:ANIM,throw:ANIM,falloff:ANIM,color:f('color'),recolor:ANIM,
    points:o('list',{max:8,fields:{x:f('num'),y:f('num'),radius:ANIM,intensity:ANIM,color:o('color')}})},
  'lens.vignette@1':{strength:o('anim'),exposure:o('anim'),radius:ANIM,softness:ANIM,roundness:ANIM,center:o('point')},
  'film.grain@1':{size:ANIM,intensity:ANIM,response:ANIM,chroma:ANIM,seed:f('int'),animate:f('bool')},
  'film.halation@1':{threshold:ANIM,knee:ANIM,radius:ANIM,intensity:ANIM,color:f('color'),bloom:ANIM,bloomRadius:o('anim')},
};
const LOOK_FIELDS=['shadows','midtones','highlights','whiteClean','skinProtect','skinHue','key','contrast','saturation'] as const;

const NODE_TYPES=Object.keys(PORTS) as NodeType[];
const ID=/^[a-zA-Z0-9_-]{1,64}$/,MODEL_ID=/^[a-zA-Z0-9._@-]{1,64}$/,TYPE_NAME=/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+@[1-9][0-9]{0,3}$/;
const CLIP=/^[A-Za-z][A-Za-z0-9_]{0,63}$/,VERSION=/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/,PINNED=/^[0-9a-f]{64}$/;
const RFC3339=/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const RESERVED=new Set(['__proto__','constructor','prototype','source']);
const DISPLAY_SPACES=SPACE_NAMES.filter(s=>!LINEAR_SPACES.includes(s));
const KIND_OF_INPUT:Record<string,PortKind>={depth:'scalar',mask:'scalar',normals:'vector3'};
// Safety bounds for free text and lists (not in the spec).
const TEXT_MAX=500,LIST_MAX=100,KEYS_MAX=1000,SOURCES_MAX=8;

const isObj=(v:unknown):v is Obj=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const has=(v:Obj,k:string)=>Object.prototype.hasOwnProperty.call(v,k);
const isNum=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const isSpace=(v:unknown):v is SpaceName=>typeof v==='string'&&(SPACE_NAMES as readonly string[]).includes(v);
const q=(v:unknown)=>`„${typeof v==='string'?v.slice(0,80):JSON.stringify(v)?.slice(0,80)}“`;
const fmt=(x:number)=>String(x).replace('.',',');
/** Nested parameter path inside the quoted name: Parameter „look“ + shadows → Parameter „look.shadows“. */
const sub=(where:string,k:string)=>where.endsWith('“')?`${where.slice(0,-1)}.${k}“`:`${where}.${k}`;
const list=(values:readonly string[])=>values.map(v=>q(v)).join(', ');

/** Rejects unknown keys except vendor extensions `x-…` (§4.2). */
function closed(v:Obj,allowed:readonly string[],where:string,err:Report){
  for(const k of Object.keys(v))if(!allowed.includes(k)&&!/^x-[A-Za-z0-9]/.test(k))err(`${where}: unbekanntes Feld ${q(k)}.`);
}
function need(v:Obj,keys:readonly string[],where:string,err:Report){for(const k of keys)if(!has(v,k))err(`${where}: Pflichtfeld ${q(k)} fehlt.`);}
function text(v:unknown,where:string,max:number,err:Report,min=0){
  if(typeof v!=='string')err(`${where} muss ein Text sein.`);
  else if(v.length<min||v.length>max)err(min>0?`${where} muss 1 bis ${max} Zeichen lang sein.`:`${where} darf höchstens ${max} Zeichen lang sein.`);
}
function oneOf(v:unknown,values:readonly string[],where:string,err:Report){
  if(typeof v!=='string'||!values.includes(v))err(`${where} muss einer der Werte ${list(values)} sein, ist aber ${q(v)}.`);
}
function inRange(x:number,[lo,hi]:Range,exclusive:boolean,where:string,err:Report){
  if(x<lo||x>hi||(exclusive&&x===lo))err(`${where} muss ${exclusive?'größer als':'zwischen'} ${fmt(lo)} ${exclusive?'und höchstens':'und'} ${fmt(hi)} ${exclusive?'sein':'liegen'}, ist aber ${fmt(x)}.`);
}
function num(v:unknown,range:Range,exclusive:boolean,where:string,err:Report){
  if(!isNum(v))err(`${where} muss eine endliche Zahl sein.`);else inRange(v,range,exclusive,where,err);
}
function archivePath(v:unknown,re:RegExp,where:string,err:Report){
  if(typeof v!=='string'||!re.test(v)||v.includes('..'))err(`${where} verweist auf ${q(v)}; erlaubt sind nur Archivpfade der Form ${q(PATH_HINTS.get(re))}.`);
}
/** §9.3 keyframes: non-empty, finite, strictly increasing frames, values in range. */
function animatable(v:unknown,range:Range,exclusive:boolean,where:string,err:Report){
  if(typeof v==='number')return num(v,range,exclusive,where,err);
  if(!isObj(v))return err(`${where} muss eine Zahl oder ein Keyframe-Objekt sein.`);
  closed(v,['keys','interp'],where,err);need(v,['keys','interp'],where,err);
  if(has(v,'interp'))oneOf(v.interp,['linear','hold','smooth'],`${where}.interp`,err);
  if(!has(v,'keys'))return;
  const keys=v.keys;
  if(!Array.isArray(keys)||keys.length<1||keys.length>KEYS_MAX)return err(`${where}.keys muss eine Liste mit 1 bis ${KEYS_MAX} Keyframes sein.`);
  let last=-Infinity;
  keys.forEach((k,i)=>{
    if(!Array.isArray(k)||k.length!==2||!isNum(k[0])||!isNum(k[1]))return err(`${where}.keys[${i}] muss ein Paar [Frame, Wert] aus endlichen Zahlen sein.`);
    if(k[0]<=last)err(`${where}.keys[${i}]: Frames müssen streng aufsteigend sortiert sein.`);
    last=k[0];inRange(k[1],range,exclusive,`${where}.keys[${i}] (Wert)`,err);
  });
}
function triple(v:unknown,range:Range,exclusive:boolean,where:string,err:Report){
  if(!Array.isArray(v)||v.length!==3)return err(`${where} muss eine Liste aus genau drei Zahlen sein.`);
  v.forEach((x,i)=>num(x,range,exclusive,`${where}[${i}]`,err));
}

function checkField(type:NodeType,name:string,spec:Field,v:unknown,where:string,err:Report,declared:Obj){
  const range=PARAM_RANGES[type][name],ex=EXCLUSIVE_MIN.has(`${type}:${name}`);
  switch(spec.k){
    case 'num':return num(v,range,ex,where,err);
    case 'int':
      if(!Number.isInteger(v))return err(`${where} muss eine ganze Zahl sein.`);
      return inRange(v as number,range,ex,where,err);
    case 'anim':return animatable(v,range,ex,where,err);
    case 'rgb':return triple(v,range,ex,where,err);
    case 'color':
      if(isObj(v)){closed(v,['kelvin'],where,err);need(v,['kelvin'],where,err);if(has(v,'kelvin'))num(v.kelvin,PARAM_RANGES[type][`${name}.kelvin`],false,sub(where,'kelvin'),err);return;}
      return triple(v,range,false,where,err);
    case 'point':
      if(!Array.isArray(v)||v.length!==2)return err(`${where} muss ein Punkt [x, y] in normierten Bildkoordinaten sein.`);
      return v.forEach((x,i)=>num(x,range,false,`${where}[${i}]`,err));
    case 'bool':if(typeof v!=='boolean')err(`${where} muss true oder false sein.`);return;
    case 'space':return oneOf(v,SPACE_NAMES,where,err);
    case 'enum':return oneOf(v,spec.of!,where,err);
    case 'text':return text(v,where,LIMITS.promptChars,err);
    case 'texts':
      if(!Array.isArray(v)||v.length>LIST_MAX)return err(`${where} muss eine Liste mit höchstens ${LIST_MAX} Texten sein.`);
      return v.forEach((x,i)=>text(x,`${where}[${i}]`,TEXT_MAX,err));
    case 'file':return archivePath(v,spec.re!,where,err);
    case 'look':{
      if(!isObj(v))return err(`${where} muss ein Objekt (LookSpec) sein.`);
      closed(v,LOOK_FIELDS,where,err);need(v,LOOK_FIELDS,where,err);
      for(const k of LOOK_FIELDS)if(has(v,k)){const r=PARAM_RANGES[type][`look.${k}`];k==='shadows'||k==='midtones'||k==='highlights'?triple(v[k],r,false,sub(where,k),err):num(v[k],r,false,sub(where,k),err);}
      return;
    }
    case 'object':{
      if(!isObj(v))return err(`${where} muss ein Objekt sein.`);
      const fields=spec.fields!;closed(v,Object.keys(fields),where,err);need(v,Object.keys(fields).filter(k=>!fields[k].opt),where,err);
      for(const [k,fs] of Object.entries(fields))if(has(v,k))checkField(type,`${name}.${k}`,fs,v[k],sub(where,k),err,declared);
      return;
    }
    case 'list':
      if(!Array.isArray(v)||v.length>spec.max!)return err(`${where} muss eine Liste mit höchstens ${spec.max} Einträgen sein.`);
      return v.forEach((x,i)=>checkField(type,name,{k:'object',fields:spec.fields},x,`${where}[${i}]`,err,declared));
    case 'inputRef':{
      const name2=typeof v==='string'&&v.startsWith('$')?v.slice(1):undefined,decl=name2!==undefined&&has(declared,name2)?declared[name2]:undefined;
      if(!isObj(decl)||decl.kind!=='mask')err(`${where} muss mit „$name“ auf eine deklarierte Eingabe der Art „mask“ verweisen, ist aber ${q(v)}.`);
    }
  }
}

function checkParams(type:NodeType,p:unknown,where:string,err:Report,declared:Obj){
  if(!isObj(p))return err(`${where}.params muss ein Objekt sein.`);
  const spec=SPECS[type],w=`${where}: Parameter`;
  closed(p,Object.keys(spec),`${where}.params`,err);
  need(p,Object.keys(spec).filter(k=>!spec[k].opt),`${where}.params`,err);
  for(const [name,field] of Object.entries(spec))if(has(p,name))checkField(type,name,field,p[name],`${w} ${q(name)}`,err,declared);
  const constant=(k:string)=>isNum(p[k])?p[k] as number:undefined,ordered=(a:string,b:string,strict:boolean)=>{
    const x=constant(a),y=constant(b);if(x!==undefined&&y!==undefined&&(strict?x>=y:x>y))err(`${where}: ${q(a)} muss ${strict?'kleiner als':'höchstens'} ${q(b)} sein.`);
  };
  const requireFor=(mode:string,keys:string[])=>{for(const k of keys)if(!has(p,k))err(`${where}: Im Modus ${q(mode)} ist der Parameter ${q(k)} Pflicht.`);};
  switch(type){
    case 'color.look@1':if(isSpace(p.space)&&LINEAR_SPACES.includes(p.space))err(`${where}: color.look@1 arbeitet display-bezogen; ${q(p.space)} ist ein linearer Raum.`);break;
    case 'atmos.fog@1':if(p.model==='linear'){requireFor('linear',['end']);ordered('start','end',true);}break;
    case 'lens.dof@1':
      if(p.mode==='artistic')requireFor('artistic',['focus','focusRange','blurNear','blurFar']);
      if(p.mode==='physical'){
        requireFor('physical',['focusDistance','fNumber','focalLength','sensorWidth']);
        // Thin lens needs s > f (both in metres).
        const s=constant('focusDistance'),fl=constant('focalLength');if(s!==undefined&&fl!==undefined&&s<=fl/1000)err(`${where}: Die Fokusdistanz muss größer als die Brennweite sein.`);
      }
      if(Number.isInteger(p.blades)&&(p.blades as number)>0&&(p.blades as number)<5)err(`${where}: Parameter „blades“ muss 0 (Kreis) oder 5 bis 12 sein.`);
      break;
    case 'mask.depthRange@1':ordered('near','far',false);break;
    case 'sky.replace@1':if(p.source==='image')requireFor('image',['file']);break;
    case 'light.practicals@1':ordered('minSize','maxSize',true);break;
    case 'lens.vignette@1':if(has(p,'strength')===has(p,'exposure'))err(`${where}: Genau einer der Parameter „strength“ (Faktor) oder „exposure“ (EV) muss gesetzt sein.`);break;
    case 'mask.luma@1':ordered('low','high',false);break;
    case 'mask.gradient@1':
      if(p.shape==='linear'){requireFor('linear',['start','end']);if(Array.isArray(p.start)&&Array.isArray(p.end)&&p.start[0]===p.end[0]&&p.start[1]===p.end[1])err(`${where}: Start- und Endpunkt des Verlaufs dürfen nicht gleich sein.`);}
      if(p.shape==='radial')requireFor('radial',['center','radius']);
      break;
  }
}

function checkSource(s:unknown,i:number,name:string,decl:Obj,inputs:Obj,models:Obj,err:Report){
  const where=`Eingabe ${q(name)}: sources[${i}]`;
  if(!isObj(s))return err(`${where} muss ein Objekt sein.`);
  switch(s.type){
    case 'host-clip':closed(s,['type','clip'],where,err);if(typeof s.clip!=='string'||!CLIP.test(s.clip))err(`${where}.clip muss ein Clipname aus Buchstaben, Ziffern und _ sein (höchstens 64 Zeichen).`);return;
    case 'cache':return closed(s,['type'],where,err);
    case 'derive':{
      closed(s,['type','method','from','params'],where,err);need(s,['method','from','params'],where,err);
      if(decl.kind!=='normals')err(`${where}: „derive“ ist nur für Normalen erlaubt.`);
      if(has(s,'method')&&s.method!=='normals-from-depth@1')err(`${where}.method muss „normals-from-depth@1“ sein.`);
      const from=typeof s.from==='string'&&has(inputs,s.from)?inputs[s.from]:undefined;
      if(has(s,'from')&&(!isObj(from)||from.kind!=='depth'))err(`${where}.from muss eine deklarierte Tiefen-Eingabe nennen, ist aber ${q(s.from)}.`);
      if(has(s,'params')){
        // smoothing in image widths; 0.05 is a safety bound (example uses 0.002).
        if(!isObj(s.params))err(`${where}.params muss ein Objekt sein.`);
        else{closed(s.params,['smoothing'],`${where}.params`,err);need(s.params,['smoothing'],`${where}.params`,err);if(has(s.params,'smoothing'))num(s.params.smoothing,[0,.05],false,`${where}.params.smoothing`,err);}
      }
      return;
    }
    case 'estimate':{
      closed(s,['type','model'],where,err);
      if(decl.kind!=='depth')return err(`${where}: „estimate“ ist in Version 1 nur für Tiefe erlaubt.`);
      const model=typeof s.model==='string'&&has(models,s.model)?models[s.model]:undefined;
      if(!isObj(model))return err(`${where}.model verweist auf das nicht deklarierte Modell ${q(s.model)}.`);
      if(typeof decl.semantics==='string'&&model.output!==decl.semantics)err(`${where}: Modell ${q(s.model)} liefert ${q(model.output)}, die Eingabe ist aber als ${q(decl.semantics)} deklariert.`);
      return;
    }
    default:err(`${where}.type muss „host-clip“, „cache“, „derive“ oder „estimate“ sein, ist aber ${q(s.type)}.`);
  }
}

function checkInput(name:string,d:unknown,inputs:Obj,models:Obj,err:Report){
  const where=`Eingabe ${q(name)}`;
  if(!ID.test(name)||RESERVED.has(name))err(`${where}: Der Name muss [a-zA-Z0-9_-]{1,64} entsprechen und darf nicht „source“ oder ein reservierter Name sein.`);
  if(!isObj(d))return err(`${where} muss ein Objekt sein.`);
  closed(d,['kind','semantics','frame','required','sources','normalize','onMissing'],where,err);need(d,['kind','required','sources','onMissing'],where,err);
  if(has(d,'kind'))oneOf(d.kind,['depth','normals','mask'],`${where}.kind`,err);
  if(d.kind==='depth'){if(!has(d,'semantics'))err(`${where}: Tiefe braucht das Feld „semantics“.`);else oneOf(d.semantics,['relative-inverse','relative-depth','metric'],`${where}.semantics`,err);}
  else if(has(d,'semantics'))err(`${where}: „semantics“ ist nur bei Tiefe erlaubt.`);
  if(has(d,'frame')){if(d.kind!=='normals')err(`${where}: „frame“ ist nur bei Normalen erlaubt.`);else oneOf(d.frame,['camera'],`${where}.frame`,err);}
  if(has(d,'required')&&typeof d.required!=='boolean')err(`${where}.required muss true oder false sein.`);
  if(has(d,'onMissing'))oneOf(d.onMissing,['fail','bypass-dependents','constant'],`${where}.onMissing`,err);
  if(d.required===true&&has(d,'onMissing')&&d.onMissing!=='fail')err(`${where}: Eine Pflicht-Eingabe muss „onMissing“: „fail“ verwenden.`);
  if(has(d,'normalize')){
    const n=d.normalize,w=`${where}.normalize`;
    if(d.kind!=='depth')err(`${where}: „normalize“ ist nur bei Tiefe erlaubt.`);
    if(!isObj(n))err(`${w} muss ein Objekt sein.`);
    else{
      closed(n,['mode','low','high'],w,err);need(n,['mode'],w,err);
      if(has(n,'mode'))oneOf(n.mode,['shot-percentile','per-frame','none'],`${w}.mode`,err);
      for(const k of ['low','high'])if(has(n,k))num(n[k],[0,100],false,`${w}.${k}`,err);
      if(isNum(n.low)&&isNum(n.high)&&n.low>=n.high)err(`${w}: „low“ muss kleiner als „high“ sein.`);
      if(n.mode==='none'&&(has(n,'low')||has(n,'high')))err(`${w}: „low“/„high“ sind bei „none“ nicht erlaubt.`);
      if(d.semantics==='metric'&&has(n,'mode')&&n.mode!=='none')err(`${w}: Metrische Tiefe wird nicht normiert („mode“: „none“).`);
      if(typeof d.semantics==='string'&&d.semantics!=='metric'&&n.mode==='none')err(`${w}: Relative Tiefe muss normiert werden („shot-percentile“ oder „per-frame“).`);
    }
  }
  if(has(d,'sources')){
    if(!Array.isArray(d.sources)||d.sources.length<1||d.sources.length>SOURCES_MAX)err(`${where}.sources muss eine Liste mit 1 bis ${SOURCES_MAX} Quellen sein.`);
    else d.sources.forEach((s,i)=>checkSource(s,i,name,d,inputs,models,err));
  }
}

function checkModel(id:string,m:unknown,err:Report){
  const where=`Modell ${q(id)}`;
  if(!MODEL_ID.test(id)||RESERVED.has(id))err(`${where}: Die Modell-ID muss [a-zA-Z0-9._@-]{1,64} entsprechen.`);
  if(!isObj(m))return err(`${where} muss ein Objekt sein.`);
  const keys=['name','upstream','revision','license','format','opset','weightsSha256','output','preprocess','temporal','postprocess'];
  closed(m,keys,where,err);need(m,keys.filter(k=>k!=='temporal'),where,err);
  if(has(m,'name'))text(m.name,`${where}.name`,LIMITS.nameChars,err,1);
  // upstream is documentation only and never fetched (§11.2).
  for(const k of ['upstream','revision','license'])if(has(m,k))text(m[k],`${where}.${k}`,TEXT_MAX,err,1);
  if(has(m,'format'))oneOf(m.format,['onnx'],`${where}.format`,err);
  if(has(m,'opset')&&(!Number.isInteger(m.opset)||(m.opset as number)<1||(m.opset as number)>64))err(`${where}.opset muss eine ganze Zahl von 1 bis 64 sein.`);
  if(has(m,'weightsSha256')){
    const h=m.weightsSha256;
    // Pinned = 64 lowercase hex. Anything with a non-hex character is a recognizable "not pinned yet" marker; pure hex of the wrong form is a broken hash.
    if(typeof h!=='string'||h.length<1||h.length>200)err(`${where}.weightsSha256 muss ein Text mit 1 bis 200 Zeichen sein.`);
    else if(!PINNED.test(h)&&/^[0-9a-fA-F]+$/.test(h.trim()))err(`${where}.weightsSha256 ist kein gültiger SHA-256 (64 Hex-Zeichen in Kleinbuchstaben) und auch nicht als ungepinnt erkennbar.`);
  }
  if(has(m,'output'))oneOf(m.output,['relative-inverse','relative-depth','metric'],`${where}.output`,err);
  if(has(m,'preprocess')){
    const p=m.preprocess,w=`${where}.preprocess`,pk=['longSide','multipleOf','resize','inputSpace','mean','std'];
    if(!isObj(p))err(`${w} muss ein Objekt sein.`);
    else{
      closed(p,pk,w,err);need(p,pk,w,err);
      const int=(k:string,lo:number,hi:number)=>{if(has(p,k)&&(!Number.isInteger(p[k])||(p[k] as number)<lo||(p[k] as number)>hi))err(`${w}.${k} muss eine ganze Zahl von ${lo} bis ${hi} sein.`);};
      int('longSide',1,LIMITS.imageSide);int('multipleOf',1,256);
      if(Number.isInteger(p.longSide)&&Number.isInteger(p.multipleOf)&&(p.multipleOf as number)>0&&(p.longSide as number)%(p.multipleOf as number)!==0)err(`${w}: „longSide“ muss ein Vielfaches von „multipleOf“ sein.`);
      if(has(p,'resize'))oneOf(p.resize,['bicubic','bilinear'],`${w}.resize`,err);
      if(has(p,'inputSpace'))oneOf(p.inputSpace,['sRGB - Texture'],`${w}.inputSpace`,err);
      if(has(p,'mean'))triple(p.mean,UNIT,false,`${w}.mean`,err);
      if(has(p,'std'))triple(p.std,UNIT,true,`${w}.std`,err);
    }
  }
  if(has(m,'temporal')){
    const t=m.temporal,w=`${where}.temporal`;
    if(!isObj(t))err(`${w} muss ein Objekt sein.`);
    else{
      closed(t,['windowFrames','overlapFrames'],w,err);need(t,['windowFrames','overlapFrames'],w,err);
      const win=t.windowFrames,ov=t.overlapFrames;
      if(has(t,'windowFrames')&&(!Number.isInteger(win)||(win as number)<1||(win as number)>1024))err(`${w}.windowFrames muss eine ganze Zahl von 1 bis 1024 sein.`);
      if(has(t,'overlapFrames')&&(!Number.isInteger(ov)||(ov as number)<0||(Number.isInteger(win)&&(ov as number)>=(win as number))))err(`${w}.overlapFrames muss eine ganze Zahl ab 0 und kleiner als „windowFrames“ sein.`);
    }
  }
  if(has(m,'postprocess')){
    const p=m.postprocess,w=`${where}.postprocess`;
    if(!isObj(p))err(`${w} muss ein Objekt sein.`);else{closed(p,['resize'],w,err);need(p,['resize'],w,err);if(has(p,'resize'))oneOf(p.resize,['bilinear-to-source'],`${w}.resize`,err);}
  }
}

function checkMeta(m:unknown,err:Report){
  if(!isObj(m))return err('„meta“ muss ein Objekt sein.');
  closed(m,['name','generator','created','author','prompt','license','thumbnails','recipe'],'meta',err);need(m,['name'],'meta',err);
  if(has(m,'name'))text(m.name,'meta.name',LIMITS.nameChars,err,1);
  for(const k of ['generator','author','license'])if(has(m,k))text(m[k],`meta.${k}`,TEXT_MAX,err);
  if(has(m,'prompt'))text(m.prompt,'meta.prompt',LIMITS.promptChars,err);
  if(has(m,'created')&&(typeof m.created!=='string'||!RFC3339.test(m.created)||Number.isNaN(Date.parse(m.created))))err('meta.created muss ein Zeitpunkt nach ISO 8601 / RFC 3339 sein, z. B. „2026-10-30T12:00:00Z“.');
  if(has(m,'recipe'))archivePath(m.recipe,RECIPE_FILE,'meta.recipe',err);
  if(has(m,'thumbnails')){
    const t=m.thumbnails;
    if(!isObj(t))err('meta.thumbnails muss ein Objekt sein.');else{closed(t,['before','after'],'meta.thumbnails',err);for(const k of ['before','after'])if(has(t,k))archivePath(t[k],THUMB_FILE,`meta.thumbnails.${k}`,err);}
  }
}

function checkColorManagement(c:unknown,err:Report){
  if(!isObj(c))return err('„colorManagement“ muss ein Objekt sein.');
  closed(c,['config','input','output','working'],'colorManagement',err);need(c,['config','input','output','working'],'colorManagement',err);
  if(has(c,'config'))oneOf(c.config,[OFX_CONFIG],'colorManagement.config',err);
  for(const k of ['input','output'])if(has(c,k))oneOf(c[k],SPACE_NAMES,`colorManagement.${k}`,err);
  if(has(c,'working')){
    const w=c.working;
    if(!isObj(w))err('colorManagement.working muss ein Objekt sein.');
    else{
      closed(w,['linear','display'],'colorManagement.working',err);need(w,['linear','display'],'colorManagement.working',err);
      if(has(w,'linear'))oneOf(w.linear,LINEAR_SPACES,'colorManagement.working.linear',err);
      if(has(w,'display'))oneOf(w.display,DISPLAY_SPACES,'colorManagement.working.display',err);
    }
  }
}

/** First problem with the raw JSON value: nesting depth (root container = 1), non-finite numbers, non-JSON values. */
function jsonShape(v:unknown,depth=0):string|undefined{
  if(v===null||typeof v==='string'||typeof v==='boolean')return;
  if(typeof v==='number')return Number.isFinite(v)?undefined:'graph.json enthält eine nicht endliche Zahl.';
  if(typeof v!=='object')return 'graph.json enthält einen Wert, der kein JSON ist.';
  if(depth+1>LIMITS.jsonDepth)return `graph.json ist tiefer als ${LIMITS.jsonDepth} Ebenen verschachtelt.`;
  for(const x of Array.isArray(v)?v:Object.values(v)){const r=jsonShape(x,depth+1);if(r)return r;}
}
/**
 * Pre-scan of the raw text before JSON.parse: nesting depth (so deep input never reaches a recursive parser) and duplicate
 * object keys, whose handling differs between parsers (RFC 8259 §4: "behavior … is unpredictable"). Syntax errors are left to JSON.parse.
 */
function scanText(text:string):string|undefined{
  const stack:(Set<string>|null)[]=[];let expectKey=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      let j=i+1;while(j<text.length&&text[j]!=='"'){if(text[j]==='\\')j++;j++;}
      if(j>=text.length)return;
      const top=stack[stack.length-1];
      if(top&&expectKey){
        let key:string;try{key=JSON.parse(text.slice(i,j+1)) as string;}catch{return;}
        if(top.has(key))return `graph.json enthält den Schlüssel ${q(key)} mehrfach im selben Objekt.`;
        top.add(key);expectKey=false;
      }
      i=j;continue;
    }
    if(c==='{'||c==='['){stack.push(c==='{'?new Set():null);expectKey=c==='{';if(stack.length>LIMITS.jsonDepth)return `graph.json ist tiefer als ${LIMITS.jsonDepth} Ebenen verschachtelt.`;}
    else if(c==='}'||c===']'){stack.pop();expectKey=false;}
    else if(c===',')expectKey=stack[stack.length-1] instanceof Set;
  }
}

/** Kahn order with ties broken by array position (§4.3). Returns the order and the ids left over by a cycle. */
function sortIndices(ids:string[],deps:string[][]){
  const index=new Map<string,number>();ids.forEach((id,i)=>{if(!index.has(id))index.set(id,i);});
  const done=ids.map(()=>false),order:number[]=[];
  for(;;){
    const next=ids.findIndex((_,i)=>!done[i]&&deps[i].every(d=>{const j=index.get(d);return j===undefined||done[j];}));
    if(next<0)break;done[next]=true;order.push(next);
  }
  return {order,cyclic:ids.filter((_,i)=>!done[i])};
}
const nodeDeps=(n:unknown)=>isObj(n)&&isObj(n.inputs)?Object.values(n.inputs).filter((r):r is string=>typeof r==='string'&&!r.startsWith('$')):[];

/** Topological evaluation order; ties keep array order (§4.3). Throws BuckError on a cycle. */
export function topoOrder(graph:BuckGraph):BuckNode[]{
  const {order,cyclic}=sortIndices(graph.nodes.map(n=>n.id),graph.nodes.map(nodeDeps));
  if(cyclic.length)throw new BuckError(`Der Graph enthält einen Zyklus (betroffen: ${list(cyclic)}).`);
  return order.map(i=>graph.nodes[i]);
}

/** All problems of a graph as German sentences in a fixed order; empty means valid. */
export function checkGraph(graph:BuckGraph):string[]{
  const errors:string[]=[],err:Report=m=>{if(errors.length<200&&!errors.includes(m))errors.push(m);},g=graph as unknown;
  const shape=jsonShape(g);if(shape)return [shape];
  if(!isObj(g))return ['graph.json muss ein JSON-Objekt sein.'];
  const bytes=new TextEncoder().encode(JSON.stringify(g)).length;
  if(bytes>LIMITS.graphBytes)err(`graph.json ist ${bytes} Bytes groß; erlaubt sind höchstens ${LIMITS.graphBytes}.`);
  const top=['format','formatVersion','minReaderVersion','meta','colorManagement','inputs','models','nodes','output'];
  closed(g,[...top,'fallback','timing'],'graph.json',err);need(g,top,'graph.json',err);
  if(has(g,'format')&&g.format!=='buck')err(`„format“ muss „buck“ sein, ist aber ${q(g.format)}.`);
  // §4.2: unknown MAJOR and minReaderVersion above this reader (1.0) are rejected.
  const version=(k:'formatVersion'|'minReaderVersion')=>{
    const v=g[k];if(!has(g,k))return;
    const m=typeof v==='string'?VERSION.exec(v):null;if(!m){err(`„${k}“ muss die Form „MAJOR.MINOR“ haben, ist aber ${q(v)}.`);return;}
    return [Number(m[1]),Number(m[2])] as const;
  };
  const fv=version('formatVersion'),mv=version('minReaderVersion');
  if(fv&&fv[0]!==1)err(`Formatversion ${q(g.formatVersion)} wird nicht unterstützt; dieser Reader kennt nur Version 1.`);
  if(mv&&(mv[0]>1||(mv[0]===1&&mv[1]>0)))err(`Die Datei verlangt mindestens Readerversion ${q(g.minReaderVersion)}; dieser Reader ist Version 1.0.`);
  if(mv&&mv[0]<1)err('„minReaderVersion“ muss mindestens „1.0“ sein.');
  if(fv&&mv&&(mv[0]>fv[0]||(mv[0]===fv[0]&&mv[1]>fv[1])))err('„minReaderVersion“ darf nicht über „formatVersion“ liegen.');
  if(has(g,'meta'))checkMeta(g.meta,err);
  if(has(g,'colorManagement'))checkColorManagement(g.colorManagement,err);
  const cm=isObj(g.colorManagement)?g.colorManagement:{},working=isObj(cm.working)?cm.working:{};

  const models=isObj(g.models)?g.models:{},inputs=isObj(g.inputs)?g.inputs:{};
  if(has(g,'models')&&!isObj(g.models))err('„models“ muss ein Objekt sein.');
  if(has(g,'inputs')&&!isObj(g.inputs))err('„inputs“ muss ein Objekt sein.');
  if(Object.keys(models).length>LIMITS.nodes)err(`Höchstens ${LIMITS.nodes} Modelle sind erlaubt.`);
  if(Object.keys(inputs).length>LIMITS.nodes)err(`Höchstens ${LIMITS.nodes} Eingaben sind erlaubt.`);
  for(const [id,m] of Object.entries(models))checkModel(id,m,err);
  for(const [name,d] of Object.entries(inputs))checkInput(name,d,inputs,models,err);

  const nodes:unknown[]=Array.isArray(g.nodes)?g.nodes:[];
  if(has(g,'nodes')&&!Array.isArray(g.nodes))err('„nodes“ muss eine Liste sein.');
  if(nodes.length>LIMITS.nodes)err(`Der Graph hat ${nodes.length} Knoten; erlaubt sind höchstens ${LIMITS.nodes}.`);
  const byId=new Map<string,Obj>(),seen=new Set<string>();
  nodes.forEach((n,i)=>{
    if(!isObj(n))return err(`nodes[${i}] muss ein Objekt sein.`);
    if(typeof n.id!=='string'||!ID.test(n.id)||RESERVED.has(n.id))return err(`nodes[${i}]: Die Knoten-ID ${q(n.id)} muss [a-zA-Z0-9_-]{1,64} entsprechen.`);
    if(seen.has(n.id))return err(`Die Knoten-ID ${q(n.id)} kommt mehrfach vor.`);
    seen.add(n.id);byId.set(n.id,n);
  });
  const known=(n:Obj):n is Obj&{type:NodeType}=>typeof n.type==='string'&&(NODE_TYPES as string[]).includes(n.type);
  // Unknown optional nodes are bypassed (§4.2): image passes through, anything else yields mask 0.
  const outKind=(n:Obj):PortKind=>known(n)?PORTS[n.type].output:isObj(n.inputs)&&has(n.inputs,'image')?'image':'scalar';
  const resolve=(ref:unknown):{kind?:PortKind;error?:string}=>{
    if(typeof ref!=='string')return {error:'muss eine Referenz (Text) sein'};
    if(ref==='$source')return {kind:'image'};
    if(ref.startsWith('$')){
      const name=ref.slice(1),d=has(inputs,name)?inputs[name]:undefined;
      if(d===undefined)return {error:`verweist auf die nicht deklarierte Eingabe ${q(ref)}`};
      return {kind:isObj(d)&&typeof d.kind==='string'?KIND_OF_INPUT[d.kind]:undefined};
    }
    const n=byId.get(ref);return n?{kind:outKind(n)}:{error:`verweist auf den unbekannten Knoten ${q(ref)}`};
  };
  const kindName:Record<PortKind,string>={image:'Bild',scalar:'Skalarfeld',vector3:'Vektorfeld'};

  nodes.forEach((n,i)=>{
    if(!isObj(n))return;
    const where=typeof n.id==='string'&&ID.test(n.id)?`Knoten ${q(n.id)}`:`nodes[${i}]`;
    closed(n,['id','type','inputs','params','amount','enabled','optional','label'],where,err);need(n,['id','type','inputs','params'],where,err);
    if(has(n,'amount'))animatable(n.amount,UNIT,false,`${where}: „amount“`,err);
    for(const k of ['enabled','optional'])if(has(n,k)&&typeof n[k]!=='boolean')err(`${where}: „${k}“ muss true oder false sein.`);
    if(has(n,'label'))text(n.label,`${where}: „label“`,LIMITS.nameChars,err);
    const isKnown=known(n);
    if(!isKnown){
      if(typeof n.type!=='string'||!TYPE_NAME.test(n.type))err(`${where}: ${q(n.type)} ist kein gültiger Knotentypname (Form „bereich.name@N“).`);
      else if(n.optional!==true)err(`${where}: Unbekannter Knotentyp ${q(n.type)}. Nur Knoten mit „optional“: true dürfen unbekannt sein; sie werden überbrückt.`);
      if(has(n,'params')&&!isObj(n.params))err(`${where}.params muss ein Objekt sein.`);
    }
    if(!isObj(n.inputs)){if(has(n,'inputs'))err(`${where}.inputs muss ein Objekt sein.`);}
    else{
      const ports=isKnown?PORTS[n.type].inputs:undefined;
      for(const [port,ref] of Object.entries(n.inputs)){
        const spec=ports?.find(p=>p.name===port);
        if(ports&&!spec){err(`${where}: ${n.type} hat keinen Eingang ${q(port)}.`);continue;}
        const r=resolve(ref);
        if(r.error){err(`${where}: Eingang ${q(port)} ${r.error}.`);continue;}
        const want=spec?.kind??(port==='image'?'image':undefined);
        if(want&&r.kind&&r.kind!==want)err(`${where}: Eingang ${q(port)} erwartet ein ${kindName[want]}, ${q(ref)} liefert aber ein ${kindName[r.kind]}.`);
      }
      for(const p of ports??[])if(!p.optional&&!has(n.inputs,p.name))err(`${where}: Pflichteingang ${q(p.name)} ist nicht verbunden.`);
    }
    if(isKnown&&has(n,'params')){
      checkParams(n.type,n.params,where,err,inputs);
      const p=isObj(n.params)?n.params:{},depthRef=isObj(n.inputs)?n.inputs.depth:undefined;
      if(n.type==='lens.dof@1'&&p.mode==='physical'&&typeof depthRef==='string'&&depthRef.startsWith('$')){
        const d=inputs[depthRef.slice(1)];
        if(isObj(d)&&d.semantics!=='metric')err(`${where}: Der Modus „physical“ braucht metrische Tiefe, ${q(depthRef)} ist aber ${q(d.semantics)}.`);
      }
    }
  });

  const out=g.output;
  if(has(g,'output')){
    const r=resolve(out);
    if(r.error)err(`„output“ ${r.error}.`);else if(r.kind&&r.kind!=='image')err(`„output“ muss ein Bild liefern, ${q(out)} liefert aber ein ${kindName[r.kind]}.`);
  }

  // DAG and working spaces (§4.3, §5.2.4, §8): the reader never inserts conversions, so every image edge must already match.
  const ids=nodes.map(n=>isObj(n)&&typeof n.id==='string'?n.id:''),{order,cyclic}=sortIndices(ids,nodes.map(nodeDeps));
  if(cyclic.length)err(`Der Graph enthält einen Zyklus (betroffen: ${list(cyclic)}).`);
  else if(isSpace(cm.input)){
    const spaces=new Map<string,SpaceName|undefined>(),spaceOf=(ref:unknown)=>ref==='$source'?cm.input as SpaceName:typeof ref==='string'?spaces.get(ref):undefined;
    for(const i of order){
      const n=nodes[i];if(!isObj(n)||typeof n.id!=='string'||!byId.has(n.id)||outKind(n)!=='image')continue;
      const inSpace=isObj(n.inputs)?spaceOf(n.inputs.image):undefined,p=isObj(n.params)?n.params:{},enabled=n.enabled!==false;
      let outSpace=inSpace;
      if(known(n)){
        const rule=PORTS[n.type].space,where=`Knoten ${q(n.id)}`;
        if(rule==='declared'){
          const [needs,gives]=n.type==='color.convert@1'?[p.from,p.to]:n.type==='color.lut3d@1'?[p.inputSpace,p.outputSpace]:[p.space,p.space];
          if(inSpace&&isSpace(needs)&&inSpace!==needs)err(`${where} erwartet ein Bild in ${q(needs)}, bekommt aber ${q(inSpace)}. Ein Reader fügt keine Konvertierung ein; davor gehört ein color.convert@1-Knoten.`);
          outSpace=enabled?(isSpace(gives)?gives:undefined):inSpace;
        }else if(rule==='linear'&&inSpace&&isSpace(working.linear)&&inSpace!==working.linear)err(`${where} (${n.type}) muss im linearen Arbeitsraum ${q(working.linear)} arbeiten, bekommt aber ${q(inSpace)}.`);
      }
      spaces.set(n.id,outSpace);
    }
    const final=spaceOf(out);
    if(final&&isSpace(cm.output)&&final!==cm.output&&resolve(out).kind==='image')err(`„output“ liefert ${q(final)}, colorManagement.output verlangt aber ${q(cm.output)}.`);
  }

  if(has(g,'fallback')){
    const fb=g.fallback;
    if(!isObj(fb))err('„fallback“ muss ein Objekt sein.');
    else{
      const k=['cube','inputSpace','outputSpace','covers','omits'];closed(fb,k,'fallback',err);need(fb,k,'fallback',err);
      if(has(fb,'cube'))archivePath(fb.cube,LUT_FILE,'fallback.cube',err);
      for(const s of ['inputSpace','outputSpace'])if(has(fb,s))oneOf(fb[s],SPACE_NAMES,`fallback.${s}`,err);
      const covered=new Set<string>();
      for(const s of ['covers','omits'])if(has(fb,s)){
        const ids2=fb[s];
        if(!Array.isArray(ids2)||ids2.length>LIMITS.nodes){err(`fallback.${s} muss eine Liste von Knoten-IDs sein.`);continue;}
        for(const id of ids2){
          if(typeof id!=='string'||!byId.has(id))err(`fallback.${s} nennt den unbekannten Knoten ${q(id)}.`);
          else if(covered.has(id))err(`fallback: Knoten ${q(id)} steht mehrfach in „covers“/„omits“.`);
          else covered.add(id);
        }
      }
    }
  }
  if(has(g,'timing')){
    const t=g.timing;
    if(!isObj(t))err('„timing“ muss ein Objekt sein.');
    else{
      closed(t,['reference','rate'],'timing',err);need(t,['reference'],'timing',err);
      if(has(t,'reference'))oneOf(t.reference,['clip-start','timecode'],'timing.reference',err);
      if(t.reference==='timecode'&&!has(t,'rate'))err('timing: Bei „timecode“ ist „rate“ Pflicht.');
      if(has(t,'rate'))num(t.rate,[0,1000],true,'timing.rate',err);
    }
  }
  return errors;
}

/** Strict parse of graph.json text; throws BuckError with the first problem (German). */
export function parseGraph(text:string):BuckGraph{
  const bytes=new TextEncoder().encode(text).length;
  if(bytes>LIMITS.graphBytes)throw new BuckError(`graph.json ist ${bytes} Bytes groß; erlaubt sind höchstens ${LIMITS.graphBytes}.`);
  const scan=scanText(text);if(scan)throw new BuckError(scan);
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new BuckError('graph.json ist kein gültiges JSON.');}
  const problems=checkGraph(value as BuckGraph);
  if(problems.length)throw new BuckError(problems[0]);
  return value as BuckGraph;
}
