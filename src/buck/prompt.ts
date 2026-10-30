import type { BuckGraph, BuckMeta, BuckNode, ColorManagement, ColorValue, DofParams, FogParams, InputDecl, RelightParams, RGB, SpaceName } from './types';
import { BuckError, FORMAT_VERSION, LIMITS, OFX_CONFIG } from './types';
import { parseLookPrompt } from '../color/prompt';
import { DEFAULT_SETTINGS } from '../color/engine';
import { convertPixel, lumaWeights } from './colorspace';
import { DEFAULT_DEPTH_MODEL, KNOWN_MODELS } from './depth/models';
/**
 * Local, deterministic text → .buck graph. Spatial phrases (fog, depth of field, relight) become nodes; whatever text is
 * left goes unchanged to parseLookPrompt. No network, no language model; same text always gives the same graph.
 * Default values follow the §13 example (tests/fixtures/buck/fargo-fog-warm.json); other numbers are editorial
 * defaults unless a comment names their source.
 */
const DEFAULT_CM:ColorManagement={config:OFX_CONFIG,input:'Rec.1886 Rec.709 - Display',output:'Rec.1886 Rec.709 - Display',working:{linear:'ACEScg',display:'Rec.1886 Rec.709 - Display'}};
const GENERATOR='Buckswood Auto LUT';
/** §13 fog color, given in ACEScg. */
const BLUE_GREY:RGB=[.78,.84,.92];
// Reference color temperatures: tungsten 3200 K, daylight 5600 K, shade/overcast ≈ 7500 K (common film-lighting conventions).
const K_WARM=3200,K_DAY=5600,K_COLD=7500;
/**
 * Background-at-infinity blur of a thin lens: c = f²/(N·(s−f)) (spec §5.3.2 with d → ∞), in image widths c/sensorWidth.
 * Reference camera (assumption, not measured): 50 mm on a 36 mm full-frame sensor focused at 2 m → 0.0347/N.
 */
const COC_AT_INFINITY=50*50/((2000-50)*36);
const DEFAULT_F=2.8,MAX_BLUR=.05,DEFAULT_MAX_BLUR=.02;

type Tokens=string[];
const tokens=(s:string):Tokens=>s.toLowerCase().split(/[^\p{L}\d]+/u).filter(Boolean);
const some=(t:Tokens,test:(w:string)=>boolean)=>t.some(test);
const word=(...words:string[])=>(w:string)=>words.includes(w);
const stem=(...stems:string[])=>(w:string)=>stems.some(s=>w.startsWith(s));
const part=(...parts:string[])=>(w:string)=>parts.some(s=>w.includes(s));
const or=(...tests:((w:string)=>boolean)[])=>(w:string)=>tests.some(f=>f(w));

