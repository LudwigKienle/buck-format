import type { LookSpec } from '../color/look';
/**
 * Shared contract for the .buck format (docs/BUCK_FORMAT.md, draft 0.1). Every module under src/buck/
 * imports these types; changing a name here is a breaking change for all of them.
 */
export const BUCK_MIMETYPE='application/vnd.buckswood.buck+zip';
export const FORMAT_VERSION='1.0';
export const OFX_CONFIG='ofx-native-v1.5_aces-v1.3_ocio-v2.3';
/** Spec §8: names from the OFX 1.5 native config. Only these are implemented in v1. */
export const SPACE_NAMES=['Rec.1886 Rec.709 - Display','sRGB - Display','ACEScg','ACES2065-1','lin_rec709_srgb'] as const;
export type SpaceName=typeof SPACE_NAMES[number];
export const LINEAR_SPACES:readonly SpaceName[]=['ACEScg','ACES2065-1','lin_rec709_srgb'];
/** Spec §11 limits. */
export const LIMITS={archiveBytes:128*1024*1024,entries:64,entryBytes:64*1024*1024,ratio:100,graphBytes:256*1024,jsonDepth:16,nodes:64,imageSide:4096,promptChars:2000,nameChars:100};
export type RGB=[number,number,number];

/** Spec §9.3: `smooth` is monotone Fritsch–Carlson Hermite. Frames are relative to `timing.reference`. */
export interface Keyframes {keys:[number,number][];interp:'linear'|'hold'|'smooth';}
export type Animatable=number|Keyframes;
/** Params as node implementations receive them: every Keyframes object resolved to a number for the current frame. */
export type Resolved<T>=T extends Keyframes?number:T extends object?{[K in keyof T]:Resolved<T[K]>}:T;
/** Linear RGB in the working linear space, or a Planck-locus color normalized to luminance 1. */
export type ColorValue=RGB|{kelvin:number};

