import { useId, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { colorValueToRGB, linearToSrgbHex, srgbHexToLinear } from '../colorspace';
import { NODE_CATALOG } from './chain';
import type { Animatable, BuckNode, ColorValue, Keyframes, RGB, SpaceName } from '../types';
/**
 * Shared form controls of the node inspector. Number entry is a text box with inputMode="decimal" (MDN: inputmode only
 * picks the keyboard, it validates nothing), so parsing accepts both "0,5" and "0.5" and the box keeps a draft while typing.
 * Range inputs keep their implicit ARIA slider role and get aria-valuetext with the unit (WAI-ARIA APG slider pattern).
 */
export type Range=[number,number];

export function parseNumber(text:string):number|undefined {
  const t=text.trim().replace(/\s/g,'');
  if(!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)(e[+-]?\d+)?$/i.test(t))return undefined;
  const n=Number(t.replace(',','.'));return Number.isFinite(n)?n:undefined;
}
/** A 1-2-5 step giving about 1000 slider positions. */
export function sliderStep(min:number,max:number):number {
  const raw=(max-min)/1000;if(!(raw>0))return 1;
  const p=10**Math.floor(Math.log10(raw)),m=raw/p;
  return Number(((m<=1?1:m<=2?2:m<=5?5:10)*p).toPrecision(1));
}
export const decimals=(step:number)=>step>=1?0:Math.min(6,Math.ceil(-Math.log10(step)-1e-9));
export function formatNumber(v:number,step:number):string {
  return v.toLocaleString('de-DE',{maximumFractionDigits:decimals(step)+1,useGrouping:false});
}
/** Clamps into [min, max]; an exclusive lower bound becomes min + step, integers are rounded. */
export function clampValue(v:number,[min,max]:Range,opts:{exclusiveMin?:boolean;integer?:boolean;step?:number}={}):number {
  let x=Math.min(max,Math.max(min,v));
  if(opts.integer)x=Math.round(x);
  if(opts.exclusiveMin&&x<=min)x=Math.min(max,min+(opts.step??sliderStep(min,max)));
  return x;
}
const LOG_STEPS=1000;
/** Log sliders run over integer positions 0…1000 (min must be > 0). */
export const toLogPos=(v:number,[min,max]:Range)=>Math.round(Math.log(Math.min(max,Math.max(min,v))/min)/Math.log(max/min)*LOG_STEPS);
export const fromLogPos=(pos:number,[min,max]:Range)=>Number((min*(max/min)**(pos/LOG_STEPS)).toPrecision(3));

const INTERP:Record<Keyframes['interp'],string>={linear:'linear',hold:'halten',smooth:'weich'};
export const isAnimated=(v:Animatable|undefined):v is Keyframes=>v!==undefined&&typeof v!=='number';
export const describeKeyframes=(k:Keyframes)=>`animiert · ${k.keys.length} Schlüssel · ${INTERP[k.interp]??k.interp}`;

export const catalogEntry=(type:string)=>NODE_CATALOG.find(e=>e.type===type);
export const nodeTitle=(n:BuckNode)=>n.label?.trim()||catalogEntry(n.type)?.label||n.type;

