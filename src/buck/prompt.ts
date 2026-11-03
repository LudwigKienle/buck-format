import type { BuckGraph, BuckMeta, BuckNode, ColorManagement, ColorValue, DofParams, FogParams, GrainParams, HalationParams, InputDecl, PracticalsParams, RelightParams, RGB, SkyPreset, SpaceName, VignetteParams } from './types';
import { BuckError, FORMAT_VERSION, LIMITS, OFX_CONFIG } from './types';
import { parseLookPrompt } from '../color/prompt';
import { DEFAULT_SETTINGS } from '../color/engine';
import { NEUTRAL_LOOK, tintDirection } from '../color/look';
import type { LookSpec } from '../color/look';
import { SKY_PRESET_LABELS, skyPresetParams } from './nodes/sky';
import { convertPixel, lumaWeights } from './colorspace';
import { DEFAULT_DEPTH_MODEL, KNOWN_MODELS, depthSemantics } from './depth/models';
import { canRebuildChain, ensureConversions, ensureInputs, insertByLevel } from './editor/chain';
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

type Kind='fog'|'dof'|'relight'|'practicals'|'vignette'|'halation'|'grain';
interface Piece {text:string;lower:string;t:Tokens;kinds:Kind[];sep:string;}
interface Effect {kind:Kind;pieces:Piece[];}
const fmt=(x:number)=>String(Math.round(x*100)/100).replace('.',',');
const r4=(x:number)=>Math.round(x*1e4)/1e4;