export interface ConvertParams {from:SpaceName;to:SpaceName;}
/** `look` is exactly LookSpec from src/color/look.ts; skinProtection is the Settings.skin equivalent. */
export interface LookParams {space:SpaceName;look:LookSpec;skinProtection:number;prompt?:string;understood?:string[];bakedLut?:string;}
export interface CdlParams {slope:RGB;offset:RGB;power:RGB;saturation:number;style:'v1.2_Fwd'|'noClampFwd';space:SpaceName;}
export interface Lut3dParams {file:string;inputSpace:SpaceName;outputSpace:SpaceName;}
export interface FogParams {model:'exponential'|'linear';start:Animatable;end?:Animatable;density:Animatable;color:ColorValue;luminance:Animatable;maxOpacity:Animatable;skyProtect:Animatable;}
export interface DofParams {
  mode:'artistic'|'physical';
  focus?:Animatable;focusRange?:Animatable;blurNear?:Animatable;blurFar?:Animatable;
  focusDistance?:Animatable;fNumber?:Animatable;focalLength?:Animatable;sensorWidth?:Animatable;
  maxBlur:Animatable;blades:number;rotation:Animatable;bladeCurvature:Animatable;catEye:Animatable;highlightBoost:Animatable;
}
/** `skinProtect` (optional, 0…1): soft color key (skinKey of src/color/look.ts) that neutralizes the light color and halves the gain on skin tones. Absent = 0. */
export interface RelightParams {azimuth:Animatable;elevation:Animatable;color:ColorValue;intensity:Animatable;softness:Animatable;mode:'add';preserveHighlights:Animatable;skinProtect?:Animatable;}
export interface DepthRangeParams {near:Animatable;far:Animatable;feather:Animatable;invert:boolean;}
export interface GradientParams {shape:'linear'|'radial';start?:[number,number];end?:[number,number];center?:[number,number];radius?:Animatable;feather:Animatable;invert:boolean;}
export interface LumaParams {low:Animatable;high:Animatable;softness:Animatable;space:SpaceName;}
export interface InputMaskParams {input:string;channel:'r'|'g'|'b'|'a'|'luma';}
export interface ImageMaskParams {file:string;fit:'stretch'|'contain'|'cover';}
export interface CombineParams {op:'multiply'|'max'|'min'|'subtract'|'screen';}
export interface RefineParams {blur:Animatable;grow:Animatable;gamma:Animatable;}
export const SKY_PRESETS=['night','starry-night','moonrise','twilight','blue-hour','golden-hour','overcast','clear-day','storm','sandstorm','aurora','neon-night'] as const;
export type SkyPreset=typeof SKY_PRESETS[number];
/** `height`: moon center above the horizon line in image widths (negative = below, hidden by the ground). */
export interface SkyMoon {x:number;height:Animatable;radius:Animatable;intensity:Animatable;color?:ColorValue;}
/** `preset` documents where the values came from and has no render effect; every value is explicit. Omitted horizonY = automatic. */
export interface SkyParams {
  source:'procedural'|'image';preset:SkyPreset;
  zenith:ColorValue;horizon:ColorValue;horizonY?:Animatable;gradientPower:Animatable;exposure:Animatable;
  glow:Animatable;glowColor:ColorValue;
  stars:Animatable;milkyWay:Animatable;
  clouds:Animatable;cloudContrast:Animatable;cloudScale:Animatable;cloudColor:ColorValue;
  aurora:Animatable;moon?:SkyMoon;file?:string;
  skyDepth:Animatable;edge:Animatable;spill:Animatable;
}
/** Manual light point in normalized coordinates (x 0…1, y 0…H/W). */
export interface PracticalPoint {x:number;y:number;radius:Animatable;intensity:Animatable;color?:ColorValue;}
export interface PracticalsParams {
  threshold:Animatable;softness:Animatable;contrast:Animatable;minSize:Animatable;maxSize:Animatable;
  intensity:Animatable;glow:Animatable;glowRadius:Animatable;throw:Animatable;falloff:Animatable;
  color:ColorValue;recolor:Animatable;points?:PracticalPoint[];
}

/**
 * lens.vignette@1 (spec §5.3.6): falloff toward the frame edge. Exactly one of `strength` (gain 1 − strength·f) or `exposure`
 * (gain 2^(exposure·f), EV) is given. Lengths in image widths; `center` omitted = image center.
 */
export interface VignetteParams {strength?:Animatable;exposure?:Animatable;radius:Animatable;softness:Animatable;roundness:Animatable;center?:[number,number];}
/** film.grain@1 (spec §5.3.7): deterministic grain on a lattice of `size` image widths, varied per frame unless `animate` is false. */
export interface GrainParams {size:Animatable;intensity:Animatable;response:Animatable;chroma:Animatable;seed:number;animate:boolean;}
/** film.halation@1 (spec §5.3.8): red halo around bright highlights plus an optional neutral bloom. */
export interface HalationParams {threshold:Animatable;knee:Animatable;radius:Animatable;intensity:Animatable;color:ColorValue;bloom:Animatable;bloomRadius?:Animatable;}

/** fill.inpaint@1 has no parameters: the plate comes in through the `plate` port, the region through `mask`. */
export type InpaintParams=Record<string,never>;

