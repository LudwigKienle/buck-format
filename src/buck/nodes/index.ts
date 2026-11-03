import { cdlNode, convertNode, lookNode, lut3dNode } from './color';
import { dofNode } from './dof';
import { inpaintNode } from './fill';
import { fogNode } from './fog';
import { grainNode, halationNode, vignetteNode } from './optics';
import { combineMask, depthRangeMask, gradientMask, imageMask, inputMask, lumaMask, refineMask } from './masks';
import { practicalsNode } from './practicals';
import { relightNode } from './relight';
import { skyNode } from './sky';
import type { NodeImpl, NodeType } from '../types';
/** Every v1 node implementation by type (spec §5). render.ts uses this as its default registry. */
export const NODE_IMPLS:{[T in NodeType]:NodeImpl<T>}={
  'color.convert@1':convertNode,'color.look@1':lookNode,'color.cdl@1':cdlNode,'color.lut3d@1':lut3dNode,
  'atmos.fog@1':fogNode,'lens.dof@1':dofNode,'light.relight@1':relightNode,
  'mask.depthRange@1':depthRangeMask,'mask.gradient@1':gradientMask,'mask.luma@1':lumaMask,'mask.input@1':inputMask,
  'mask.image@1':imageMask,'mask.combine@1':combineMask,'mask.refine@1':refineMask,
  'sky.replace@1':skyNode,'light.practicals@1':practicalsNode,
  'lens.vignette@1':vignetteNode,'film.grain@1':grainNode,'film.halation@1':halationNode,
  'fill.inpaint@1':inpaintNode,
};
