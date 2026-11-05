// Output shapes for the SXF engine. Site integration: geometry and sheet types are the site's own
// (src/lib/rvt/types.ts carries the optional extras `layer`, image `mime`, sheet `origin`).
export type { BBox3, GeomBucket, GeomElement, RvtGeometry, SheetItem, SheetViewport, RvtSheet2D } from '../../rvt/types.ts';
import type { RvtGeometry, RvtSheet2D } from '../../rvt/types.ts';

/** items: number of drawn items on the layer */
export interface LayerInfo { name: string; color: string; visible: boolean; frozen?: boolean; items?: number; scale?: number }

export type CadInfo = Record<string, string | number>;

export type CadResult =
  | { kind: '3d'; geometry: RvtGeometry; info: CadInfo; sheets?: RvtSheet2D[]; layers?: LayerInfo[] }
  | { kind: '2d'; sheets: RvtSheet2D[]; layers: LayerInfo[]; info: CadInfo };

export type CadErrorCode = 'unsupported-version' | 'corrupt' | 'encrypted' | 'too-large' | 'not-format';

export class CadError extends Error {
  code: CadErrorCode;
  constructor(code: CadErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CadError';
  }
}

export type Progress = (stage: string, ratio: number) => void;