export interface NodeParamMap {
  'color.convert@1':ConvertParams;'color.look@1':LookParams;'color.cdl@1':CdlParams;'color.lut3d@1':Lut3dParams;
  'atmos.fog@1':FogParams;'lens.dof@1':DofParams;'light.relight@1':RelightParams;
  'mask.depthRange@1':DepthRangeParams;'mask.gradient@1':GradientParams;'mask.luma@1':LumaParams;'mask.input@1':InputMaskParams;
  'mask.image@1':ImageMaskParams;'mask.combine@1':CombineParams;'mask.refine@1':RefineParams;
  'sky.replace@1':SkyParams;'light.practicals@1':PracticalsParams;
  'lens.vignette@1':VignetteParams;'film.grain@1':GrainParams;'film.halation@1':HalationParams;
  'fill.inpaint@1':InpaintParams;
}
export type NodeType=keyof NodeParamMap;
/** A reference is a node id or `$name` of a declared input; `$source` is the host image. */
export type Ref=string;
export interface NodeBase {id:string;inputs:Record<string,Ref>;amount?:Animatable;enabled?:boolean;optional?:boolean;label?:string;}
export type BuckNode={[T in NodeType]:NodeBase&{type:T;params:NodeParamMap[T]}}[NodeType];
export type NodeOf<T extends NodeType>=Extract<BuckNode,{type:T}>;

export type PortKind='image'|'scalar'|'vector3';
export interface PortSpec {name:string;kind:PortKind;optional:boolean;}
/**
 * Spec §4.3/§5. `space`: which working space the node requires for its image input ('linear' = one of
 * LINEAR_SPACES, 'display' = a display space, 'declared' = the space named in its own params, 'any').
 * Image nodes also accept an optional `mask` port (scalar), listed explicitly here.
 */
export const PORTS:Record<NodeType,{inputs:PortSpec[];output:PortKind;space:'linear'|'display'|'declared'|'any'}>={
  'color.convert@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'declared'},
  'color.look@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'declared'},
  'color.cdl@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'declared'},
  'color.lut3d@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'declared'},
  'atmos.fog@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'depth',kind:'scalar',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'lens.dof@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'depth',kind:'scalar',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'light.relight@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'normals',kind:'vector3',optional:false},{name:'depth',kind:'scalar',optional:true},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'mask.depthRange@1':{inputs:[{name:'depth',kind:'scalar',optional:false}],output:'scalar',space:'any'},
  'mask.gradient@1':{inputs:[],output:'scalar',space:'any'},
  'mask.luma@1':{inputs:[{name:'image',kind:'image',optional:false}],output:'scalar',space:'any'},
  'mask.input@1':{inputs:[],output:'scalar',space:'any'},
  'mask.image@1':{inputs:[],output:'scalar',space:'any'},
  'mask.combine@1':{inputs:[{name:'a',kind:'scalar',optional:false},{name:'b',kind:'scalar',optional:false}],output:'scalar',space:'any'},
  'mask.refine@1':{inputs:[{name:'mask',kind:'scalar',optional:false}],output:'scalar',space:'any'},
  // depth or sky (a segmentation probability) must be connected; sky wins when both are.
  'sky.replace@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'depth',kind:'scalar',optional:true},{name:'sky',kind:'scalar',optional:true},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'light.practicals@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'depth',kind:'scalar',optional:true},{name:'normals',kind:'vector3',optional:true},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'lens.vignette@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'film.grain@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'film.halation@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'linear'},
  'fill.inpaint@1':{inputs:[{name:'image',kind:'image',optional:false},{name:'plate',kind:'image',optional:false},{name:'mask',kind:'scalar',optional:true}],output:'image',space:'any'},
};

export type SourceDecl=
  |{type:'host-clip';clip:string}
  |{type:'cache'}
  |{type:'derive';method:'normals-from-depth@1';from:string;params:{smoothing:number}}
  |{type:'estimate';model:string;hole?:{input:string;grow:number}};