const FOG=or(part('nebel','neblig','dunst'),word('fog','foggy','fogs','haze','hazy','mist','misty','mists'));
const DOF=or(part('tiefenschärfe','tiefenschaerfe','schärfentiefe','schaerfentiefe','unschärfe','unschaerfe','unscharf','bokeh','verschwommen','lamelle'),word('dof','blur','blurry','blurred','blades','defocus','defocused','unfocused'));
const LIGHT_DE=(w:string)=>w==='licht'||w==='lichts'||w.startsWith('lichtquelle')||w.startsWith('beleuchtung')||(w.endsWith('licht')&&w.length>5&&!w.startsWith('spitz'));
const LIGHT_EN=word('light','lighting','lit','keylight','backlight','backlit','rimlight','sidelight','relight');
const DIRECTIONAL=or(stem('gegenlicht','seitenlicht','streiflicht','oberlicht','unterlicht','kantenlicht'),word('backlight','backlit','rim','rimlight','sidelight','relight'));
const LEFT=word('links','linken','linke','linker','left'),RIGHT=word('rechts','rechten','rechte','rechter','right');
const TOP=or(word('oben','above','top','overhead'),stem('oberlicht')),BOTTOM=or(word('unten','below','beneath','underneath'),stem('unterlicht'));
const BACK=or(word('hinten','behind','back','backlight','backlit','rim','rimlight'),stem('gegenlicht','kantenlicht'));
const FRONT=word('vorne','vorn','frontal','front','frontlight');
const SIDE=or(stem('seitenlicht','streiflicht'),word('sidelight','side'));
const TARGET=or(stem('vordergrund','person','gesicht','figur','subjekt','motiv','darsteller','schauspieler','foreground','subject','face','actor'),word('people'));
const FOREGROUND=stem('vordergrund','foreground'),BACKGROUND=or(part('hintergrund'),stem('background'));
const DISTANT=or(BACKGROUND,word('hinten','ferne','fern','distance','distant','far','horizont','horizon'));
const EVERYWHERE=or(word('überall','ueberall','everywhere','ganze','ganzen','gesamte','gesamten','whole','entire','overall'));
const SOFT=or(stem('leicht','dezent','subtil','dünn','duenn','zart','schwach','gering'),word('etwas','bisschen','wenig','slight','slightly','subtle','thin','faint','gentle'));
const STRONG=or(stem('dicht','stark','dick','schwer','kräftig','kraeftig','intensiv','extrem'),word('heavy','thick','dense','strong','strongly','very','sehr','viel','bright','hell','helle','heller','hellem','hellen'));
const WARM=stem('warm','wärm','golden','gold','orange','amber','bernstein','tungsten','kunstlicht','kerze','candle');
const COLD=or(stem('kalt','kalte','kält','kühl','kuehl','cool','cold','mond','moon'),word('blau','blaue','blauer','blaues','blue','bluish','bläulich'));
const NEUTRAL=stem('neutral','grau','grey','gray','weiß','weiss','white','tageslicht','daylight');
const BLUE_GREY_WORD=or(part('blaugrau','bluegrey','bluegray','graublau','greyblue','grayblue'));
const WEICH=stem('weich','soft','diffus','diffuse','sanft','gentle'),HART=stem('hart','harte','hard','harsh','direkt','direct','crisp','knallig');
const SHARP=word('scharf','scharfe','scharfer','scharfen','sharp','focused','fokussiert'),FOCUS=or(stem('fokus','focus'),word('schärfe','schaerfe'));
const BLUR_WORD=or(part('unscharf','unschärfe','unschaerfe','verschwommen','bokeh'),word('blur','blurry','blurred','defocus','defocused','unfocused'));