/** Practical lights in the frame (lamps, candles, neon): light.practicals@1. */
const PRACTICAL=or(stem('lampe','laterne','kerze','glühbirne','gluehbirne','glühlampe','praktikab','practical','lamp','lantern','candle','bulb','neonlicht','neonröhre','neonroehre','lichterkette','straßenlaterne','strassenlaterne'),part('lampenlicht','kerzenlicht'),word('leuchte'));
/** Optics (§5.3.6–§5.3.8): film grain, vignette, halation and bloom/glow. */
const GRAIN=or(word('korn','körnung','koernung','körnig','koernig','kornig','grain','grainy','grained'),stem('filmkorn','filmkörn','filmgrain'));
const VIGNETTE=or(part('vignet'),stem('randabdunk','randabschatt','eckenabdunk'));
const VIGNETTE_PHRASE=/dunkle[rn]? (r(ä|ae)nder|ecken|bildr(ä|ae)nder)|dark(er|ened)? (corners|edges)/;
const HALATION=or(part('halation','lichthof','lichthöf','lichthoef'),word('halo','halos'));
const BLOOM=or(word('bloom','blooming','glow','glowing','glühen','gluehen','schimmer'),stem('überstrahl','ueberstrahl'));
function kindsOf(p:Piece):Kind[]{
  const t=p.t,out:Kind[]=[],fog=some(t,FOG),practical=some(t,PRACTICAL)||/\b(lichter|lights) (an|on)\b|\bneon[\s-]*(lights?|tubes?)\b/.test(p.lower);
  if(fog)out.push('fog');
  if(practical)out.push('practicals');
  if(some(t,GRAIN))out.push('grain');
  if(some(t,VIGNETTE)||VIGNETTE_PHRASE.test(p.lower))out.push('vignette');
  // "Lampen glühen" is the practicals glow, not a bloom.
  if(some(t,HALATION)||(!practical&&some(t,BLOOM)))out.push('halation');
  if(some(t,DOF)||F_RE.test(p.lower)||/depth of field|shallow focus|out of focus|bokeh/.test(p.lower)||(some(t,SHARP)&&some(t,or(FOREGROUND,BACKGROUND)))||(some(t,FOCUS)&&some(t,or(FOREGROUND,BACKGROUND,word('nah','near','close','hinten','vorne')))))out.push('dof');
  // English "light" next to a fog word is the adjective ("light fog"), not a light source.
  const light=some(t,LIGHT_DE)||some(t,w=>LIGHT_EN(w)&&!(fog&&w==='light'));
  if(!practical&&(some(t,DIRECTIONAL)||(light&&(some(t,or(LEFT,RIGHT,TOP,BOTTOM,BACK,FRONT,SIDE,TARGET))||/\b(von|from|aus)\b/.test(p.lower)))))out.push('relight');
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

interface FogSpec {params:FogParams;mask?:{near:number;far:number;feather:number};label:string;colored:boolean;}
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
  return {params,mask:background?{near:.55,far:1,feather:.15}:undefined,label,colored:colorName!==''};
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

/**
 * Time of day / sky (editor feature, not part of the format). First matching rule wins, so the specific skies come before
 * the generic "Nacht". Each phrase is removed from the text (with a leading preposition) before the rest is parsed.
 */
const TIME_RULES:[RegExp,SkyPreset][]=[
  [/sand[\s-]*sturm|sand[\s-]*storm|staub[\s-]*sturm|dust[\s-]*storm|haboob/,'sandstorm'],
  [/polarlicht\w*|nordlicht\w*|aurora( borealis)?|northern lights/,'aurora'],
  [/neon[\s-]*nacht|neon[\s-]*night|(groß|gross)?stadt[\s-]*nacht|city[\s-]*night/,'neon-night'],
  [/sternen[\s-]*himmel|sternen[\s-]*klar\w*|sternen[\s-]*nacht|milchstra(ß|ss)e|milky[\s-]*way|starry( sky| night)?|star[\s-]*field|stars/,'starry-night'],
  [/mond[\s-]*aufgang|moon[\s-]*rise|aufgehende[rn]? mond|rising moon/,'moonrise'],
  [/gewitter\w*|unwetter|sturm[\s-]*himmel|thunder[\s-]*storm|storm(y)?( sky)?|sturm/,'storm'],
  [/zwielicht|twilight|sp(ä|ae)te[rn]? d(ä|ae)mmerung/,'twilight'],
  [/blaue[nr]? stunde|blue[\s-]*hour|(abend|morgen)?d(ä|ae)mmerung|dusk|dawn/,'blue-hour'],
  [/sonnen[\s-]*untergang|sonnen[\s-]*aufgang|goldene[nr]? stunde|golden[\s-]*hour|sunset|sunrise|abend[\s-]*sonne|morgen[\s-]*sonne|abendrot|morgenrot/,'golden-hour'],
  [/bew(ö|oe)lkt\w*|bedeckt\w*|overcast|cloudy|wolkig\w*|graue[rnm]? himmel|gr[ae]y sky/,'overcast'],
  [/day[\s-]*for[\s-]*night|mitternacht|midnight|nachts|nacht|night(time)?|mond[\s-]*licht\w*|mond[\s-]*schein\w*|moonlit/,'night'],
  [/klare[rnm]? himmel|blaue[rnm]? himmel|clear[\s-]*sky|blue[\s-]*sky|klare[rnm]? tag|clear[\s-]*day|sonnige[rnm]? tag|sunny( day)?/,'clear-day'],
];
/** Light words that also name the night but stay in the text, so "Mondlicht von links" still becomes a relight. ("Moonlight" is a look.) */
const KEEP=/mond[\s-]*licht\w*|mond[\s-]*schein\w*|moonlit/;
const SKY_EXPLICIT=/neue[nr]? himmel|himmel ersetz\w*|himmels[\s-]*ersatz|sky[\s-]*replace\w*|replace (the )?sky|new sky/;
const LEAD=String.raw`(?:(?:bei|in der|in einer|in|am|zur|zum|im|unter|mit|at|by|during|in the|in a|under|with|a|an|the|einem|einer|einen|ein|eine|einem)\s+)*`;
const WORD_START=String.raw`(?<![\p{L}\d])`,WORD_END=String.raw`(?![\p{L}\d])`;
/** Detects the time of day and returns the text with every time/sky phrase removed. */
export function detectTimeOfDay(text:string):{preset?:SkyPreset;explicit:boolean;rest:string}{
  const lower=text.toLowerCase();let preset:SkyPreset|undefined;
  const find=(re:RegExp)=>new RegExp(WORD_START+'(?:'+re.source+')'+WORD_END,'u').test(lower);
  for(const [re,p] of TIME_RULES)if(find(re)){preset=p;break;}
  const explicit=find(SKY_EXPLICIT);
  if(!preset&&!explicit)return {explicit,rest:text};
  let rest=text;
  const keep=new RegExp('(?:'+KEEP.source+')$','iu');
  for(const re of [...TIME_RULES.map(r=>r[0]),SKY_EXPLICIT])rest=rest.replace(new RegExp(WORD_START+LEAD+'(?:'+re.source+')'+WORD_END,'giu'),m=>keep.test(m.trim())?m:' ');
  return {preset:preset??'clear-day',explicit,rest:rest.replace(/[ \t]+/g,' ').replace(/\s+([,.;!?])/g,'$1').trim()};
}
const tint=(rgb:RGB,amount:number)=>tintDirection(rgb).map(v=>v*amount) as RGB;
const C={blue:[.1,.35,1] as RGB,cyan:[0,.8,.85] as RGB,violet:[.6,.25,1] as RGB,orange:[1,.55,.08] as RGB,gold:[1,.78,.3] as RGB,magenta:[1,.15,.85] as RGB,green:[.15,.85,.25] as RGB,brown:[.75,.52,.3] as RGB};
interface Grade {key:number;contrast:number;saturation:number;shadows?:RGB;midtones?:RGB;highlights?:RGB;label:string;}
/**
 * Editorial grade shifts per time of day (display-referred LookSpec units). Night follows day-for-night practice: about two
 * stops darker (Low Key), clearly desaturated, restrained cool tint (Wikipedia „Day for night“; CineD, Videomaker guides).
 */
const GRADES:Record<SkyPreset,Grade>={
  'night':{key:-.25,contrast:.1,saturation:-.4,shadows:tint(C.blue,.05),midtones:tint(C.blue,.03),highlights:tint(C.cyan,.015),label:'Low Key, kühl-blau, entsättigt'},
  'starry-night':{key:-.25,contrast:.1,saturation:-.4,shadows:tint(C.blue,.05),midtones:tint(C.blue,.03),highlights:tint(C.cyan,.015),label:'Low Key, kühl-blau, entsättigt'},
  'moonrise':{key:-.2,contrast:.05,saturation:-.3,shadows:tint(C.blue,.045),midtones:tint(C.violet,.015),highlights:tint(C.orange,.015),label:'Low Key, kühl, warme Lichter'},
  'twilight':{key:-.15,contrast:0,saturation:-.2,shadows:tint(C.blue,.05),midtones:tint(C.violet,.02),label:'gedämpft, blau-violett'},
  'blue-hour':{key:-.1,contrast:0,saturation:-.1,shadows:tint(C.blue,.045),midtones:tint(C.blue,.025),highlights:tint(C.orange,.012),label:'kühl, leicht gedämpft'},
  'golden-hour':{key:.05,contrast:.05,saturation:.1,midtones:tint(C.orange,.035),highlights:tint(C.gold,.04),label:'warm, goldene Lichter'},
  'overcast':{key:-.05,contrast:-.2,saturation:-.2,highlights:tint(C.blue,.01),label:'weich, entsättigt'},
  'clear-day':{key:0,contrast:0,saturation:.05,label:'neutral'},
  'storm':{key:-.2,contrast:.2,saturation:-.3,shadows:tint(C.cyan,.04),midtones:tint(C.blue,.015),label:'Low Key, kühl, kontrastreich'},
  'sandstorm':{key:-.05,contrast:-.3,saturation:-.15,shadows:tint(C.brown,.02),midtones:tint(C.orange,.04),highlights:tint(C.gold,.03),label:'ocker, flach'},
  'aurora':{key:-.25,contrast:.1,saturation:-.35,shadows:tint(C.blue,.04),midtones:tint(C.green,.015),label:'Low Key, kühl-grün'},
  'neon-night':{key:-.2,contrast:.1,saturation:0,shadows:tint(C.violet,.045),highlights:tint(C.magenta,.02),label:'Low Key, violett-magenta'},
};
/** Grade on top of a parsed look: an explicitly named look keeps priority, so its tints dominate (time tints at 60 %). */
function applyGrade(look:LookSpec,g:Grade,hasLook:boolean):LookSpec{
  const k=hasLook?.6:1,add=(a:RGB,b?:RGB)=>b?a.map((v,i)=>Math.max(-.3,Math.min(.3,r4(v+b[i]*k)))) as RGB:[...a] as RGB,c=(x:number)=>r4(Math.max(-1,Math.min(1,x)));
  return {...look,shadows:add(look.shadows,g.shadows),midtones:add(look.midtones,g.midtones),highlights:add(look.highlights,g.highlights),
    key:c(look.key+g.key),contrast:c(look.contrast+g.contrast),saturation:c(look.saturation+g.saturation)};
}
/**
 * Scene exposure for dark skies (color.cdl@1 slope in the linear working space, before relight/practicals/sky, so the new sky
 * keeps its own exposure): day-for-night underexposes about 1.5–2.5 stops with a cool bias. tint is lin_rec709, normalized to Y = 1.
 */
const EXPOSURE:Partial<Record<SkyPreset,{ev:number;tint:RGB;sat:number}>>={
  'night':{ev:-1.8,tint:[.85,.97,1.4],sat:.75},'starry-night':{ev:-2,tint:[.85,.97,1.4],sat:.75},'aurora':{ev:-2,tint:[.85,1,1.3],sat:.75},
  'moonrise':{ev:-1.4,tint:[.9,.97,1.25],sat:.8},'neon-night':{ev:-1.6,tint:[1,.9,1.3],sat:.85},'twilight':{ev:-1.1,tint:[.9,.97,1.25],sat:.85},
  'storm':{ev:-.8,tint:[.95,1,1.12],sat:.85},'blue-hour':{ev:-.6,tint:[.92,.98,1.2],sat:.95},
};
/** Fog under a new sky: luminance shift (EV) and, unless the prompt named a fog color, a matching color (lin_rec709). */
const FOG_SHIFT:Record<SkyPreset,{ev:number;color?:RGB}>={
  'night':{ev:-4.4},'starry-night':{ev:-4.6},'moonrise':{ev:-3.6},'twilight':{ev:-3},'blue-hour':{ev:-1.6,color:[.55,.65,1]},
  'golden-hour':{ev:-.4,color:[1.2,.8,.5]},'overcast':{ev:-.4,color:[.85,.86,.88]},'clear-day':{ev:0},'storm':{ev:-1.8,color:[.5,.56,.66]},
  'sandstorm':{ev:-.2,color:[1.15,.72,.36]},'aurora':{ev:-4.6,color:[.4,.6,.7]},'neon-night':{ev:-3.4,color:[.8,.4,.85]},
};
/** Practical light colors in lin_rec709 (normalized by the node to luminance 1). */
const LAMP_COLORS:[(w:string)=>boolean,string,RGB][]=[
  [or(part('türkis','tuerkis','cyan','petrol'),word('teal')),'Türkis',[.04,.75,.7]],
  [or(word('rot','rote','roten','roter','rotem','rotes','red'),part('rötlich')),'Rot',[1,.05,.03]],
  [or(part('blau'),stem('blue')),'Blau',[.06,.18,1]],
  [or(part('grün','gruen'),stem('green')),'Grün',[.08,1,.15]],
  [or(part('magenta','pink','rosa')),'Magenta',[1,.1,.55]],
  [or(part('violett','lila'),stem('purple','violet')),'Violett',[.45,.08,1]],
  [part('orange'),'Orange',[1,.38,.04]],
  [or(part('gelb'),stem('yellow')),'Gelb',[1,.8,.12]],
];
const K_LAMP=2700,K_CANDLE=1900,K_NEON=6500;
interface PracticalsSpec {params:PracticalsParams;label:string;}
function practicalsSpec(pieces:Piece[],linear:SpaceName):PracticalsSpec{
  const t=pieces.flatMap(p=>p.t),lower=pieces.map(p=>p.lower).join(' '),strength=strengthOf(t),kelvin=kelvinOf(lower);
  const named=LAMP_COLORS.find(([test])=>some(t,test));
  let color:ColorValue={kelvin:K_LAMP},colorName=`warm ${K_LAMP} K`,recolor=.35;
  if(kelvin!==undefined){color={kelvin};colorName=`${kelvin} K`;recolor=.7;}
  else if(named){color=convertPixel(named[2],'lin_rec709_srgb',linear).map(r4) as RGB;colorName=named[1];recolor=.85;}
  else if(some(t,stem('kerze','candle'))){color={kelvin:K_CANDLE};colorName=`Kerzenlicht ${K_CANDLE} K`;recolor=.7;}
  else if(some(t,COLD)||some(t,stem('neon'))&&!some(t,WARM)){color={kelvin:K_NEON};colorName=`kalt ${K_NEON} K`;recolor=.7;}
  else if(some(t,WARM)){recolor=.6;}
  const params:PracticalsParams={threshold:.9,softness:.3,contrast:2,minSize:.002,maxSize:.04,intensity:strength==='soft'?.8:strength==='strong'?2.2:1.5,glow:1,glowRadius:.012,throw:.12,falloff:1,color,recolor};
  return {params,label:['Lampen leuchten',colorName,strength==='soft'?'dezent':strength==='strong'?'stark':''].filter(Boolean).join(' · ')};
}

/** Skin-tone protection named in the text ("Hauttöne schützen", "Hautschutz", "protect skin"): also set on relight. */
const SKIN_PROTECT=/haut[\s-]*schutz|skin[\s-]*protect\w*|(haut|skin|teint|gesicht|face)\S*\s+(\S+\s+)?(sch(ü|ue)tz|schon|protect|neutral|nat(ü|ue)rlich|erhalt|bewahr)|(sch(ü|ue)tz|protect|preserv)\S*\s+(\S+\s+)?(haut|skin)/;
/** Relight skinProtect when the text asks to protect skin tones (editorial: full protection, the node keeps 15 % of the effect). */
const SKIN_RELIGHT=1;

// Film-format grain sizes (image widths) and strengths (EV): editorial values; larger formats enlarge the negative less.
const FILM_FORMATS:[RegExp,string,number,number][]=[
  [/super[\s-]?8|\b8\s?mm\b/,'8 mm',.0022,.22],[/super[\s-]?16|\bs16\b|\b16\s?mm\b/,'16 mm',.0013,.14],
  [/\b(65|70)\s?mm\b|imax/,'65 mm',.0004,.05],[/\b35\s?mm\b/,'35 mm',.0007,.08],
];
interface OpticsSpec<P> {params:P;label:string;}
function grainSpec(pieces:Piece[]):OpticsSpec<GrainParams>{
  const t=pieces.flatMap(p=>p.t),lower=pieces.map(p=>p.lower).join(' '),strength=strengthOf(t);
  const fmtHit=FILM_FORMATS.find(([re])=>re.test(lower)),[,name,size0,ev0]=fmtHit??[/x/,'',.0007,.08];
  const fine=some(t,stem('fein','fine')),coarse=some(t,stem('grob','coarse','rough'));
  const mono=some(t,or(stem('monochrom','mono','schwarzweiß','schwarzweiss','luma'),word('sw','bw'))),colored=some(t,or(stem('farbig','bunt','chroma'),word('color','colour','colored','coloured')));
  const size=r4(size0*(fine?.75:coarse?1.4:1)),intensity=r4(ev0*(strength==='soft'?.6:strength==='strong'?1.6:1));
  const params:GrainParams={size,intensity,response:.8,chroma:mono?0:colored?.7:.2,seed:0,animate:true};
  const label=['Filmkorn',name,fine?'fein':coarse?'grob':'',strength==='soft'?'dezent':strength==='strong'?'stark':'',mono?'monochrom':colored?'farbig':''].filter(Boolean).join(' · ');
  return {params,label};
}
function vignetteSpec(pieces:Piece[]):OpticsSpec<VignetteParams>{
  const t=pieces.flatMap(p=>p.t),strength=strengthOf(t.filter(w=>!WEICH(w))),round=some(t,or(stem('rund','kreis','round','circular')));
  const exposure=strength==='soft'?-.5:strength==='strong'?-1.8:-1,softness=some(t,WEICH)?.6:some(t,HART)?.25:.45;
  const params:VignetteParams={exposure,radius:.3,softness,roundness:round?1:.3};
  return {params,label:['Vignette',`${fmt(exposure)} EV`,round?'rund':'',softness>.5?'weich':softness<.3?'hart':''].filter(Boolean).join(' · ')};
}
/** lin_rec709 red-orange of color-negative halation (red-sensitive layer re-exposed by light reflected from the film base). */
const HALATION_RED:RGB=[1,.18,.04];
function halationSpec(pieces:Piece[],linear:SpaceName):OpticsSpec<HalationParams>{
  const t=pieces.flatMap(p=>p.t),strength=strengthOf(t),halo=some(t,HALATION),bloom=some(t,BLOOM),k=strength==='soft'?.5:strength==='strong'?2:1;
  const params:HalationParams={threshold:.8,knee:1.5,radius:.006,intensity:halo?r4(.6*k):0,color:convertPixel(HALATION_RED,'lin_rec709_srgb',linear).map(r4) as RGB,bloom:bloom?r4(.3*k):0};
  if(bloom)params.bloomRadius=.012;
  const label=[halo&&bloom?'Halation & Bloom':halo?'Halation':'Bloom',strength==='soft'?'dezent':strength==='strong'?'stark':'',halo?'rötlicher Lichthof':''].filter(Boolean).join(' · ');
  return {params,label};
}

function depthInputs(relight:boolean){
  const id=DEFAULT_DEPTH_MODEL,pin=KNOWN_MODELS[id];
  if(!pin)throw new BuckError(`Das Standard-Tiefenmodell „${id}“ ist nicht registriert.`);
  const depth:InputDecl={kind:'depth',semantics:depthSemantics(pin),required:false,sources:[{type:'host-clip',clip:'Depth'},{type:'cache'},{type:'estimate',model:id}],
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

/* ------------------------------------------------------------------ time-of-day switch (recommendation 3)
 * Editor feature, not part of the format: the result consists of ordinary nodes. Nodes the switch creates have ids starting
 * with "tod-" (reserved prefix). Existing nodes it adapts (fog luminance/color, practicals threshold, an existing sky.replace)
 * keep the replaced values under the vendor field "x-buckswood-tod" ({params:{key:old value or null = absent}, label?}),
 * which §4.2 allows; "Wie aufgenommen" deletes the tod- nodes and restores those values. */
export const TOD_PREFIX='tod-';
export const TOD_KEY='x-buckswood-tod';
export type TimeOfDay=SkyPreset|'as-shot';
/** Order and labels of the switch. "Mittag" is the clear-day preset. */
export const TIME_OF_DAY_OPTIONS:{value:TimeOfDay;label:string}[]=[
  {value:'as-shot',label:'Wie aufgenommen'},{value:'golden-hour',label:'Goldene Stunde'},{value:'clear-day',label:'Mittag'},{value:'blue-hour',label:'Blaue Stunde'},
  {value:'twilight',label:'Zwielicht'},{value:'night',label:'Nacht'},{value:'starry-night',label:'Sternenhimmel'},{value:'moonrise',label:'Mondaufgang'},
  {value:'overcast',label:'Bewölkt'},{value:'storm',label:'Gewitter'},{value:'sandstorm',label:'Sandsturm'},{value:'aurora',label:'Polarlicht'},{value:'neon-night',label:'Neon-Nacht'},
];
interface TodRecord {params:Record<string,unknown>;label?:string|null;}
type Raw=Record<string,unknown>;
export const isTimeOfDayNode=(n:BuckNode)=>n.id.startsWith(TOD_PREFIX);
const todRecord=(n:BuckNode)=>(n as unknown as Raw)[TOD_KEY] as TodRecord|undefined;
/** Current switch position: the preset of the switch's sky (created or adapted), else "as-shot". */
export function timeOfDayOf(graph:BuckGraph):TimeOfDay{
  const sky=graph.nodes.find(n=>n.type==='sky.replace@1'&&(isTimeOfDayNode(n)||todRecord(n)));
  return sky?.type==='sky.replace@1'?sky.params.preset:'as-shot';
}
/** Sets params (and optionally the label) of an existing node, remembering the old values once under TOD_KEY. */
function adapt(n:BuckNode,params:Raw,label?:string):BuckNode{
  const old=n.params as unknown as Raw,rec:TodRecord=structuredClone(todRecord(n)??{params:{}});
  const next:Raw={...old};
  for(const [k,v] of Object.entries(params)){
    if(JSON.stringify(old[k])===JSON.stringify(v))continue;
    if(!(k in rec.params))rec.params[k]=k in old?structuredClone(old[k]):null;
    if(v===undefined)delete next[k];else next[k]=v;
  }
  if(label!==undefined&&label!==n.label&&!('label' in rec))rec.label=n.label??null;
  const out={...n,params:next,...label!==undefined?{label}:{}} as unknown as Raw;
  if(Object.keys(rec.params).length||'label' in rec)out[TOD_KEY]=rec;
  return out as unknown as BuckNode;
}
function restore(n:BuckNode):BuckNode{
  const rec=todRecord(n);if(!rec)return n;
  const params:Raw={...n.params as unknown as Raw};
  for(const [k,v] of Object.entries(rec.params)){if(v===null)delete params[k];else params[k]=structuredClone(v);}
  const out:Raw={...n as unknown as Raw,params};delete out[TOD_KEY];
  if('label' in rec){if(rec.label===null||rec.label===undefined)delete out.label;else out.label=rec.label;}
  return out as unknown as BuckNode;
}
/** "Wie aufgenommen": removes the switch's tod- nodes and restores adapted nodes. A graph without switch traces is returned unchanged. */
export function removeTimeOfDay(graph:BuckGraph):BuckGraph{
  if(!graph.nodes.some(n=>isTimeOfDayNode(n)||todRecord(n)))return graph;
  const nodes=graph.nodes.filter(n=>!isTimeOfDayNode(n)).map(restore);
  return ensureInputs(ensureConversions({...graph,nodes}));
}
/** Same luminance as the default blue-grey fog: a fog of this color counts as "not colored" and may follow the time of day. */
const defaultFogColor=(linear:SpaceName)=>convertPixel(BLUE_GREY,'ACEScg',linear).map(r4);
const sameColor=(a:ColorValue,b:number[])=>Array.isArray(a)&&a.every((v,i)=>Math.abs(v-b[i])<1e-3);
/**
 * Sets the coupled nodes of one time of day at once (the same rules the prompt uses): sky.replace with the preset values,
 * scene exposure (linear color.cdl@1) for dark skies, a grade shift (own color.look@1 before the user's look, at 60 % when
 * there is one), moonlight or a low sun (light.relight@1 with a depth mask) when the graph has no relight of its own, dust for a
 * sandstorm, and the fog luminance/color and practicals threshold of existing nodes. Always starts from removeTimeOfDay,
 * so switching presets never stacks. "as-shot" only removes. Nodes go to their level (insertByLevel); the result is valid.
 */
export function applyTimeOfDay(graph:BuckGraph,preset:TimeOfDay,opts:{skinProtect?:number}={}):{graph:BuckGraph;understood:string[]}{
  let g=removeTimeOfDay(graph);
  if(preset==='as-shot')return {graph:g,understood:[]};
  if(!canRebuildChain(g))throw new BuckError('Die Bildknoten dieses Looks bilden keine einfache Kette; der Tageszeit-Schalter kann keine Knoten einfügen.');
  const cm=g.colorManagement,linear=cm.working.linear,name=SKY_PRESET_LABELS[preset].label,understood=[`Tageszeit · ${name} · Himmel ersetzt`];
  const user=(type:BuckNode['type'])=>g.nodes.filter(n=>n.type===type&&!isTimeOfDayNode(n));
  const lin=(c:RGB)=>convertPixel(c,'lin_rec709_srgb',linear).map(r4) as RGB;
  const mapNodes=(fn:(n:BuckNode)=>BuckNode)=>{g={...g,nodes:g.nodes.map(fn)};};
  const expo=EXPOSURE[preset];
  if(expo){
    const w=lumaWeights('lin_rec709_srgb'),y=w[0]*expo.tint[0]+w[1]*expo.tint[1]+w[2]*expo.tint[2],slope=lin(expo.tint.map(v=>v/y*2**expo.ev) as RGB);
    const label=`Belichtung · ${fmt(expo.ev)} EV · kühl${expo.ev<=-1.4?' (Day-for-Night)':''}`;
    g=insertByLevel(g,{id:`${TOD_PREFIX}exposure`,type:'color.cdl@1',label,inputs:{image:'$source'},params:{slope,offset:[0,0,0],power:[1,1,1],saturation:expo.sat,style:'noClampFwd',space:linear}},{edge:'start'});
    understood.push(label);
    // Detection runs after the night exposure: the threshold follows it so the same lamps are found.
    const ids=new Set(user('light.practicals@1').map(n=>n.id));
    mapNodes(n=>ids.has(n.id)&&n.type==='light.practicals@1'&&typeof n.params.threshold==='number'?adapt(n,{threshold:r4(Math.max(.001,n.params.threshold*2**expo.ev))}):n);
  }
  if(!user('light.relight@1').length&&(preset==='night'||preset==='moonrise'||preset==='golden-hour')){
    const sun=preset==='golden-hour',skin=opts.skinProtect;
    const params:RelightParams=sun?{azimuth:-80,elevation:8,color:{kelvin:2800},intensity:.7,softness:.85,mode:'add',preserveHighlights:.7}
      :{azimuth:60,elevation:55,color:{kelvin:8000},intensity:.5,softness:.7,mode:'add',preserveHighlights:.7};
    if(skin)params.skinProtect=skin;
    const label=(sun?'Licht · tiefe Sonne von links · warm 2800 K':'Mondlicht · kühl 8000 K von oben rechts')+(skin?' · Hautschutz':'');
    const mask:BuckNode={id:`${TOD_PREFIX}lightMask`,type:'mask.depthRange@1',label:'Vorder- und Mittelgrund',inputs:{depth:'$depth'},params:{near:0,far:.6,feather:.12,invert:false}};
    g=insertByLevel(g,{id:`${TOD_PREFIX}light`,type:'light.relight@1',label,inputs:{image:'$source',normals:'$normals',mask:mask.id},params},{edge:'start',masks:[mask]});
    understood.push(label);
  }
  const skyParams=skyPresetParams(preset,linear),skyLabel=clip(`Himmel · ${name}`,LIMITS.nameChars),own=user('sky.replace@1')[0];
  if(own&&own.type==='sky.replace@1'){
    // An existing sky keeps source, file, horizon, depth threshold and edge; the preset sets its look (like the inspector).
    const {source:_s,skyDepth:_d,edge:_e,...look}=skyParams;void _s;void _d;void _e;
    mapNodes(n=>n===own?adapt(n,{...look,moon:look.moon}):n);
  }else g=insertByLevel(g,{id:`${TOD_PREFIX}sky`,type:'sky.replace@1',label:skyLabel,inputs:{image:'$source',depth:'$depth'},params:skyParams},{edge:'start'});
  const fogs=user('atmos.fog@1'),shift=FOG_SHIFT[preset];
  if(fogs.length){
    const ids=new Set(fogs.map(n=>n.id)),def=defaultFogColor(linear);
    mapNodes(n=>{
      if(!ids.has(n.id)||n.type!=='atmos.fog@1'||typeof n.params.luminance!=='number'||shift.ev===0&&!shift.color)return n;
      const recolor=shift.color&&sameColor(n.params.color,def);
      return adapt(n,{luminance:r4(n.params.luminance+shift.ev),...recolor?{color:lin(shift.color!)}:{}},n.label?clip(`${n.label} · ${name}`,LIMITS.nameChars):undefined);
    });
  }else if(preset==='sandstorm'){
    const label='Staub · überall · dicht · ocker';
    g=insertByLevel(g,{id:`${TOD_PREFIX}haze`,type:'atmos.fog@1',label,inputs:{image:'$source',depth:'$depth'},params:{model:'exponential',start:.05,density:3.5,color:lin([1.15,.72,.36]),luminance:1.4,maxOpacity:.85,skyProtect:0}},{edge:'end'});
    understood.push(label);
  }
  const grade=GRADES[preset];
  if(preset!=='clear-day'){
    const hasLook=user('color.look@1').length>0,look=applyGrade({...NEUTRAL_LOOK,shadows:[0,0,0],midtones:[0,0,0],highlights:[0,0,0]},grade,hasLook);
    const chip=`Grade · ${name}: ${grade.label}`;
    g=insertByLevel(g,{id:`${TOD_PREFIX}grade`,type:'color.look@1',label:clip(`Grade · ${name}`,LIMITS.nameChars),inputs:{image:'$source'},
      params:{space:cm.working.display,look,skinProtection:DEFAULT_SETTINGS.skin,understood:[chip]}},{edge:'start'});
    understood.push(chip);
  }
  return {graph:ensureInputs(g),understood};
}

/**
 * Builds a graph in the order of spec §13: linearize → relight → lamps → fog → depth of field → vignette → halation → grain →
 * back to display → look → output space. Only needed nodes and inputs are created; masks are separate nodes placed before
 * their consumer. A time of day is applied afterwards with applyTimeOfDay (same nodes as the editor switch, ids "tod-").
 * `base` contributes meta (prompt replaced) and colorManagement.
 */
export function promptToGraph(input:string,base?:BuckGraph):{graph:BuckGraph;understood:string[]}{
  const text=input.slice(0,LIMITS.promptChars),cm:ColorManagement=structuredClone(base?.colorManagement??DEFAULT_CM);
  const meta:BuckMeta=base?{...structuredClone(base.meta)}:{name:defaultName(text),generator:GENERATOR};
  if(text.trim())meta.prompt=text;else delete meta.prompt;
  const time=detectTimeOfDay(text),preset=time.preset;
  const {effects,rest}=analyse(time.rest),has=(k:Kind)=>effects.find(e=>e.kind===k);
  const parsed=rest?parseLookPrompt(rest):undefined,look=parsed?.matched?parsed:undefined,skin=SKIN_PROTECT.test(text.toLowerCase());
  const understood:string[]=[];
  if(look)understood.push(...look.understood);
  const nodes:BuckNode[]=[];let cur='$source',space=cm.input;
  const convert=(to:SpaceName,id:string)=>{if(space===to)return;nodes.push({id,type:'color.convert@1',inputs:{image:cur},params:{from:space,to}});cur=id;space=to;};
  const mask=(id:string,m:{near:number;far:number;feather:number})=>{nodes.push({id,type:'mask.depthRange@1',inputs:{depth:'$depth'},params:{...m,invert:false}});return id;};
  const push=(id:string,node:Omit<BuckNode,'id'|'inputs'>&{inputs?:Record<string,string>},chips:string[])=>{
    nodes.push({...node,id,inputs:{image:cur,...node.inputs}} as BuckNode);cur=id;understood.push(...chips);
  };
  const relightE=has('relight'),fogE=has('fog'),dofE=has('dof'),practE=has('practicals'),vigE=has('vignette'),haloE=has('halation'),grainE=has('grain');
  const depthUsed=!!(relightE||fogE||dofE);
  if(depthUsed||practE||vigE||haloE||grainE)convert(cm.working.linear,'auto-toLinear');
  if(relightE){
    const s=relightSpec(relightE.pieces);
    if(skin){s.params.skinProtect=SKIN_RELIGHT;s.label+=' · Hautschutz';}
    const m=s.mask&&mask('nearMask',s.mask);
    push('relight',{type:'light.relight@1',label:clip(s.label,LIMITS.nameChars),inputs:{normals:'$normals',...(m?{mask:m}:{})},params:s.params},[s.label]);
  }
  if(practE){
    const s=practicalsSpec(practE.pieces,cm.working.linear);
    push('practicals',{type:'light.practicals@1',label:clip(s.label,LIMITS.nameChars),inputs:depthUsed||preset?{depth:'$depth'}:{},params:s.params},[s.label]);
  }
  if(fogE){
    const s=fogSpec(fogE.pieces,cm.working.linear),m=s.mask&&mask('bgMask',s.mask);
    push('fog',{type:'atmos.fog@1',label:clip(s.label,LIMITS.nameChars),inputs:{depth:'$depth',...(m?{mask:m}:{})},params:s.params},[s.label]);
  }
  if(dofE){
    const s=dofSpec(dofE.pieces);
    push('dof',{type:'lens.dof@1',label:clip(s.label,LIMITS.nameChars),inputs:{depth:'$depth'},params:s.params},[s.label,...s.notes]);
  }
  if(vigE){const s=vignetteSpec(vigE.pieces);push('vignette',{type:'lens.vignette@1',label:clip(s.label,LIMITS.nameChars),params:s.params},[s.label]);}
  if(haloE){const s=halationSpec(haloE.pieces,cm.working.linear);push('halation',{type:'film.halation@1',label:clip(s.label,LIMITS.nameChars),params:s.params},[s.label]);}
  if(grainE){const s=grainSpec(grainE.pieces);push('grain',{type:'film.grain@1',label:clip(s.label,LIMITS.nameChars),params:s.params},[s.label]);}
  if(look){
    convert(cm.working.display,'auto-toDisplay');
    const base0=look.understood.find(u=>u.startsWith('Basis: '))?.slice(7);
    nodes.push({id:'look',type:'color.look@1',label:clip(base0??'Look',LIMITS.nameChars),inputs:{image:cur},
      params:{space,look:look.look,skinProtection:Math.max(DEFAULT_SETTINGS.skin,look.look.skinProtect),prompt:rest,understood:[...look.understood]}});
    cur='look';
  }
  convert(cm.output,nodes.some(n=>n.id==='auto-toDisplay')?'auto-toOutput':'auto-toDisplay');
  if(!nodes.length){nodes.push({id:'auto-identity',type:'color.convert@1',label:'Durchreichen',inputs:{image:'$source'},params:{from:space,to:space}});cur='auto-identity';}
  const aux=depthUsed?depthInputs(!!relightE):{inputs:{},models:{}};
  let graph:BuckGraph={format:'buck',formatVersion:FORMAT_VERSION,minReaderVersion:'1.0',meta,colorManagement:cm,inputs:aux.inputs,models:aux.models,nodes,output:cur};
  if(preset){
    const r=applyTimeOfDay(graph,preset,{skinProtect:skin?SKIN_RELIGHT:undefined});
    graph=r.graph;understood.unshift(r.understood[0]);understood.push(...r.understood.slice(1));
  }
  return {graph,understood};
}