export interface InputDecl {
  kind:'depth'|'normals'|'mask'|'image';
  semantics?:'relative-inverse'|'relative-depth'|'metric';
  frame?:'camera';
  required:boolean;
  sources:SourceDecl[];
  normalize?:{mode:'shot-percentile'|'per-frame'|'none';low?:number;high?:number};
  onMissing:'fail'|'bypass-dependents'|'constant';
}
export interface ModelPin {
  name:string;upstream:string;revision:string;license:string;format:'onnx';opset:number;
  /** 64 lowercase hex chars once pinned. Anything else means "not pinned yet": the runtime must refuse to execute it unattended. */
  weightsSha256:string;
  /** Depth semantics for depth models, 'probability' (0…1 per pixel) for segmentation, 'image' (sRGB 8-bit) for inpainting. */
  output:'relative-inverse'|'relative-depth'|'metric'|'probability'|'image';
  /**
   * fit: 'aspect' (default) keeps the aspect ratio with the long side = longSide; 'stretch' resizes to longSide × longSide;
   * 'native' feeds the source size unchanged as uint8 sRGB code values (mean/std unused; the model resizes internally).
   */
  preprocess:{longSide:number;multipleOf:number;resize:'bicubic'|'bilinear';inputSpace:'sRGB - Texture';mean:RGB;std:RGB;fit?:'aspect'|'stretch'|'native'};
  temporal?:{windowFrames:number;overlapFrames:number};
  postprocess:{resize:'bilinear-to-source';activation?:'sigmoid'};
}
export interface ColorManagement {config:string;input:SpaceName;output:SpaceName;working:{linear:SpaceName;display:SpaceName};}
export interface BuckMeta {name:string;generator?:string;created?:string;author?:string;prompt?:string;license?:string;thumbnails?:{before?:string;after?:string};recipe?:string;}
export interface BuckGraph {
  format:'buck';formatVersion:string;minReaderVersion:string;
  meta:BuckMeta;colorManagement:ColorManagement;
  inputs:Record<string,InputDecl>;models:Record<string,ModelPin>;
  nodes:BuckNode[];output:Ref;
  fallback?:{cube:string;inputSpace:SpaceName;outputSpace:SpaceName;covers:string[];omits:string[]};
  timing?:{reference:'clip-start'|'timecode';rate?:number};
}
export interface ManifestEntry {path:string;size:number;sha256:string;mediaType:string;}
export interface Manifest {buckManifest:1;files:ManifestEntry[];}
/** An opened .buck: graph plus every other archive entry by path (luts/, thumbs/, masks/, meta/, ext/). */
export interface BuckPackage {graph:BuckGraph;files:Map<string,Uint8Array>;manifest:Manifest;lookId:string;}

/** Runtime buffers. Images are interleaved RGBA float32 (alpha passes through untouched), fields are 1 or 3 channels. */
export interface ImageBuf {kind:'image';width:number;height:number;data:Float32Array;space:SpaceName;}
export interface ScalarField {kind:'scalar';width:number;height:number;data:Float32Array;}
export interface VectorField {kind:'vector3';width:number;height:number;data:Float32Array;}
export type Buf=ImageBuf|ScalarField|VectorField;
/** Aux channels bound to one shot (spec §6.4). Depth is normalized 0 = near … 1 = far, +Infinity = invalid/sky. */
export interface AuxChannels {depth?:ScalarField;normals?:VectorField;masks:Record<string,ScalarField>;/** Image inputs (e.g. an inpainted plate) by name. */images?:Record<string,ImageBuf>;}
export interface RenderContext {
  /** Size of the source image; aux channels are resampled to it before nodes run. */
  width:number;height:number;
  frame:number;
  aux:AuxChannels;
  files:Map<string,Uint8Array>;
  /** Working linear space from colorManagement.working.linear; colors given as ColorValue are in this space. */
  workingLinear:SpaceName;
  warn:(message:string)=>void;
}
/** One node implementation. `inputs` has a Buf for every connected port; render.ts applies `mask`/`amount` mixing afterwards. */
export interface NodeImpl<T extends NodeType=NodeType> {
  type:T;
  evaluate(inputs:Record<string,Buf|undefined>,params:Resolved<NodeParamMap[T]>,ctx:RenderContext):Buf;
}
export class BuckError extends Error {constructor(message:string){super(message);this.name='BuckError';}}
