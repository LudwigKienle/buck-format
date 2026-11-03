import { normalsFromDepth } from './aux/normals';
import { isLinearSpace } from './colorspace';
import { resample, scalarField, vectorField } from './field';
import { evalAnimatable, resolveParams } from './keyframes';
import { NODE_IMPLS } from './nodes/index';
import type { DepthRangeContext } from './nodes/masks';
import { BuckError, PORTS } from './types';
import type { AuxChannels, Buf, BuckGraph, BuckNode, ImageBuf, InputDecl, NodeImpl, NodeType, PortKind, PortSpec, RenderContext, ScalarField, VectorField } from './types';
import { topoOrder } from './validate';
/**
 * Graph evaluation (spec §4.3, §6.1, §9.3). Stateless and single-threaded: nodes run in topoOrder (array order on ties),
 * every pixel loop in fixed order. Aux channels are data and never color converted (§8).
 */
type PortTable=Partial<Record<string,{inputs:PortSpec[];output:PortKind;space:'linear'|'display'|'declared'|'any'}>>;
const PORT_TABLE:PortTable=PORTS;
const KIND_NAME:Record<PortKind,string>={image:'ein Bild',scalar:'ein Skalarfeld',vector3:'ein Vektorfeld'};

const inputName=(ref:string)=>ref.slice(1);
/** Declared inputs bind by kind: every depth input reads aux.depth, every normals input aux.normals, masks and images by name. */
function channel(aux:AuxChannels,name:string,decl:InputDecl):ScalarField|VectorField|ImageBuf|undefined {
  return decl.kind==='depth'?aux.depth:decl.kind==='normals'?aux.normals:decl.kind==='image'?aux.images?.[name]:aux.masks[name];
}
const deriveSources=(decl:InputDecl)=>decl.sources.flatMap(s=>s.type==='derive'&&s.method==='normals-from-depth@1'?[s]:[]);

/** Declared inputs (in declaration order) for which `aux` has no channel and no derive source can produce one. */
export function missingInputs(graph:BuckGraph,aux:AuxChannels):string[] {
  const available=(name:string,seen:Set<string>):boolean=>{
    const decl=graph.inputs[name];if(!decl||seen.has(name))return false;
    if(channel(aux,name,decl))return true;
    seen.add(name);
    return decl.kind==='normals'&&deriveSources(decl).some(s=>graph.inputs[s.from]?.kind==='depth'&&available(s.from,seen));
  };
  return Object.keys(graph.inputs).filter(name=>!available(name,new Set()));
}

function checkField(f:Buf,channels:number,what:string){
  if(!(f.width>=1&&f.height>=1)||f.data.length!==f.width*f.height*channels)throw new BuckError(`Hilfskanal „${what}“ hat eine ungültige Puffergröße.`);
}
/**
 * Bilinear resample (taps and edge clamping identical to sampleBilinear in ./field) that skips invalid samples:
 * the weights of the valid taps are renormalized, and a pixel whose valid weight is below one half becomes invalid.
 * Keeps +Infinity sky depth and (0,0,0) normals from smearing into NaN or short vectors.
 */
function resampleValid(src:Float32Array,w:number,h:number,ch:number,tw:number,th:number,valid:(i:number)=>boolean,invalid:number,unit:boolean){
  const out=new Float32Array(tw*th*ch),acc=new Float64Array(ch),sx=w/tw,sy=h/th;
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const fx=Math.min(w-1,Math.max(0,(x+.5)*sx-.5)),fy=Math.min(h-1,Math.max(0,(y+.5)*sy-.5)),x0=Math.floor(fx),y0=Math.floor(fy);
    const x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),tx=fx-x0,ty=fy-y0;
    const idx=[y0*w+x0,y0*w+x1,y1*w+x0,y1*w+x1],wt=[(1-tx)*(1-ty),tx*(1-ty),(1-tx)*ty,tx*ty];
    let sum=0;acc.fill(0);
    for(let k=0;k<4;k++)if(wt[k]>0&&valid(idx[k])){sum+=wt[k];for(let c=0;c<ch;c++)acc[c]+=src[idx[k]*ch+c]*wt[k];}
    const o=(y*tw+x)*ch;
    if(sum<.5){for(let c=0;c<ch;c++)out[o+c]=invalid;continue;}
    let len=0;for(let c=0;c<ch;c++){acc[c]/=sum;len+=acc[c]*acc[c];}
    const k=unit?(len>0?1/Math.sqrt(len):0):1;
    for(let c=0;c<ch;c++)out[o+c]=acc[c]*k;
  }
  return out;
}
const sameSize=(f:Buf,w:number,h:number)=>f.width===w&&f.height===h;