const NUMBER_WORDS:Record<string,number>={null:0,fünf:5,fuenf:5,sechs:6,sieben:7,acht:8,neun:9,zehn:10,elf:11,zwölf:12,zwoelf:12,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
const BLADES_RE=/(\d{1,2}|null|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(?:blenden)?(?:lamellen|lamelle|blades|blade|bladed)/;
const SHAPES:[RegExp,number][]=[[/fünfeck|fuenfeck|pentagon/,5],[/sechseck|hexagon/,6],[/achteck|octagon/,8],[/\brund|\bkreis|round|circular/,0]];
const F_RE=/(?:\bblende\s*(?:f\s*\/?\s*)?|\baperture\s*(?:f\s*\/?\s*)?|\bf\s*\/\s*|\bf(?=\d))(\d{1,3}(?:[.,]\d{1,2})?)/;
const KELVIN_RE=/(\d{4,5})\s*(?:kelvin\b|k\b)/;
/** Clause separators: punctuation (not a decimal point/comma between digits) or a connecting word. */
const SEP=/((?:[;!?\n]|(?<!\d)[.,]|[.,](?!\d))+\s*|\s+(?:und|and|mit|with|sowie|plus|dazu|außerdem|ausserdem|also|aber|but|samt)\s+)/iu;

type Kind='fog'|'dof'|'relight';
interface Piece {text:string;lower:string;t:Tokens;kinds:Kind[];sep:string;}
interface Effect {kind:Kind;pieces:Piece[];}
const fmt=(x:number)=>String(Math.round(x*100)/100).replace('.',',');
const r4=(x:number)=>Math.round(x*1e4)/1e4;

function kindsOf(p:Piece):Kind[]{
  const t=p.t,out:Kind[]=[],fog=some(t,FOG);
  if(fog)out.push('fog');
  if(some(t,DOF)||F_RE.test(p.lower)||/depth of field|shallow focus|out of focus|bokeh/.test(p.lower)||(some(t,SHARP)&&some(t,or(FOREGROUND,BACKGROUND)))||(some(t,FOCUS)&&some(t,or(FOREGROUND,BACKGROUND,word('nah','near','close','hinten','vorne')))))out.push('dof');
  // English "light" next to a fog word is the adjective ("light fog"), not a light source.
  const light=some(t,LIGHT_DE)||some(t,w=>LIGHT_EN(w)&&!(fog&&w==='light'));
  if(some(t,DIRECTIONAL)||(light&&(some(t,or(LEFT,RIGHT,TOP,BOTTOM,BACK,FRONT,SIDE,TARGET))||/\b(von|from|aus)\b/.test(p.lower))))out.push('relight');
  return out;
}
/** Only modifier details (no own effect word): attaches to the effect named just before it ("Bokeh mit 6 Lamellen"). */
const isDetail=(p:Piece)=>some(p.t,or(LEFT,RIGHT,TOP,BOTTOM,BACK,FRONT,DISTANT,EVERYWHERE));
/** Kelvin and blade counts mean nothing to the look parser, so they attach across punctuation too. */
const isSpec=(p:Piece)=>KELVIN_RE.test(p.lower)||BLADES_RE.test(p.lower);
/** Pure strength/quality words belong to the effect that follows ("hartes, starkes Licht …"), else to the one before. */
const isModifier=(p:Piece)=>p.t.length>0&&p.t.every(or(SOFT,STRONG,WEICH,HART));

/** Splits the text into effect clauses and the remaining look text (original wording and separators kept). */
function analyse(text:string):{effects:Effect[];rest:string}{
  const raw=text.split(SEP),effects:Effect[]=[];let rest='',last:Effect|undefined,before:Effect|undefined,pending:Piece[]=[];
  const keep=(p:Piece)=>{rest+=(rest?p.sep:'')+p.text;};
  const flush=()=>{if(before)before.pieces.push(...pending);else pending.forEach(keep);pending=[];before=undefined;};
  for(let i=0;i<raw.length;i+=2){
    const sep=i>0?raw[i-1]:'',piece:Piece={text:raw[i],lower:raw[i].toLowerCase(),t:tokens(raw[i]),kinds:[],sep};
    piece.kinds=kindsOf(piece);
    const connector=i>0&&!/[;!?\n.,]/.test(sep);
    if(piece.kinds.length){
      for(const kind of piece.kinds){const e=effects.find(x=>x.kind===kind);if(e)e.pieces.push(...pending,piece);else effects.push({kind,pieces:[...pending,piece]});}
      pending=[];last=effects.find(x=>x.kind===piece.kinds[piece.kinds.length-1]);
    }else if(last&&(isSpec(piece)||(connector&&isDetail(piece))))last.pieces.push(piece);
    else if(isModifier(piece)){if(!pending.length)before=last;pending.push(piece);last=undefined;}
    else{flush();keep(piece);last=undefined;}
  }
  flush();
  return {effects,rest:rest.replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g,'')};
}

type Strength='soft'|'strong'|undefined;
const strengthOf=(t:Tokens):Strength=>some(t,SOFT)?'soft':some(t,STRONG)?'strong':undefined;
function kelvinOf(lower:string){
  const m=KELVIN_RE.exec(lower);if(!m)return;
  // validate.ts accepts 1667–25000 K (Kim et al. spline range).
  return Math.min(25000,Math.max(1667,Number(m[1])));
}

interface FogSpec {params:FogParams;mask?:{near:number;far:number;feather:number};label:string;}
function fogSpec(pieces:Piece[],linear:SpaceName):FogSpec{
  const t=pieces.flatMap(p=>p.t),lower=pieces.map(p=>p.lower).join(' '),strength=strengthOf(t),soft=strength==='soft'||t.includes('light');
  const background=some(t,DISTANT)&&!some(t,EVERYWHERE);
  const blueGrey=convertPixel(BLUE_GREY,'ACEScg',linear).map(r4) as RGB;
  const kelvin=kelvinOf(lower);let color:ColorValue=blueGrey,colorName='';
  if(kelvin!==undefined){color={kelvin};colorName=`${kelvin} K`;}
  else if(some(t,BLUE_GREY_WORD)){colorName='blaugrau';}
  else if(some(t,WARM)){color={kelvin:K_WARM};colorName=`warm ${K_WARM} K`;}
  else if(some(t,COLD)){color={kelvin:K_COLD};colorName=`kalt ${K_COLD} K`;}
  else if(some(t,NEUTRAL)){
    // Neutral grey with the same luminance as the default blue-grey.
    const w=lumaWeights(linear),y=r4(w[0]*blueGrey[0]+w[1]*blueGrey[1]+w[2]*blueGrey[2]);color=[y,y,y];colorName='neutral grau';
  }
  // §13 example values; "leicht"/"dicht" halve/double the density (editorial).
  const density=soft?1.1:strength==='strong'?4.4:2.2,maxOpacity=soft?.5:strength==='strong'?.9:.75;
  const params:FogParams={model:'exponential',start:background?.55:0,density,color,luminance:1.6,maxOpacity,skyProtect:.3};
  const label=['Nebel',background?'im Hintergrund':'überall',soft?'leicht':strength==='strong'?'dicht':'',colorName].filter(Boolean).join(' · ');
  return {params,mask:background?{near:.55,far:1,feather:.15}:undefined,label};
}

interface DofSpec {params:DofParams;label:string;notes:string[];}
function dofSpec(pieces:Piece[]):DofSpec{
  const t=pieces.flatMap(p=>p.t),lower=pieces.map(p=>p.lower).join(' '),notes:string[]=[];
  const fg=some(t,FOREGROUND),bg=some(t,BACKGROUND);
  // Focus far when the foreground is the blurred part or the background is named sharp / in focus.
  const blurred=some(t,BLUR_WORD),sharp=some(t,SHARP)||some(t,FOCUS);
  const focusFar=(fg&&blurred&&!bg)||(bg&&sharp&&!blurred)||(some(t,FOCUS)&&some(t,word('hinten','background','hintergrund'))&&!fg);
  const explicitSide=fg||bg;
  const m=F_RE.exec(lower);let fNumber=m?Number(m[1].replace(',','.')):undefined;
  if(fNumber!==undefined&&!(fNumber>=.5&&fNumber<=128)){notes.push(`Blende f/${fmt(fNumber)} außerhalb f/0,5…f/128, ignoriert`);fNumber=undefined;}
  const strength=strengthOf(t);
  let coc=COC_AT_INFINITY/(fNumber??DEFAULT_F);
  if(fNumber===undefined&&strength)coc*=strength==='soft'?.5:1.5;
  coc=Math.round(Math.min(MAX_BLUR,coc)*1e6)/1e6;
  let blades=0;
  const b=BLADES_RE.exec(lower);
  if(b){
    const n=/^\d+$/.test(b[1])?Number(b[1]):NUMBER_WORDS[b[1]];
    if(n===0||(n>=5&&n<=12))blades=n;else notes.push(`Bokeh mit ${n} Lamellen nicht möglich (0 oder 5–12), rund verwendet`);
  }else for(const [re,n] of SHAPES)if(re.test(lower)){blades=n;break;}
  // Far mode: without an explicit side both ends get the same CoC (one aperture); relative depth gives no better estimate.
  const params:DofParams={mode:'artistic',focus:focusFar?.8:.2,focusRange:.15,blurNear:focusFar||!explicitSide?coc:0,blurFar:focusFar?0:coc,
    maxBlur:Math.max(DEFAULT_MAX_BLUR,coc),blades,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0};
  const label=['Tiefenschärfe',focusFar?'Fokus hinten, Vordergrund unscharf':explicitSide?'Fokus vorn, Hintergrund unscharf':'Fokus vorn',
    fNumber!==undefined?`f/${fmt(fNumber)}`:strength==='soft'?'leicht':strength==='strong'?'stark':'',blades?`${blades} Lamellen`:''].filter(Boolean).join(' · ');
  return {params,label,notes};
}

interface RelightSpec {params:RelightParams;mask?:{near:number;far:number;feather:number};label:string;}
function relightSpec(pieces:Piece[]):RelightSpec{
  const t=pieces.flatMap(p=>p.t),lower=pieces.map(p=>p.lower).join(' ');
  const h=some(t,LEFT)?-1:some(t,RIGHT)?1:0,back=some(t,BACK),front=some(t,FRONT),top=some(t,TOP),bottom=some(t,BOTTOM),side=some(t,SIDE);
  // Spec §5.3.3: 0 = from the camera, −90 = left, +90 = right, ±180 = backlight. −70/20° for "von links" as in §13.
  const azimuth=back?(h?h*135:180):front?h*45:side?(h||-1)*90:h*70;
  const elevation=top?(h||back||front?60:75):bottom?-30:side&&some(t,stem('streif'))?5:20;
  const kelvin=kelvinOf(lower);let color:ColorValue=[1,1,1],colorName='neutral';
  if(kelvin!==undefined){color={kelvin};colorName=`${kelvin} K`;}
  else if(some(t,WARM)){color={kelvin:K_WARM};colorName=`warm ${K_WARM} K`;}
  else if(some(t,COLD)){color={kelvin:K_COLD};colorName=`kalt ${K_COLD} K`;}
  else if(some(t,stem('tageslicht','daylight'))){color={kelvin:K_DAY};colorName=`Tageslicht ${K_DAY} K`;}
  const strength=strengthOf(t.filter(w=>!WEICH(w))),soft=some(t,WEICH),hard=some(t,HART);
  const everywhere=some(t,EVERYWHERE),target=some(t,TARGET);
  const params:RelightParams={azimuth,elevation,color,intensity:strength==='soft'?.4:strength==='strong'?1.5:.8,softness:soft?.85:hard?.15:.6,mode:'add',preserveHighlights:.7};
  const dir=back?(h?`Gegenlicht ${h<0?'links':'rechts'}`:'Gegenlicht'):[front?'vorn':'',h<0?'links':h>0?'rechts':'',top?'oben':bottom?'unten':''].filter(Boolean).join(' ')||'vorn';
  const label=['Licht',back?dir:`von ${dir}`,colorName,soft?'weich':hard?'hart':'',strength==='soft'?'leicht':strength==='strong'?'stark':'',target?'auf Vordergrund':everywhere?'überall':''].filter(Boolean).join(' · ');
  // §13: relight on fore- and midground only; a named subject narrows that range (editorial).
  return {params,mask:everywhere?undefined:target?{near:0,far:.4,feather:.1}:{near:0,far:.6,feather:.12},label};
}

function depthInputs(relight:boolean){
  const id=DEFAULT_DEPTH_MODEL,pin=KNOWN_MODELS[id];
  if(!pin)throw new BuckError(`Das Standard-Tiefenmodell „${id}“ ist nicht registriert.`);
  const depth:InputDecl={kind:'depth',semantics:pin.output,required:false,sources:[{type:'host-clip',clip:'Depth'},{type:'cache'},{type:'estimate',model:id}],
    normalize:pin.output==='metric'?{mode:'none'}:{mode:'shot-percentile',low:2,high:98},onMissing:'bypass-dependents'};
  const inputs:Record<string,InputDecl>={depth};
  if(relight)inputs.normals={kind:'normals',frame:'camera',required:false,sources:[{type:'host-clip',clip:'Normals'},{type:'cache'},{type:'derive',method:'normals-from-depth@1',from:'depth',params:{smoothing:.002}}],onMissing:'bypass-dependents'};
  return {inputs,models:{[id]:structuredClone(pin)}};
}
const clip=(s:string,max:number)=>s.length>max?`${s.slice(0,max-1)}…`:s;
const defaultName=(text:string)=>clip(text.trim().replace(/\s+/g,' '),LIMITS.nameChars)||'Neuer Look';

/** A valid graph without effects: $source through an identity conversion (input = output space). */
export function emptyGraph(name:string):BuckGraph{
  const cm=structuredClone(DEFAULT_CM);
  return {format:'buck',formatVersion:FORMAT_VERSION,minReaderVersion:'1.0',meta:{name:defaultName(name),generator:GENERATOR},colorManagement:cm,inputs:{},models:{},
    nodes:[{id:'auto-identity',type:'color.convert@1',label:'Durchreichen',inputs:{image:'$source'},params:{from:cm.input,to:cm.output}}],output:'auto-identity'};
}

/**
 * Builds a graph in the order of spec §13: linearize → relight → fog → depth of field → back to display → look →
 * output space. Only needed nodes and inputs are created; masks are separate nodes placed before their consumer.
 * `base` contributes meta (prompt replaced) and colorManagement.
 */
export function promptToGraph(input:string,base?:BuckGraph):{graph:BuckGraph;understood:string[]}{
  const text=input.slice(0,LIMITS.promptChars),cm:ColorManagement=structuredClone(base?.colorManagement??DEFAULT_CM);
  const meta:BuckMeta=base?{...structuredClone(base.meta)}:{name:defaultName(text),generator:GENERATOR};
  if(text.trim())meta.prompt=text;else delete meta.prompt;
  const {effects,rest}=analyse(text),has=(k:Kind)=>effects.find(e=>e.kind===k);
  const look=rest?parseLookPrompt(rest):undefined,understood:string[]=look?.matched?[...look.understood]:[];
  const nodes:BuckNode[]=[];let cur='$source',space=cm.input;
  const convert=(to:SpaceName,id:string)=>{if(space===to)return;nodes.push({id,type:'color.convert@1',inputs:{image:cur},params:{from:space,to}});cur=id;space=to;};
  const mask=(id:string,m:{near:number;far:number;feather:number})=>{nodes.push({id,type:'mask.depthRange@1',inputs:{depth:'$depth'},params:{...m,invert:false}});return id;};
  const relightE=has('relight'),fogE=has('fog'),dofE=has('dof'),spatial=!!(relightE||fogE||dofE);
  if(spatial)convert(cm.working.linear,'auto-toLinear');
  if(relightE){
    const s=relightSpec(relightE.pieces),m=s.mask&&mask('nearMask',s.mask);
    nodes.push({id:'relight',type:'light.relight@1',label:clip(s.label,LIMITS.nameChars),inputs:{image:cur,normals:'$normals',...(m?{mask:m}:{})},params:s.params});
    cur='relight';understood.push(s.label);
  }
  if(fogE){
    const s=fogSpec(fogE.pieces,cm.working.linear),m=s.mask&&mask('bgMask',s.mask);
    nodes.push({id:'fog',type:'atmos.fog@1',label:clip(s.label,LIMITS.nameChars),inputs:{image:cur,depth:'$depth',...(m?{mask:m}:{})},params:s.params});
    cur='fog';understood.push(s.label);
  }
  if(dofE){
    const s=dofSpec(dofE.pieces);
    nodes.push({id:'dof',type:'lens.dof@1',label:clip(s.label,LIMITS.nameChars),inputs:{image:cur,depth:'$depth'},params:s.params});
    cur='dof';understood.push(s.label,...s.notes);
  }
  if(look?.matched){
    convert(cm.working.display,'auto-toDisplay');
    const base0=look.understood.find(u=>u.startsWith('Basis: '))?.slice(7);
    nodes.push({id:'look',type:'color.look@1',label:clip(base0??'Look',LIMITS.nameChars),inputs:{image:cur},
      params:{space,look:look.look,skinProtection:Math.max(DEFAULT_SETTINGS.skin,look.look.skinProtect),prompt:rest,understood:[...look.understood]}});
    cur='look';
  }
  convert(cm.output,nodes.some(n=>n.id==='auto-toDisplay')?'auto-toOutput':'auto-toDisplay');
  if(!nodes.length){nodes.push({id:'auto-identity',type:'color.convert@1',label:'Durchreichen',inputs:{image:'$source'},params:{from:space,to:space}});cur='auto-identity';}
  const aux=spatial?depthInputs(!!relightE):{inputs:{},models:{}};
  const graph:BuckGraph={format:'buck',formatVersion:FORMAT_VERSION,minReaderVersion:'1.0',meta,colorManagement:cm,inputs:aux.inputs,models:aux.models,nodes,output:cur};
  return {graph,understood};
}
