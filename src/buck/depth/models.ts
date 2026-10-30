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
};
export const DEFAULT_DEPTH_MODEL='da2-small-rel@1';
/** UI facts about each registry entry: whether it can run at all and which file the user has to install. */
export const MODEL_INFO:Record<string,{available:boolean;file?:string;bytes?:number;note:string}>={
  'da2-small-rel@1':{available:true,file:'onnx/model.onnx',bytes:99060839,note:'Nur Standbilder, ohne zeitlichen Kopf. Gewichte bitte selbst installieren (Hugging Face, Apache-2.0).'},
  'vda-small-rel@1':{available:false,note:'Kein offizieller ONNX-Export verfügbar; das Modell kann im Web-Editor noch nicht ausgeführt werden.'},
};
export const isPinned=(pin:ModelPin)=>/^[0-9a-f]{64}$/.test(pin.weightsSha256);