/**
 * Binds aux channels to the source size: depth and normals with the validity-aware bilinear resample above, masks with
 * plain bilinear (field.resample semantics). Missing normals come from the first derive source whose depth exists;
 * inputs with onMissing 'constant' then get depth 1, normals (0,0,1) and masks 1 (mask value is an assumption, §6.1 only
 * names the depth example). Channels already at the target size are passed through without copying.
 */
export function prepareAux(graph:BuckGraph,aux:AuxChannels,width:number,height:number):AuxChannels {
  const out:AuxChannels={masks:{}};
  if(aux.depth){
    const d=aux.depth;checkField(d,1,'depth');
    out.depth=sameSize(d,width,height)?d:scalarField(width,height,resampleValid(d.data,d.width,d.height,1,width,height,i=>Number.isFinite(d.data[i]),Infinity,false));
  }
  if(aux.normals){
    const n=aux.normals,s=n.data;checkField(n,3,'normals');
    const valid=(i:number)=>Number.isFinite(s[i*3])&&Number.isFinite(s[i*3+1])&&Number.isFinite(s[i*3+2])&&(s[i*3]!==0||s[i*3+1]!==0||s[i*3+2]!==0);
    out.normals=sameSize(n,width,height)?n:vectorField(width,height,resampleValid(s,n.width,n.height,3,width,height,valid,0,true));
  }
  for(const name of Object.keys(aux.masks).sort()){
    const m=aux.masks[name];checkField(m,1,name);
    out.masks[name]=sameSize(m,width,height)?m:scalarField(width,height,resampleValid(m.data,m.width,m.height,1,width,height,()=>true,0,false));
  }
  for(const name of Object.keys(aux.images??{}).sort()){
    const m=aux.images![name];checkField(m,4,name);
    out.images??={};
    out.images[name]=sameSize(m,width,height)?m:{...m,width,height,data:resample(m.data,m.width,m.height,4,width,height)};
  }
  const names=Object.keys(graph.inputs);
  for(const name of names){
    const decl=graph.inputs[name];
    if(decl.kind!=='normals'||out.normals)continue;
    const src=deriveSources(decl).find(s=>graph.inputs[s.from]?.kind==='depth'&&out.depth);
    if(src&&out.depth)out.normals=normalsFromDepth(out.depth,src.params.smoothing);
  }
  for(const name of names){
    const decl=graph.inputs[name];
    if(decl.onMissing!=='constant'||channel(out,name,decl))continue;
    // An image input has no meaningful constant (the validator forbids 'constant' for it); it stays missing.
    if(decl.kind==='image')continue;
    if(decl.kind==='depth')out.depth=scalarField(width,height,new Float32Array(width*height).fill(1));
    else if(decl.kind==='normals'){const v=vectorField(width,height);for(let i=2;i<v.data.length;i+=3)v.data[i]=1;out.normals=v;}
    else out.masks[name]=scalarField(width,height,new Float32Array(width*height).fill(1));
  }
  return out;
}

/** Port whose value a bypassed node passes on: `image` for image nodes, `mask` for mask modifiers (mask.refine). */
function passPort(node:BuckNode):string|undefined {
  const spec=PORT_TABLE[node.type];
  if(spec)return spec.output==='image'?'image':spec.inputs.some(p=>p.name==='mask'&&p.kind===spec.output)?'mask':undefined;
  return 'image' in node.inputs?'image':'mask' in node.inputs?'mask':undefined;
}
const outKind=(node:BuckNode):PortKind=>PORT_TABLE[node.type]?.output??('image' in node.inputs?'image':'scalar');
const maskInputRef=(node:BuckNode)=>node.type==='mask.input@1'&&typeof node.params.input==='string'?'$'+node.params.input.replace(/^\$/,''):undefined;

