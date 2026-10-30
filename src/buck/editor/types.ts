import type { AuxChannels, BuckGraph, BuckNode, ImageBuf, NodeType } from '../types';
/** Editor-side contract shared by BuckEditor, NodeStack, NodeInspector, AuxPanel, BuckViewer and chain.ts. */
export type ViewMode='result'|'original'|'split'|'depth'|'normals'|'mask';
export type DepthSourceKind='none'|'estimate'|'upload'|'heuristic';
export interface AuxState {
  channels:AuxChannels;
  depthSource:DepthSourceKind;
  /** Human-readable provenance shown in the UI, e.g. "Depth Anything V2 Small · sha256 1a2b…" or "Behelf: Bildheuristik". */
  depthLabel?:string;
  busy:boolean;progress?:number;error?:string;
}
export interface SourceImage {name:string;image:ImageBuf;width:number;height:number;}
export interface EditorState {
  graph:BuckGraph;
  /** Non-graph archive entries (luts/, thumbs/, masks/) that will be written on save. */
  files:Map<string,Uint8Array>;
  selected?:string;
  source?:SourceImage;
  aux:AuxState;
  view:ViewMode;
  frame:number;
}
export interface RenderResult {jobId:number;width:number;height:number;/** sRGB 8-bit RGBA for the canvas. */preview:Uint8ClampedArray;warnings:string[];bypassed:string[];ms:number;}
/** Node catalog entry for the "add node" menu and inspector headings (German UI labels). */
export interface NodeCatalogEntry {type:NodeType;label:string;group:'Farbe'|'Raum'|'Licht'|'Maske';description:string;}
export type UpdateNode=(id:string,patch:(node:BuckNode)=>BuckNode)=>void;
export type UpdateGraph=(next:(graph:BuckGraph)=>BuckGraph)=>void;
