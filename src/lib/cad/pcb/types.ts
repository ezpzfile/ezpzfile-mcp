// Output shapes for the PCB engine. Geometry and sheet types are the site's own (src/lib/rvt/types.ts).
// Site copy: imports the site's own types
// (engine source: /tmp/cad/pcb, README.md).
export type { BBox3, GeomBucket, GeomElement, RvtGeometry, SheetItem, SheetViewport, RvtSheet2D } from '../../rvt/types.ts';
import type { RvtGeometry, RvtSheet2D } from '../../rvt/types.ts';

/**
 * Layer list entry (same shape as the other CAD engines). Extras for PCB:
 *   kind:  'copper' | 'mask' | 'silk' | 'paste' | 'outline' | 'drill' | 'component' | 'board' | 'drawing' | 'other' | 'diff'
 *   side:  'top' | 'bottom' | 'inner' | 'both' | null
 *   order: copper layer number (1 = top) when known
 *   file:  source file name (Gerber/drill) or ODB++ / IPC-2581 layer name
 *   fn:    X2 .FileFunction value when present (e.g. 'Copper,L1,Top')
 *   opacity: suggested fill opacity (solder mask is drawn half transparent)
 */
export interface LayerInfo {
  name: string; color: string; visible: boolean; frozen?: boolean; items?: number;
  kind?: PcbLayerKind; side?: PcbSide; order?: number; file?: string; fn?: string; opacity?: number;
}
export type PcbLayerKind = 'copper' | 'mask' | 'silk' | 'paste' | 'outline' | 'drill' | 'component' | 'board' | 'drawing' | 'other' | 'diff';
export type PcbSide = 'top' | 'bottom' | 'inner' | 'both' | null;

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