function mixImage(input:ImageBuf,effect:ImageBuf,mask:ScalarField|undefined,amount:number,warn:(m:string)=>void):ImageBuf {
  const a=input.data,e=effect.data;
  if(effect.space!==input.space||amount>=1&&!mask){
    if(effect.space!==input.space&&(amount<1||mask))warn('Ein- und Ausgang liegen in verschiedenen Farbräumen; Stärke und Maske werden ignoriert.');
    let same=true;for(let i=3;i<a.length;i+=4)if(!Object.is(e[i],a[i])){same=false;break;}
    if(same)return effect;
    const data=new Float32Array(e);for(let i=3;i<a.length;i+=4)data[i]=a[i];
    return {kind:'image',width:input.width,height:input.height,data,space:effect.space};
  }
  const out=new Float32Array(a.length),m=mask?.data;
  for(let p=0,i=0;i<a.length;p++,i+=4){
    // NaN mask values count as 0; the mask is clamped to 0…1 before it scales the amount.
    const mv=m?m[p]:1,wt=(mv>0?(mv<1?mv:1):0)*amount;
    for(let c=0;c<3;c++)out[i+c]=wt>=1?e[i+c]:wt<=0?a[i+c]:a[i+c]+(e[i+c]-a[i+c])*wt;
    out[i+3]=a[i+3];
  }
  return {kind:'image',width:input.width,height:input.height,data:out,space:input.space};
}
function zero(kind:PortKind,w:number,h:number,like:ImageBuf):Buf {
  return kind==='image'?{kind:'image',width:w,height:h,data:new Float32Array(w*h*4),space:like.space}:kind==='vector3'?vectorField(w,h):scalarField(w,h);
}
const copyBuf=(b:Buf):Buf=>({...b,data:new Float32Array(b.data)});