export function Section({title,children,actions}:{title:string;children:ReactNode;actions?:ReactNode}){
  const id=useId();
  return <section className="buck-panel" aria-labelledby={id}>
    <h3 id={id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>{title}{actions}</h3>{children}
  </section>;
}
export function Hint({children,tone}:{children:ReactNode;tone?:'warn'}){
  return <p className="buck-muted" role={tone==='warn'?'note':undefined} style={tone==='warn'?{color:'var(--buck-warn, #e0b04a)'}:undefined}>{children}</p>;
}

interface NumberBoxProps {label:string;value:number;range:Range;onChange:(v:number)=>void;step:number;integer?:boolean;exclusiveMin?:boolean;disabled?:boolean;id?:string;style?:CSSProperties;}
/** Text entry with a draft: in-range values commit while typing, anything else is clamped on blur/Enter, Escape reverts. */
export function NumberBox({label,value,range,onChange,step,integer,exclusiveMin,disabled,id,style}:NumberBoxProps){
  const [draft,setDraft]=useState<string|null>(null);
  const parsed=draft===null?value:parseNumber(draft);
  const inRange=(n:number)=>n>=range[0]&&n<=range[1]&&!(exclusiveMin&&n<=range[0])&&!(integer&&!Number.isInteger(n));
  const invalid=draft!==null&&(parsed===undefined||!inRange(parsed));
  const commit=()=>{
    if(draft===null)return;
    const n=parseNumber(draft);setDraft(null);
    if(n!==undefined){const c=clampValue(n,range,{exclusiveMin,integer,step});if(c!==value)onChange(c);}
  };
  const key=(e:KeyboardEvent<HTMLInputElement>)=>{
    if(e.key==='Enter'){commit();e.currentTarget.blur();}
    else if(e.key==='Escape'){setDraft(null);}
  };
  return <input id={id} className="buck-number" type="text" inputMode="decimal" aria-label={label} aria-invalid={invalid||undefined}
    title={`${formatNumber(range[0],step)} bis ${formatNumber(range[1],step)}`} disabled={disabled} size={7} style={{width:'6.5em',...style}}
    value={draft??formatNumber(value,step)}
    onChange={e=>{const t=e.target.value;setDraft(t);const n=parseNumber(t);if(n!==undefined&&inRange(n)&&n!==value)onChange(n);}}
    onBlur={commit} onKeyDown={key}/>;
}

export interface NumberFieldProps {
  label:string;value:number;onChange:(v:number)=>void;
  /** Hard bounds (PARAM_RANGES); the number box accepts all of it. */
  range:Range;
  /** Narrower slider range for bounds that are safety limits only; must lie inside `range`. */
  slider?:Range;
  scale?:'linear'|'log';step?:number;unit?:string;integer?:boolean;exclusiveMin?:boolean;disabled?:boolean;
}
/** Slider plus number box. The slider never leaves `range`; values outside `slider` are shown at the slider end. */
export function NumberField({label,value,onChange,range,slider,scale='linear',step,unit,integer,exclusiveMin,disabled}:NumberFieldProps){
  const id=useId(),sr:Range=[Math.max(range[0],slider?.[0]??range[0]),Math.min(range[1],slider?.[1]??range[1])];
  const st=step??(integer?1:sliderStep(sr[0],sr[1])),log=scale==='log'&&sr[0]>0;
  const text=`${formatNumber(value,st)}${unit?` ${unit}`:''}`;
  const lo=exclusiveMin&&sr[0]===range[0]?sr[0]+st:sr[0];
  const pct=log?toLogPos(value,sr)/LOG_STEPS*100:Math.min(100,Math.max(0,(value-sr[0])/(sr[1]-sr[0])*100));
  return <div className="buck-row buck-slider">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="range" disabled={disabled} aria-valuetext={text}
      min={log?0:lo} max={log?LOG_STEPS:sr[1]} step={log?1:st} value={log?toLogPos(value,sr):Math.min(sr[1],Math.max(lo,value))}
      style={{'--buck-fill':`${pct}%`} as CSSProperties}
      onChange={e=>{const raw=Number(e.target.value);onChange(clampValue(log?fromLogPos(raw,sr):raw,range,{exclusiveMin,integer,step:st}));}}/>
    <NumberBox label={`${label} (Zahl${unit?` in ${unit}`:''})`} value={value} range={range} step={st} integer={integer} exclusiveMin={exclusiveMin} disabled={disabled} onChange={onChange}/>
    {unit&&<span className="buck-muted" aria-hidden="true">{unit}</span>}
  </div>;
}

/** Numeric parameter that may be keyframed: keyframes are shown read-only (editing them is out of scope for v1 UI). */
export function AnimField(p:Omit<NumberFieldProps,'value'>&{value:Animatable}){
  const {value,...rest}=p;
  if(isAnimated(value))return <div className="buck-row">
    <span>{p.label}</span>
    <span className="buck-muted" title={value.keys.map(([f,v])=>`Frame ${f}: ${formatNumber(v,.001)}`).join('\n')} aria-label={`${p.label}: ${describeKeyframes(value)}`}>{describeKeyframes(value)}</span>
  </div>;
  return <NumberField {...rest} value={value}/>;
}

export interface Option<T extends string> {value:T;label:string;}
export function SelectField<T extends string>({label,value,options,onChange,disabled}:{label:string;value:T;options:readonly Option<T>[];onChange:(v:T)=>void;disabled?:boolean}){
  const id=useId(),known=options.some(o=>o.value===value);
  return <div className="buck-row">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={e=>onChange(e.target.value as T)}>
      {!known&&<option value={value}>{value}</option>}
      {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>;
}
export const options=<T extends string>(values:readonly T[],labels?:Partial<Record<T,string>>):Option<T>[]=>values.map(v=>({value:v,label:labels?.[v]??v}));

export function CheckField({label,checked,onChange,disabled}:{label:string;checked:boolean;onChange:(v:boolean)=>void;disabled?:boolean}){
  return <label className="buck-row"><input type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span>{label}</span></label>;
}

/** Text with optional validation: invalid drafts stay local (aria-invalid) and are never committed. */
export function TextField({label,value,onChange,maxLength,placeholder,validate,multiline}:{label:string;value:string;onChange:(v:string)=>void;maxLength?:number;placeholder?:string;validate?:(v:string)=>string|undefined;multiline?:boolean}){
  const id=useId(),errId=useId(),[draft,setDraft]=useState<string|null>(null);
  const shown=draft??value,error=draft!==null&&validate?validate(draft):undefined;
  const change=(t:string)=>{if(validate){setDraft(t);if(!validate(t))onChange(t);}else onChange(t);};
  const common={id,value:shown,maxLength,placeholder,'aria-invalid':error?true:undefined,'aria-describedby':error?errId:undefined,onBlur:()=>setDraft(null)};
  return <div className="buck-row">
    <label htmlFor={id}>{label}</label>
    {multiline?<textarea {...common} rows={3} onChange={e=>change(e.target.value)}/>:<input {...common} type="text" onChange={e=>change(e.target.value)}/>}
    {error&&<span id={errId} className="buck-muted" role="alert">{error}</span>}
  </div>;
}

const CHANNELS=['R','G','B'] as const;
export function RGBField({label,value,onChange,range,slider,step}:{label:string;value:RGB;onChange:(v:RGB)=>void;range:Range;slider?:Range;step?:number}){
  return <fieldset className="buck-row" style={{border:0,padding:0,margin:0,display:'grid',gap:2}}>
    <legend>{label}</legend>
    {CHANNELS.map((c,i)=><NumberField key={c} label={`${label} ${c}`} value={value[i]} range={range} slider={slider} step={step}
      onChange={v=>onChange(value.map((x,j)=>j===i?v:x) as RGB)}/>)}
  </fieldset>;
}

export function PointField({label,value,onChange,range,slider}:{label:string;value:[number,number];onChange:(v:[number,number])=>void;range:Range;slider?:[Range,Range]}){
  return <fieldset className="buck-row" style={{border:0,padding:0,margin:0,display:'grid',gap:2}}>
    <legend>{label}</legend>
    <NumberField label={`${label} x`} value={value[0]} range={range} slider={slider?.[0]} onChange={x=>onChange([x,value[1]])}/>
    <NumberField label={`${label} y`} value={value[1]} range={range} slider={slider?.[1]} onChange={y=>onChange([value[0],y])}/>
  </fieldset>;
}

/** Task spec: the Kelvin slider spans 1800–12000 K; the box accepts the whole validator range. */
export const KELVIN_SLIDER:Range=[1800,12000];
const DEFAULT_KELVIN=6500;
/** Preview swatch (sRGB hex) of a ColorValue given in the linear working space. */
export const colorPreview=(c:ColorValue,space:SpaceName)=>linearToSrgbHex(colorValueToRGB(c,space),space);
/** Switches representation: Kelvin becomes its luminance-1 RGB in `space`; RGB becomes the last used (or 6500 K) temperature. */
export function switchColorMode(c:ColorValue,mode:'kelvin'|'rgb',space:SpaceName,lastKelvin=DEFAULT_KELVIN):ColorValue {
  if(mode==='rgb')return Array.isArray(c)?c:colorValueToRGB(c,space);
  return Array.isArray(c)?{kelvin:lastKelvin}:c;
}
export function ColorField({label,value,onChange,space,range,kelvinRange}:{label:string;value:ColorValue;onChange:(v:ColorValue)=>void;space:SpaceName;range:Range;kelvinRange:Range}){
  const name=useId(),pickId=useId(),[lastKelvin,setLastKelvin]=useState(Array.isArray(value)?DEFAULT_KELVIN:value.kelvin);
  const mode=Array.isArray(value)?'rgb':'kelvin',hex=colorPreview(value,space);
  const radio=(m:'kelvin'|'rgb',text:string)=><label style={{display:'inline-flex',gap:4,alignItems:'center'}}>
    <input type="radio" name={name} checked={mode===m} onChange={()=>{if(!Array.isArray(value))setLastKelvin(value.kelvin);onChange(switchColorMode(value,m,space,lastKelvin));}}/>{text}
  </label>;
  return <fieldset className="buck-row" style={{border:0,padding:0,margin:0,display:'grid',gap:4}}>
    <legend style={{display:'flex',alignItems:'center',gap:6}}>{label}<span aria-hidden="true" style={{display:'inline-block',width:14,height:14,borderRadius:3,background:hex,border:'1px solid rgba(255,255,255,.25)'}}/></legend>
    <div role="radiogroup" aria-label={`${label}: Angabe`} style={{display:'flex',gap:12}}>{radio('kelvin','Kelvin')}{radio('rgb','Farbwähler')}</div>
    {Array.isArray(value)
      ?<>
        <div className="buck-row"><label htmlFor={pickId}>Farbe</label>
          <input id={pickId} type="color" value={linearToSrgbHex(value,space)} onChange={e=>onChange(srgbHexToLinear(e.target.value,space))}/></div>
        <RGBField label={`${label} linear`} value={value} range={range} slider={[0,Math.max(1,...value)]} onChange={onChange}/>
        <Hint>linear im Arbeitsraum ({space}). Der Farbwähler zeigt sRGB; Werte über 1 erscheinen dort beschnitten.</Hint>
      </>
      :<NumberField label="Farbtemperatur" unit="K" value={value.kelvin} range={kelvinRange} slider={KELVIN_SLIDER} step={10} onChange={k=>{setLastKelvin(k);onChange({kelvin:k});}}/>}
  </fieldset>;
}
