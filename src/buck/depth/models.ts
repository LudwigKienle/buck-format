import { BuckError } from '../types';
import type { ModelPin } from '../types';
/**
 * Local model registry (spec §6.3). Weights are never bundled or downloaded; the user installs the ONNX file and the
 * runtime executes it only when its SHA-256 equals `weightsSha256`. Values checked on 30.10.2026 against the
 * Hugging Face API (tree listing with LFS oid) and the raw LFS pointer of the file.
 */
const IMAGENET_MEAN:[number,number,number]=[.485,.456,.406],IMAGENET_STD:[number,number,number]=[.229,.224,.225];
export const KNOWN_MODELS:Record<string,ModelPin>={
  // onnx-community/depth-anything-v2-small, file onnx/model.onnx (fp32, 99 060 839 bytes, producer PyTorch 2.3.0,
  // ai.onnx opset 14). Input pixel_values [batch,3,H,W], output predicted_depth [batch,H,W] (H, W multiples of 14).
  // Upstream preprocessing (DPTImageProcessor / Depth-Anything-V2 image2tensor) scales the *short* side to >= 518;
  // this pin follows the .buck pin semantics instead and fits the long side to 518 (smaller input, see estimate.ts).
  'da2-small-rel@1':{
    name:'Depth Anything V2 Small (relativ)',
    upstream:'https://huggingface.co/onnx-community/depth-anything-v2-small',
    revision:'f7421df0cc30f121782ab050d42f0a423291dcde',
    license:'Apache-2.0',format:'onnx',opset:14,
    weightsSha256:'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
    output:'relative-inverse',
    preprocess:{longSide:518,multipleOf:14,resize:'bicubic',inputSpace:'sRGB - Texture',mean:IMAGENET_MEAN,std:IMAGENET_STD},
    postprocess:{resize:'bilinear-to-source'},
  },
  // Only PyTorch weights (video_depth_anything_vits.pth, HF depth-anything/Video-Depth-Anything-Small) are published;
  // there is no official ONNX export, so nothing can be pinned. Window 32 / overlap 10 = INFER_LEN / OVERLAP in
  // video_depth_anything/video_depth.py. Opset 17 is the spec §6.3 example value, not a property of an existing file.
  'vda-small-rel@1':{
    name:'Video Depth Anything Small (relativ) – nicht verfügbar',
    upstream:'https://github.com/DepthAnything/Video-Depth-Anything',
    revision:'',license:'Apache-2.0',format:'onnx',opset:17,weightsSha256:'',
    output:'relative-inverse',
    preprocess:{longSide:518,multipleOf:14,resize:'bicubic',inputSpace:'sRGB - Texture',mean:IMAGENET_MEAN,std:IMAGENET_STD},
    temporal:{windowFrames:32,overlapFrames:10},
    postprocess:{resize:'bilinear-to-source'},
  },
  // Segmentation and inpainting (§6.5), checked on 03.11.2026 against the Hugging Face API (tree listing with LFS oid) and
  // the SHA-256 of the downloaded files. Opsets read from the files' opset_import.
  // voyagerfromeast/skyseg, skyseg_fp16.onnx (88 084 505 bytes, U²-Net sky segmentation from xiongzhu666/Sky-Segmentation-
  // and-Post-processing, MIT). Input [1,3,320,320] ImageNet-normalized RGB, seven outputs [1,1,320,320]; the first is the
  // fused sigmoid map. Upstream onnx_interence.py stretches to 320 × 320 (cv.resize, bilinear) and min-max normalizes the
  // output; this pin uses the sigmoid values as they are, so an image without sky stays near 0.
  'skyseg-u2net@1':{
    name:'Himmelssegmentierung (U²-Net)',
    upstream:'https://huggingface.co/voyagerfromeast/skyseg',
    revision:'d76f97cf68f049654f087d78d071dfd7505b2561',
    license:'MIT',format:'onnx',opset:11,
    weightsSha256:'74d87f4a69378a610a6be662f859c38cfbdfdd75ff74bbfc54842965ed6fc9f7',
    output:'probability',
    preprocess:{longSide:320,multipleOf:32,resize:'bilinear',inputSpace:'sRGB - Texture',mean:IMAGENET_MEAN,std:IMAGENET_STD,fit:'stretch'},
    postprocess:{resize:'bilinear-to-source'},
  },
  // onnx-community/BiRefNet_lite-ONNX, onnx/model_fp16.onnx (114 538 221 bytes, ZhengPeng7/BiRefNet_lite, MIT). Input
  // input_image [1,3,1024,1024], output output_image [1,1,1024,1024] as logits (the model card applies sigmoid);
  // preprocessor_config.json: resize to 1024 × 1024 (resample 2 = bilinear), rescale 1/255, ImageNet mean/std.
  'birefnet-lite@1':{
    name:'Motivmaske (BiRefNet lite)',
    upstream:'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX',
    revision:'de15b22ba131738a16dff04aab8bdf8dc32e3ac1',
    license:'MIT',format:'onnx',opset:17,
    weightsSha256:'d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402',
    output:'probability',
    preprocess:{longSide:1024,multipleOf:32,resize:'bilinear',inputSpace:'sRGB - Texture',mean:IMAGENET_MEAN,std:IMAGENET_STD,fit:'stretch'},
    postprocess:{resize:'bilinear-to-source',activation:'sigmoid'},
  },
  // danielgatis/rembg release v0.0.0, isnet-general-use.onnx (178 648 008 bytes, IS-Net "general use" weights of xuebinqin/DIS
  // exported to ONNX, opset 13; MD5 equals the checksum rembg pins). Input [1,3,1024,1024], first output [1,1,1024,1024] is a sigmoid map.
  // Preprocessing as in IS-Net/Inference.py: bilinear to 1024 × 1024, /255, mean 0.5, std 1. Upstream and rembg min-max normalize
  // the output; this pin keeps the sigmoid values, as for skyseg-u2net@1, so an image without a subject stays low.
  'isnet-general@1':{
    name:'Motivmaske (IS-Net)',
    upstream:'https://github.com/danielgatis/rembg/releases/tag/v0.0.0',
    revision:'v0.0.0',
    license:'Code Apache-2.0 (xuebinqin/DIS); für die Gewichte nennt das Projekt keine eigene Lizenz, Trainingsdaten DIS5K mit eigenen Nutzungsbedingungen',format:'onnx',opset:13,
    weightsSha256:'60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
    output:'probability',
    preprocess:{longSide:1024,multipleOf:32,resize:'bilinear',inputSpace:'sRGB - Texture',mean:[.5,.5,.5],std:[1,1,1],fit:'stretch'},
    postprocess:{resize:'bilinear-to-source'},
  },
  // andraniksargsyan/migan, migan_pipeline_v2.onnx (28 079 181 bytes, Picsart MI-GAN Places2 512, MIT). The exported pipeline
  // (scripts/create_onnx_pipeline.py) takes image uint8 [1,3,H,W] and mask uint8 [1,1,H,W] with 255 = keep, 0 = fill, crops
  // to the hole, inpaints at 512 × 512 and pastes back with a blurred seam; output uint8 [1,3,H,W]. A feed-forward GAN:
  // no noise input and no seed, the same input gives the same output on the same backend. mean/std are unused (fit native).
  'migan-512@1':{
    name:'Retusche (MI-GAN 512)',
    upstream:'https://huggingface.co/andraniksargsyan/migan',
    revision:'406830d0fa60666da0071c342ad2fbc8f30c5c64',
    license:'MIT',format:'onnx',opset:17,
    weightsSha256:'6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    output:'image',
    preprocess:{longSide:512,multipleOf:1,resize:'bilinear',inputSpace:'sRGB - Texture',mean:[0,0,0],std:[1,1,1],fit:'native'},
    postprocess:{resize:'bilinear-to-source'},
  },
};
export const DEFAULT_DEPTH_MODEL='da2-small-rel@1';
export const SKY_MODEL='skyseg-u2net@1',SUBJECT_MODEL='isnet-general@1',INPAINT_MODEL='migan-512@1';
/** Subject models the editor accepts; the file's SHA-256 decides which pin runs. SUBJECT_MODEL is what it declares by default. */
export const SUBJECT_MODELS=[SUBJECT_MODEL,'birefnet-lite@1'];
/** UI facts about each registry entry: whether it can run at all and which file the user has to install. */
export const MODEL_INFO:Record<string,{available:boolean;file?:string;bytes?:number;note:string}>={
  'da2-small-rel@1':{available:true,file:'onnx/model.onnx',bytes:99060839,note:'Nur Standbilder, ohne zeitlichen Kopf. Gewichte bitte selbst installieren (Hugging Face, Apache-2.0).'},
  'vda-small-rel@1':{available:false,note:'Kein offizieller ONNX-Export verfügbar; das Modell kann im Web-Editor noch nicht ausgeführt werden.'},
  'skyseg-u2net@1':{available:true,file:'skyseg_fp16.onnx',bytes:88084505,note:'Erkennt Himmel samt Wolken unabhängig von der Tiefe. Gewichte bitte selbst installieren (Hugging Face, MIT).'},
  // Tested 03.11.2026: WASM runs out of its 4 GB address space at 1024 px; WebGPU (ORT 1.31) needs 11 storage buffers per shader
  // stage, Apple GPUs offer 10. Runs only on GPUs with a higher limit.
  'birefnet-lite@1':{available:true,file:'onnx/model_fp16.onnx',bytes:114538221,note:'Trennt das Hauptmotiv (Person, Objekt) vom Hintergrund. Braucht WebGPU mit mindestens 11 Storage-Buffern je Shader; auf Apple-GPUs und ohne WebGPU läuft es nicht. Gewichte bitte selbst installieren (Hugging Face, MIT).'},
  // Licence checked 04.11.2026: the DIS README puts only code and metric under Apache-2.0; DIS5K terms forbid commercial use of the
  // dataset; xuebinqin/DIS#150 (commercial use of these weights) is open without an answer from the author.
  'isnet-general@1':{available:true,file:'isnet-general-use.onnx',bytes:178648008,note:'Trennt das Hauptmotiv (Person, Objekt) vom Hintergrund und läuft auch auf Apple-GPUs und der CPU. Achtung: Kommerzielle Nutzung ist ungeklärt. Die Trainingsdaten (DIS5K) sind nur für nichtkommerzielle Forschung freigegeben, für die Gewichte nennt das Projekt keine eigene Lizenz. Gewichte bitte selbst installieren (GitHub, rembg).'},
  'migan-512@1':{available:true,file:'migan_pipeline_v2.onnx',bytes:28079181,note:'Füllt eine Maske aus der Umgebung auf, ohne Zufall und ohne Seed. Gewichte bitte selbst installieren (Hugging Face, MIT).'},
};
export const isPinned=(pin:ModelPin)=>/^[0-9a-f]{64}$/.test(pin.weightsSha256);
/** Depth semantics of a depth model pin; throws for segmentation ('probability') or inpainting ('image') pins. */
export function depthSemantics(pin:ModelPin):'relative-inverse'|'relative-depth'|'metric' {
  const o=pin.output;
  if(o==='probability'||o==='image')throw new BuckError(`„${pin.name}“ ist kein Tiefenmodell.`);
  return o;
}