export function renderGraph(graph:BuckGraph,source:ImageBuf,opts:{frame:number;aux:AuxChannels;files:Map<string,Uint8Array>;target?:string;registry?:Partial<Record<NodeType,NodeImpl>>;forceBypass?:string[]}):{output:Buf;warnings:string[];bypassed:string[]} {
  const cm=graph.colorManagement,{width,height}=source;
  if(source.kind!=='image'||!(width>=1&&height>=1)||source.data.length!==width*height*4)throw new BuckError('Das Quellbild hat eine ungültige Puffergröße.');
  if(source.space!==cm.input)throw new BuckError(`Das Quellbild liegt in „${source.space}“, der Look erwartet laut colorManagement.input „${cm.input}“.`);
  const warnings:string[]=[],bypassed:string[]=[],warn=(m:string)=>{if(!warnings.includes(m))warnings.push(m);};
  const impls:Partial<Record<string,NodeImpl>>={...NODE_IMPLS,...opts.registry},forced=new Set(opts.forceBypass??[]);
  const byId=new Map<string,BuckNode>();for(const n of graph.nodes)if(!byId.has(n.id))byId.set(n.id,n);
  const passive=(n:BuckNode)=>n.enabled===false||forced.has(n.id)||!impls[n.type]||!PORT_TABLE[n.type];
  // Refs a node actually reads: a bypassed node only reads its pass-through port, so its other inputs are not needed.
  const deps=(n:BuckNode):string[]=>{
    if(passive(n)){const p=passPort(n),r=p?n.inputs[p]:undefined;return r===undefined?[]:[r];}
    const refs=Object.values(n.inputs),mi=maskInputRef(n);
    return mi&&graph.inputs[inputName(mi)]?[...refs,mi]:refs;
  };

  const target=opts.target??graph.output,needed=new Set<string>(),neededInputs=new Set<string>(),uses=new Map<string,number>();
  const visit=(ref:string,from?:string)=>{
    if(typeof ref!=='string')throw new BuckError(`Ungültige Referenz${from?` in „${from}“`:''}.`);
    if(ref.startsWith('$')){
      const name=inputName(ref);
      if(name!=='source'&&!graph.inputs[name])throw new BuckError(`Referenz „${ref}“${from?` in „${from}“`:''} nennt keine deklarierte Eingabe.`);
      if(name!=='source')neededInputs.add(name);return;
    }
    const n=byId.get(ref);if(!n)throw new BuckError(`Referenz „${ref}“${from?` in „${from}“`:''} nennt keinen Knoten.`);
    uses.set(ref,(uses.get(ref)??0)+1);
    if(needed.has(ref))return;needed.add(ref);
    for(const r of deps(n))visit(r,ref);
  };
  visit(target);

  const raw=missingInputs(graph,opts.aux),aux=prepareAux(graph,opts.aux,width,height);
  for(const name of Object.keys(graph.inputs)){
    if(!neededInputs.has(name))continue;
    const decl=graph.inputs[name];
    if(channel(aux,name,decl)){if(raw.includes(name)&&decl.onMissing==='constant')warn(`Eingabe „$${name}“ fehlt; es wird ein konstanter Ersatzwert verwendet (nur für Tests gedacht).`);continue;}
    if(decl.onMissing==='fail')throw new BuckError(`Eingabe „$${name}“ fehlt, der Look verlangt sie zwingend (onMissing „fail“).`);
    warn(`Eingabe „$${name}“ fehlt; abhängige Knoten werden überbrückt.`);
  }

  // AuxChannels has one depth and one normals slot (types.ts), so several declared inputs of one kind share it.
  for(const kind of ['depth','normals'] as const){
    const names=[...neededInputs].filter(name=>graph.inputs[name].kind===kind);
    if(names.length>1)warn(`Die Eingaben ${names.map(x=>`„$${x}“`).join(', ')} erhalten im Web-Editor denselben ${kind==='depth'?'Tiefen':'Normalen'}kanal.`);
  }

  // null marks a scalar/vector result that is missing because an input it depends on is missing.
  const values=new Map<string,Buf|null>();
  const value=(ref:string):Buf|null=>{
    if(ref==='$source')return source;
    if(ref.startsWith('$')){const name=inputName(ref);return channel(aux,name,graph.inputs[name])??null;}
    const v=values.get(ref);if(v===undefined)throw new BuckError(`Knoten „${ref}“ wurde vor seiner Verwendung nicht ausgewertet.`);
    return v;
  };
  const release=(n:BuckNode)=>{for(const r of deps(n)){if(r.startsWith('$'))continue;const u=(uses.get(r)??1)-1;uses.set(r,u);if(u<=0&&r!==target)values.delete(r);}};
  const bypass=(n:BuckNode,pass:Buf|null|undefined)=>{values.set(n.id,pass===undefined?zero(outKind(n),width,height,source):pass);bypassed.push(n.id);};
  const ctxFor=(n:BuckNode):RenderContext=>{
    const ref=n.inputs.depth,decl=ref?.startsWith('$')?graph.inputs[inputName(ref)]:undefined;
    const ctx:DepthRangeContext={width,height,frame:opts.frame,aux,files:opts.files,workingLinear:cm.working.linear,warn:m=>warn(`${n.id}: ${m}`),depthSemantics:decl?.semantics};
    return ctx;
  };

  const order=topoOrder(graph).filter(n=>needed.has(n.id));
  if(order.length!==needed.size)throw new BuckError('Die Auswertungsreihenfolge deckt nicht alle benötigten Knoten ab.');
  for(const n of order){
    const spec=PORT_TABLE[n.type],impl=impls[n.type];
    if(n.enabled===false||forced.has(n.id)){const p=passPort(n);bypass(n,p&&n.inputs[p]!==undefined?value(n.inputs[p]):undefined);release(n);continue;}
    if(!spec||!impl){
      if(!n.optional)throw new BuckError(`Knotentyp „${n.type}“ („${n.id}“) ist unbekannt und nicht optional; der Render wird verweigert.`);
      warn(`Unbekannter optionaler Knoten „${n.id}“ („${n.type}“) wird überbrückt.`);
      const p=passPort(n);bypass(n,p&&n.inputs[p]!==undefined?value(n.inputs[p]):undefined);release(n);continue;
    }
    for(const port of Object.keys(n.inputs))if(!spec.inputs.some(p=>p.name===port))throw new BuckError(`Knoten „${n.id}“ hat keinen Eingang „${port}“.`);
    const inputs:Record<string,Buf|undefined>={};let missing=false;
    for(const p of spec.inputs){
      const ref=n.inputs[p.name];
      if(ref===undefined){if(!p.optional)throw new BuckError(`Knoten „${n.id}“: Pflichteingang „${p.name}“ ist nicht verbunden.`);continue;}
      const v=value(ref);
      // A missing optional port only bypasses an image node when it is the mask; other optional ports just stay empty.
      if(v===null){if(!p.optional||p.name==='mask'||spec.output!=='image')missing=true;continue;}
      if(v.kind!==p.kind)throw new BuckError(`Knoten „${n.id}“: Eingang „${p.name}“ erwartet ${KIND_NAME[p.kind]}, bekommt ${KIND_NAME[v.kind]}.`);
      if(v.width!==width||v.height!==height)throw new BuckError(`Knoten „${n.id}“: Eingang „${p.name}“ hat ${v.width}×${v.height} statt ${width}×${height} Pixel.`);
      inputs[p.name]=v;
    }
    const mi=maskInputRef(n);if(mi&&graph.inputs[inputName(mi)]&&value(mi)===null)missing=true;
    if(missing){bypass(n,spec.output==='image'?inputs.image??null:null);release(n);continue;}
    const image=inputs.image;
    if(image&&image.kind==='image'){
      if(spec.space==='linear'&&!isLinearSpace(image.space))throw new BuckError(`Knoten „${n.id}“ (${n.type}) braucht einen linearen Arbeitsraum, der Eingang liegt in „${image.space}“. Bitte davor einen color.convert@1-Knoten setzen.`);
      if(spec.space==='display'&&isLinearSpace(image.space))throw new BuckError(`Knoten „${n.id}“ (${n.type}) braucht einen display-bezogenen Raum, der Eingang liegt in „${image.space}“.`);
    }
    const amount=evalAnimatable(n.amount??1,opts.frame);
    if(!Number.isFinite(amount))throw new BuckError(`Knoten „${n.id}“: „amount“ ist keine endliche Zahl.`);
    const a=amount<0?0:amount>1?1:amount,ctx=ctxFor(n);
    if(spec.output==='image'&&n.type!=='color.convert@1'&&a===0&&image){values.set(n.id,image);release(n);continue;}
    let result:Buf;
    try{result=impl.evaluate(inputs,resolveParams(n.params,opts.frame) as never,ctx);}
    catch(e){throw new BuckError(`Knoten „${n.id}“: ${e instanceof Error?e.message:String(e)}`);}
    const channels=result?.kind==='image'?4:result?.kind==='vector3'?3:1;
    if(!result||result.kind!==spec.output||result.width!==width||result.height!==height||result.data.length!==width*height*channels)throw new BuckError(`Knoten „${n.id}“ lieferte keinen gültigen Puffer (${KIND_NAME[spec.output]} mit ${width}×${height} Pixeln erwartet).`);
    if(result.kind==='image'&&image?.kind==='image'){
      const mask=inputs.mask as ScalarField|undefined;
      if(n.type==='color.convert@1'){
        if(a!==1||mask)ctx.warn('Konvertierungsknoten werden nicht gemischt; Stärke und Maske werden ignoriert.');
        result=mixImage(image,result,undefined,1,ctx.warn);
      }else result=mixImage(image,result,mask,a,ctx.warn);
    }else if(a!==1)ctx.warn('„amount“ wirkt nur bei Bildknoten und wird hier ignoriert.');
    values.set(n.id,result);release(n);
  }

  let output:Buf|null;
  if(target.startsWith('$')){
    output=value(target);
    if(!output)throw new BuckError(`Eingabe „${target}“ ist nicht vorhanden.`);
  }else{
    output=value(target);
    if(!output){const n=byId.get(target) as BuckNode;warn(`„${target}“ ist wegen fehlender Eingaben leer.`);output=zero(outKind(n),width,height,source);}
  }
  if(output===source||output===aux.depth||output===aux.normals||output===opts.aux.depth||output===opts.aux.normals||Object.values(aux.masks).includes(output as ScalarField))output=copyBuf(output);
  if(target===graph.output){
    if(output.kind!=='image')throw new BuckError('Der Ausgang des Graphen muss ein Bild liefern.');
    if(output.space!==cm.output)warn(`Das Ergebnis liegt in „${output.space}“, deklariert ist „${cm.output}“. Es fehlt ein abschließender color.convert@1-Knoten.`);
  }
  return {output,warnings,bypassed};
}
