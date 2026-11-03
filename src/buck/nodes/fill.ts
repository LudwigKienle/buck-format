import { convertImage } from '../colorspace';
import { BuckError } from '../types';
import type { ImageBuf, NodeImpl } from '../types';
/**
 * fill.inpaint@1 (spec §5.3.9). Puts a prepared plate (a declared image input, typically filled by an inpainting model,
 * §6.5) over the image: the output is the plate in the space of the image input. Where it shows is decided by the generic
 * `mask` port and `amount` of render.ts, usually the same mask that defined the hole. The node itself runs no model, so the
 * render stays deterministic; the plate is shot data like depth.
 */
export const inpaintNode:NodeImpl<'fill.inpaint@1'>={
  type:'fill.inpaint@1',
  evaluate(inputs){
    const image=inputs.image,plate=inputs.plate;
    if(!image||image.kind!=='image')throw new BuckError('Retusche: Bildeingang fehlt.');
    if(!plate||plate.kind!=='image')throw new BuckError('Retusche: Eingang „plate“ fehlt.');
    const out:ImageBuf=plate.space===image.space?{...plate,data:new Float32Array(plate.data)}:convertImage(plate,image.space);
    // Alpha passes through from the image like in every other node.
    for(let i=3;i<out.data.length;i+=4)out.data[i]=image.data[i];
    return out;
  },
};
