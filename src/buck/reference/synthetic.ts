import { colorValueToRGB, convertImage } from '../colorspace';
import { imageBuf, scalarField } from '../field';
import { dofNode } from '../nodes/dof';
import { fogNode } from '../nodes/fog';
import { fbm } from '../nodes/sky';
import type { ImageBuf, RenderContext, RGB, ScalarField } from '../types';
/**
 * Deterministic procedural test scenes for the invariance test set (tests/buck-reference.test.ts and the scratchpad
 * script): ground plane with perspective depth, sky at infinite depth, spheres with exact Lambert shading, optional
 * mountains and a large saturated red wall. A "look" sets light color, exposure, sky, haze and depth of field; haze and
 * depth of field are rendered with the real atmos.fog@1 / lens.dof@1 nodes. Everything is a pure function of the arguments.
 */
export type SceneContent='A'|'B'|'C';
export type SkyKind='day'|'golden'|'night'|'overcast';
export interface SceneLook {
  name:string;kelvin:number;exposureEV:number;sky:SkyKind;
  /** atmos.fog@1 density over normalized depth (exponential, start 0.2), color = horizon sky. */
  haze?:number;
  /** lens.dof@1 artistic: focus near, blurFar in image widths. */
  dof?:{focus:number;blurFar:number};
  redWall?:boolean;
  /** Key light direction (azimuth, elevation in degrees, convention of light.relight@1). */
  light?:[number,number];
}
export const LOOKS:Record<string,SceneLook>={
  warm:{name:'warm',kelvin:3200,exposureEV:0,sky:'golden',light:[-60,25]},
  cold:{name:'kalt',kelvin:8000,exposureEV:0,sky:'overcast',light:[-60,25]},
  day:{name:'Tag',kelvin:5600,exposureEV:0,sky:'day',light:[-60,25]},
  night:{name:'Nacht',kelvin:7000,exposureEV:-3.2,sky:'night',light:[50,40]},
  haze:{name:'Dunst',kelvin:5600,exposureEV:0,sky:'overcast',haze:3,light:[-60,25]},
  dof:{name:'Tiefenschärfe',kelvin:5600,exposureEV:0,sky:'day',dof:{focus:.15,blurFar:.02},light:[-60,25]},
};
const SKIES:Record<SkyKind,{zen:RGB;hor:RGB}>={
  day:{zen:[.14,.26,.62],hor:[.45,.53,.7]},golden:{zen:[.22,.24,.34],hor:[.85,.47,.21]},
  night:{zen:[.003,.0045,.012],hor:[.006,.0075,.014]},overcast:{zen:[.38,.4,.43],hor:[.5,.51,.53]},
};
interface Sphere {cx:number;cy:number;r:number;albedo:RGB;seed:number;}
const LAYOUT:Record<SceneContent,{horizon:number;spheres:Sphere[];mountains:boolean;ground:RGB;groundScale:number}>={
  A:{horizon:.42,mountains:true,ground:[.42,.36,.28],groundScale:14,spheres:[{cx:.3,cy:.72,r:.11,albedo:[.55,.5,.45],seed:3},{cx:.68,cy:.6,r:.07,albedo:[.35,.45,.5],seed:5}]},
  B:{horizon:.37,mountains:false,ground:[.38,.38,.33],groundScale:9,spheres:[{cx:.18,cy:.62,r:.06,albedo:[.5,.42,.4],seed:7},{cx:.52,cy:.78,r:.13,albedo:[.45,.48,.42],seed:9},{cx:.84,cy:.58,r:.05,albedo:[.6,.55,.5],seed:11}]},
  C:{horizon:.45,mountains:true,ground:[.4,.34,.3],groundScale:20,spheres:[{cx:.45,cy:.7,r:.1,albedo:[.5,.5,.5],seed:13}]},
};
function lightVec(az:number,el:number):RGB{const a=az*Math.PI/180,e=el*Math.PI/180;return [Math.sin(a)*Math.cos(e),Math.sin(e),Math.cos(a)*Math.cos(e)];}
const ctx=(w:number,h:number):RenderContext=>({width:w,height:h,frame:0,aux:{masks:{}},files:new Map(),workingLinear:'lin_rec709_srgb',warn:()=>{}});
/** Scene in 'Rec.1886 Rec.709 - Display' code values (clipped to 0…1 like a delivered frame) and its exact depth. */
export function syntheticScene(content:SceneContent,look:SceneLook,W=256,H=144):{image:ImageBuf;depth:ScalarField}{
  const L=LAYOUT[content],sky=SKIES[look.sky],light=colorValueToRGB({kelvin:look.kelvin},'lin_rec709_srgb'),dir=lightVec(...(look.light??[-60,25]));
  const lin=imageBuf(W,H,'lin_rec709_srgb'),depth=scalarField(W,H),hz=L.horizon*H,gain=2**look.exposureEV,skyGain=look.sky==='night'?1:1;
  const ambient:RGB=[0,1,2].map(c=>.3*light[c]+.25*sky.hor[c]/Math.max(.05,(sky.hor[0]+sky.hor[1]+sky.hor[2])/3)*.5) as RGB;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x,o=i*4,u=x/W;let c:RGB,d:number,n:RGB|undefined,alb:RGB=[0,0,0];
    const mountain=L.mountains?hz-H*(.05+.07*fbm(u*4,0,3,21)):Infinity;
    if(y<hz&&y<mountain){
      const t=Math.min(1,y/hz)**1.4;c=[0,1,2].map(k=>(sky.zen[k]+(sky.hor[k]-sky.zen[k])*t)*skyGain) as RGB;d=Infinity;
    }else if(y<hz){
      d=.93;n=[0,0,1];const tex=.6+.8*fbm(u*30,y/W*30,4,31);alb=[.32*tex,.34*tex,.38*tex];c=[0,0,0];
    }else{
      const s=(y-hz)/(H-hz);d=Math.pow(1-s,1.3)*.9;n=[0,.94,.34];
      const tex=.55+.9*fbm(u*L.groundScale/(.15+s),1/(s+.05)*1.5,5,17);alb=L.ground.map(v=>v*tex) as RGB;c=[0,0,0];
    }
    for(const sp of L.spheres){
      const dx=(u-sp.cx),dy=(y/W-sp.cy*H/W),rr=Math.hypot(dx,dy)/sp.r;
      if(rr<1){
        const nz=Math.sqrt(1-rr*rr),base=Math.pow(1-((sp.cy*H+sp.r*W*.6)-hz)/(H-hz),1.3)*.9,dd=Math.max(0,base-(sp.r/8)*nz);
        if(dd<d){d=dd;n=[dx/sp.r,-dy/sp.r,nz];const tex=.75+.5*fbm(dx*60+sp.seed,dy*60,4,sp.seed);alb=sp.albedo.map(v=>v*tex) as RGB;}
      }
    }
    if(look.redWall&&u>.58&&u<.98&&y>H*.2&&y<H*.92){
      const dd=.3;if(dd<d){d=dd;n=[0,0,1];const tex=.8+.4*fbm(u*40,y/W*40,4,41);alb=[.62*tex,.06*tex,.04*tex];}
    }
    if(n){const lam=Math.max(0,n[0]*dir[0]+n[1]*dir[1]+n[2]*dir[2]);c=[0,1,2].map(k=>.45*alb[k]*(ambient[k]+1.1*lam*light[k])*gain) as RGB;}
    lin.data[o]=c[0];lin.data[o+1]=c[1];lin.data[o+2]=c[2];lin.data[o+3]=1;depth.data[i]=d;
  }
  let img=lin;
  if(look.haze){
    const y=(sky.hor[0]*.2126+sky.hor[1]*.7152+sky.hor[2]*.0722)*gain;
    img=fogNode.evaluate({image:img,depth},{model:'exponential',start:.2,density:look.haze,color:sky.hor.map(v=>v/Math.max(1e-4,y/gain)) as RGB,luminance:Math.log2(Math.max(1e-4,y)/.18),maxOpacity:.9,skyProtect:1},ctx(W,H)) as ImageBuf;
  }
  if(look.dof){
    img=dofNode.evaluate({image:img,depth},{mode:'artistic',focus:look.dof.focus,focusRange:.12,blurNear:0,blurFar:look.dof.blurFar,maxBlur:Math.max(.02,look.dof.blurFar),blades:0,rotation:0,bladeCurvature:0,catEye:0,highlightBoost:0},ctx(W,H)) as ImageBuf;
  }
  const out=convertImage(img,'Rec.1886 Rec.709 - Display');for(let i=0;i<out.data.length;i++)out.data[i]=Math.min(1,Math.max(0,out.data[i]));
  return {image:out,depth};
}
