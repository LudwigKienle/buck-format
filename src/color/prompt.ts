import type { RGB } from './spaces';
import { clamp } from './spaces';
import { NEUTRAL_LOOK, tintDirection } from './look';
import type { LookSpec } from './look';
/**
 * Local, deterministic interpretation of a German/English look description. No network and no
 * language model: known film/series names provide an editorial starting point, explicit zone
 * instructions ("Schatten grün-blau", "Hauttöne neutral") override it.
 */
export interface PromptResult {look:LookSpec;understood:string[];matched:boolean;}
type Zone='shadows'|'midtones'|'highlights';
type Subject=Zone|'skin'|'white'|'global';
interface Hue {name:string;rgb:RGB;test:(token:string)=>boolean;}
const has=(...stems:string[])=>(t:string)=>stems.some(s=>t.includes(s));
const starts=(...stems:string[])=>(t:string)=>stems.some(s=>t.startsWith(s));
const exact=(...words:string[])=>(t:string)=>words.includes(t);
const any=(...tests:((t:string)=>boolean)[])=>(t:string)=>tests.some(f=>f(t));
const HUES:Hue[]=[
  {name:'türkis',rgb:[0,.8,.85],test:any(has('türkis','tuerkis','petrol','cyan'),exact('teal'))},
  {name:'grün',rgb:[.15,.85,.25],test:any(has('grün','gruen'),starts('green'))},
  {name:'blau',rgb:[.1,.35,1],test:any(has('blau'),starts('blue'))},
  {name:'gelb',rgb:[1,.92,.1],test:any(has('gelb'),starts('yellow'))},
  {name:'orange',rgb:[1,.55,.08],test:has('orange')},
  {name:'gold',rgb:[1,.78,.3],test:any(starts('gold'),exact('golden'))},
  {name:'bernstein',rgb:[1,.65,.2],test:any(has('bernstein'),starts('amber'))},
  {name:'rot',rgb:[1,.12,.12],test:any(exact('rot','rote','roten','roter','rotes','red','reds'),starts('rötlich','reddish'),(t:string)=>t.length>4&&t.endsWith('rot'))},
  {name:'magenta',rgb:[1,.15,.85],test:has('magenta')},
  {name:'rosa',rgb:[1,.45,.75],test:any(starts('rosa','rosig','pink'))},
  {name:'violett',rgb:[.6,.25,1],test:any(has('violett'),starts('lila','purple','violet'))},
  {name:'warm',rgb:[1,.62,.32],test:any(starts('warm','wärm'))},
  {name:'kühl',rgb:[.3,.55,1],test:any(starts('kühl','kuehl','kalt','kält','cool','cold'))},
  {name:'braun',rgb:[.75,.52,.3],test:any(starts('braun','brown','sepia'))},
];
const SUBJECTS:[Subject,(t:string)=>boolean][]=[
  ['shadows',any(starts('schatten','shadow','tiefen','schwärz'),exact('lows','blacks','schwarz'))],
  ['midtones',any(starts('mittelt','midtone','mitten'),exact('mids'))],
  ['highlights',any(starts('lichter','highlight','spitzlicht','lichteinfall','reflex','reflect','glanz','glow','sonne','sun','practical','lampe'),exact('licht','light'))],
  ['skin',any(starts('haut','skin','gesicht','teint'),exact('face','faces'))],
  ['white',any(starts('weiß','weiss','white','schnee','snow'))],
];
const NEGATE=exact('als','than','statt','anstatt','instead','nicht','not','kein','keine','keinen','ohne','no','without');
const SOFT=exact('leicht','leichte','leichtes','etwas','subtil','subtile','dezent','dezente','bisschen','sanft','sanfte','slight','slightly','subtle','soft','hint');
const STRONG=exact('sehr','stark','starke','starkes','extrem','strong','strongly','very','deutlich','deutliche','intensiv','intensive','heavy');
const RATHER=exact('eher','rather','tendenziell','mehr');
const CLEAN=any(starts('sauber','clean','rein','klar','neutral','natürlich','natural','pur'));
const ZONE_AMOUNT:Record<Zone,number>={shadows:.06,midtones:.035,highlights:.055};
const ZONE_LABEL:Record<Zone,string>={shadows:'Schatten',midtones:'Mitteltöne',highlights:'Lichter'};
const tint=(rgb:RGB,amount:number)=>tintDirection(rgb).map(v=>v*amount) as RGB;
const blend=(...colors:RGB[])=>colors.reduce((a,c)=>{const d=tintDirection(c);return a.map((v,i)=>v+d[i]) as RGB;},[0,0,0] as RGB);
interface Preset {label:string;test:RegExp;look:Partial<LookSpec>;}
const C={teal:[0,.8,.85] as RGB,blue:[.1,.35,1] as RGB,cyanBlue:[.05,.6,1] as RGB,green:[.15,.85,.25] as RGB,yellow:[1,.92,.1] as RGB,orange:[1,.55,.08] as RGB,red:[1,.12,.12] as RGB,magenta:[1,.15,.85] as RGB,pink:[1,.45,.75] as RGB,warm:[1,.62,.32] as RGB,brown:[.75,.52,.3] as RGB};
/** Editorial approximations of well-known grades, not measured from the productions. */
const PRESETS:Preset[]=[
  {label:'Fargo · kalte Winterpalette, sauberes Schnee-Weiß',test:/fargo/,look:{shadows:tint(C.cyanBlue,.045),midtones:tint(C.blue,.012),whiteClean:.8,saturation:-.25,key:.2,contrast:-.05,skinProtect:.6}},
  {label:'The Matrix · Grünstich, harter Kontrast',test:/matrix/,look:{shadows:tint(C.green,.045),midtones:tint(C.green,.04),saturation:-.15,contrast:.25,key:-.15}},
  {label:'Amélie · warmes Gelb-Grün, satt',test:/am[ée]lie/,look:{shadows:tint(C.green,.025),midtones:tint(blend(C.yellow,C.green),.025),highlights:tint(C.orange,.04),saturation:.3,skinProtect:.4}},
  {label:'Mad Max: Fury Road · Teal & Orange, satt',test:/fury road|mad max/,look:{shadows:tint(C.teal,.055),highlights:tint(C.orange,.055),saturation:.35,contrast:.35}},
  {label:'Blade Runner 2049 · orangener Dunst, entsättigt',test:/blade ?runner/,look:{shadows:tint(C.teal,.025),midtones:tint(C.orange,.045),highlights:tint(C.orange,.03),saturation:-.15,contrast:-.1}},
  {label:'Joker · grünlich-gelbe Mitten, Teal-Schatten',test:/joker/,look:{shadows:tint(C.teal,.04),midtones:tint(blend(C.green,C.yellow),.03),saturation:-.15,contrast:.15,key:-.3}},
  {label:'Drive · Teal-Schatten, Magenta-Lichter',test:/\bdrive\b(?! my car)/,look:{shadows:tint(C.teal,.05),highlights:tint(C.pink,.045),contrast:.2,key:-.3}},
  {label:'Breaking Bad · gelber Mexiko-Look',test:/breaking bad/,look:{midtones:tint(C.yellow,.04),highlights:tint(C.yellow,.05),saturation:.15,contrast:.2}},
  {label:'Sicario · entsättigt, staubig-warm',test:/sicario/,look:{shadows:tint(C.teal,.02),midtones:tint(C.brown,.025),saturation:-.35,contrast:.15}},
  {label:'The Revenant · kaltes natürliches Licht',test:/revenant/,look:{shadows:tint(C.blue,.04),midtones:tint(C.blue,.018),saturation:-.35,key:-.1,skinProtect:.5}},
  {label:'Dune · warme Wüste, entsättigt',test:/\bdune\b/,look:{midtones:tint(C.orange,.035),highlights:tint(C.yellow,.03),saturation:-.2,contrast:-.1}},
  {label:'Moonlight · Teal und Magenta, satt',test:/moonlight/,look:{shadows:tint(C.teal,.05),highlights:tint(C.magenta,.03),saturation:.3,contrast:.25}},
  {label:'Grand Budapest Hotel · Pastell-Rosa, hell',test:/grand budapest/,look:{midtones:tint(C.pink,.02),highlights:tint(C.pink,.03),saturation:.15,key:.3,contrast:-.15}},
  {label:'Se7en · Bleach Bypass, grünlich, dunkel',test:/se7en|\bseven\b/,look:{shadows:tint(C.green,.04),midtones:tint(blend(C.yellow,C.green),.03),saturation:-.35,contrast:.35,key:-.5}},
  {label:'Mr. Robot · kalt, grün-teal',test:/mr\.? ?robot/,look:{shadows:tint(C.teal,.04),midtones:tint(C.green,.02),saturation:-.2}},
  {label:'Children of Men · entsättigt, kühl',test:/children of men/,look:{shadows:tint(C.teal,.03),saturation:-.45,contrast:.1}},
  {label:'The Batman · rot-orange, Low Key',test:/batman/,look:{shadows:tint(C.red,.02),midtones:tint(blend(C.orange,C.red),.04),saturation:-.1,contrast:.3,key:-.6}},
  {label:'Chernobyl · grünlich, entsättigt',test:/chernobyl|tschernobyl/,look:{shadows:tint(C.teal,.03),midtones:tint(C.green,.035),saturation:-.35}},
  {label:'John Wick · Neon, Teal und Magenta',test:/john wick/,look:{shadows:tint(C.teal,.05),highlights:tint(C.magenta,.035),contrast:.3,key:-.3}},
  {label:'In the Mood for Love · tiefes Rot, warm',test:/mood for love/,look:{midtones:tint(C.red,.035),highlights:tint(C.yellow,.03),saturation:.25,key:-.3}},
  {label:'Skyfall · Teal & Orange, kontrastreich',test:/skyfall/,look:{shadows:tint(C.teal,.04),highlights:tint(C.orange,.04),contrast:.25}},
  {label:'Arrival · neblig, kühl, entsättigt',test:/arrival/,look:{shadows:tint(C.blue,.03),saturation:-.35,key:.15,contrast:-.2,whiteClean:.5}},
  {label:'Teal & Orange',test:/teal ?(&|and|und|\+) ?orange|thielen ?orange/,look:{shadows:tint(C.teal,.055),highlights:tint(C.orange,.05),skinProtect:.6}},
  {label:'Bleach Bypass',test:/bleach ?bypass|bleach/,look:{saturation:-.5,contrast:.4}},
  {label:'Nordic Noir · kalt, entsättigt',test:/nordic noir|skandinavisch|scandinavian/,look:{shadows:tint(C.cyanBlue,.045),midtones:tint(C.blue,.015),saturation:-.4,contrast:.1,key:-.2}},
  {label:'Neon / Cyberpunk · Teal und Magenta',test:/cyberpunk|neon/,look:{shadows:tint(C.teal,.05),highlights:tint(C.magenta,.045),saturation:.25,contrast:.3,key:-.3}},
  {label:'70er Film · warm, gedeckt',test:/70er|siebziger|70s|seventies|vintage|kodak/,look:{shadows:tint(C.brown,.03),highlights:tint(C.warm,.035),saturation:-.15,contrast:-.15}},
  {label:'Pastell · hell, weich',test:/pastell|pastel/,look:{saturation:-.25,key:.35,contrast:-.3}},
];
interface Segment {subject?:Subject;colors:RGB[];names:string[];negated:RGB[];negatedNames:string[];scale:number;clean:boolean;}
const newSegment=():Segment=>({colors:[],names:[],negated:[],negatedNames:[],scale:1,clean:false});
function segments(text:string):Segment[]{
  const out:Segment[]=[];
  for(const clause of text.split(/[,.;:!?\n]+/)){
    let seg=newSegment(),negate=false;
    for(const token of clause.split(/[^\p{L}\d&]+/u).filter(Boolean)){
      const subject=SUBJECTS.find(([,test])=>test(token))?.[0];
      if(subject){
        if(seg.subject&&seg.subject!==subject){out.push(seg);seg=newSegment();negate=false;}
        seg.subject=subject;continue;
      }
      if(NEGATE(token)){negate=true;continue;}
      if(SOFT(token))seg.scale*=.55;else if(STRONG(token))seg.scale*=1.5;else if(RATHER(token))seg.scale*=.8;
      if(CLEAN(token))seg.clean=true;
      for(const hue of HUES)if(hue.test(token)){if(negate){seg.negated.push(hue.rgb);seg.negatedNames.push(hue.name);}else{seg.colors.push(hue.rgb);seg.names.push(hue.name);}}
    }
    out.push(seg);
  }
  return out;
}
const scaled=(rgb:RGB,amount:number)=>{const d=tintDirection(rgb);return d.map(v=>v*amount) as RGB;};
const hyphen=(names:string[])=>[...new Set(names)].join('-');
export function parseLookPrompt(input:string):PromptResult {
  const text=input.toLowerCase().replace(/high[\s-]*key/g,' highkey ').replace(/low[\s-]*key/g,' lowkey ').replace(/schwarz[\s-]*wei(ß|ss)|black (and|&) white|monochrom\w*|b&w/g,' monochrome ');
  const look:LookSpec={...NEUTRAL_LOOK,shadows:[0,0,0],midtones:[0,0,0],highlights:[0,0,0]},understood:string[]=[];
  for(const preset of PRESETS)if(preset.test.test(text)){
    const p=preset.look;
    for(const zone of ['shadows','midtones','highlights'] as Zone[])if(p[zone])look[zone]=look[zone].map((v,i)=>v+p[zone]![i]) as RGB;
    look.whiteClean=Math.max(look.whiteClean,p.whiteClean||0);look.skinProtect=Math.max(look.skinProtect,p.skinProtect||0);
    look.saturation+=p.saturation||0;look.contrast+=p.contrast||0;look.key+=p.key||0;
    understood.push(`Basis: ${preset.label}`);
  }
  const explicit=new Set<Zone>();
  for(const seg of segments(text)){
    const subject=seg.subject||'global',hasColor=seg.colors.length>0;
    if(subject==='skin'){
      if(seg.clean||!hasColor){look.skinProtect=1;}
      // "eher magenta als grün": wanted magenta/red/pink lean positive, rejected green/yellow lean positive too.
      const lean=(rgbs:RGB[],sign:number)=>rgbs.reduce((sum,c)=>{const d=tintDirection(c);return sum+sign*(d[0]+d[2]-2*d[1]);},0);
      const hue=clamp((lean(seg.colors,1)-lean(seg.negated,1)*.5)*.6*seg.scale,-1,1);
      if(Math.abs(hue)>.05)look.skinHue=hue;
      understood.push(`Hauttöne ${look.skinProtect>=1?'neutral geschützt':'leicht geschützt'}${Math.abs(look.skinHue)>.05?` · Richtung ${look.skinHue>0?'Magenta':'Gelb-Grün'}${seg.negatedNames.length?` statt ${hyphen(seg.negatedNames)}`:''}`:''}`);
      continue;
    }
    if(subject==='white'&&!hasColor){if(seg.clean||!seg.names.length){look.whiteClean=1;understood.push('Weiß bleibt sauber und neutral');}continue;}
    if(!hasColor)continue;
    const direction=blend(...seg.colors),zones:Zone[]=subject==='global'||subject==='white'?['shadows','midtones','highlights']:[subject];
    for(const zone of zones){
      const amount=ZONE_AMOUNT[zone]*seg.scale*(subject==='global'?(zone==='midtones'?.9:.5):1);
      const add=scaled(direction,amount);
      if(subject!=='global'&&!explicit.has(zone)){look[zone]=[0,0,0];explicit.add(zone);}
      look[zone]=look[zone].map((v,i)=>v+add[i]) as RGB;
    }
    understood.push(subject==='global'||subject==='white'?`Gesamtbild → ${hyphen(seg.names)}`:`${ZONE_LABEL[subject]} → ${hyphen(seg.names)}${subject==='highlights'&&look.whiteClean>0?' (nur farbiges Licht, Weiß bleibt neutral)':''}`);
  }
  const once=(re:RegExp)=>re.test(text);
  if(once(/\bhighkey\b|\bhell(e|er|en)?\b|\bbright\b|\bluftig|\bairy\b/)){look.key=.6;understood.push('High Key · helle Mitten, offene Schatten');}
  else if(once(/\blowkey\b|\bdunkel|\bdüster|\bmoody\b|\bdark\b/)){look.key=-.55;understood.push('Low Key · dunkle, dichte Mitten');}
  if(once(/kontrastreich|hohe[nrm]? kontrast|high contrast|punchy|knackig/)){look.contrast=.45;understood.push('Mehr Kontrast');}
  else if(once(/kontrastarm|wenig kontrast|low contrast|\bflach|\bweich|\bsoft\b|\bmatt|faded|verwaschen|milchig/)){look.contrast=-.4;understood.push('Weicher Kontrast');}
  if(once(/\bmonochrome\b/)){look.saturation=-1;understood.push('Schwarzweiß');}
  else if(once(/entsättigt|desaturat|\bmuted\b|gedeckt|\bblass|zurückhaltend/)){look.saturation=Math.min(look.saturation,-.4);understood.push('Entsättigt');}
  else if(once(/(?<!ent)gesättigt|\bsatt(e|er|en)?\b|\bsaturated\b|vivid|\bbunt|farbintensiv/)){look.saturation=Math.max(look.saturation,.35);understood.push('Kräftigere Sättigung');}
  look.saturation=clamp(look.saturation,-1,1);look.contrast=clamp(look.contrast,-1,1);look.key=clamp(look.key,-1,1);
  return {look,understood,matched:understood.length>0};
}
