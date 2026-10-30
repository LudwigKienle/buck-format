import type { SpaceId } from './spaces';
/** Raw16 is used only for a supported encoding; other tagged files use browser color management. */
export function inspectPngEncoding(buffer:ArrayBuffer):{raw:boolean;encoding:SpaceId;label:string}{
  const view=new DataView(buffer),bytes=new Uint8Array(buffer);let offset=8,gamma:number|undefined,srgb=false,unsupported=false;
  const rec709=[31270,32900,64000,33000,30000,60000,15000,6000];
  while(offset+12<=buffer.byteLength){
    const length=view.getUint32(offset);if(length>buffer.byteLength-offset-12)throw new Error('Ungültige PNG-Metadaten.');
    const type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
    if(type==='iCCP'||type==='cICP')unsupported=true;
    if(type==='sRGB')srgb=true;
    if(type==='gAMA'&&length===4)gamma=view.getUint32(offset+8);
    if(type==='cHRM'){
      if(length!==32)unsupported=true;
      else if(rec709.some((expected,i)=>Math.abs(view.getUint32(offset+8+i*4)-expected)>5))unsupported=true;
    }
    offset+=length+12;if(type==='IEND')break;
  }
  if(unsupported)return{raw:false,encoding:'srgb',label:'Farbprofil → sRGB · 8-Bit-Browserpfad'};
  if(srgb)return{raw:true,encoding:'srgb',label:'16-Bit-PNG · sRGB-Metadaten'};
  if(gamma!==undefined){
    if(Math.abs(gamma-41667)<=2)return{raw:true,encoding:'rec709',label:'16-Bit-PNG · Gamma 2.4'};
    if(gamma===100000)return{raw:true,encoding:'linear709',label:'16-Bit-PNG · Linear / Rec.709'};
    return{raw:false,encoding:'srgb',label:'PNG-Gamma → sRGB · 8-Bit-Browserpfad'};
  }
  return{raw:true,encoding:'srgb',label:'16-Bit-PNG · sRGB angenommen'};
}
