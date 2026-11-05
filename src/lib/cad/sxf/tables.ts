// SXF predefined tables, typed in from the public OCF documents (see NOTEBOOK.md):
//  - 16 predefined colours, 15 predefined line types with pitches, 9 predefined line widths
//    (SXF 技術者リファレンスブック 2017 第3章 3.3.2 定義テーブル要素)
//  - 7 point marker shapes and 11 terminator (arrow) shapes with their base sizes in paper mm
//    (same book, 3.3.3 点マーカ and 直線寸法 説明図)
//  - paper sizes A0 to A4 (3.3.1 用紙)

export const PRE_COLOURS: Array<[string, number, number, number]> = [
  ['black', 0, 0, 0],
  ['red', 255, 0, 0],
  ['green', 0, 255, 0],
  ['blue', 0, 0, 255],
  ['yellow', 255, 255, 0],
  ['magenta', 255, 0, 255],
  ['cyan', 0, 255, 255],
  ['white', 255, 255, 255],
  ['deeppink', 192, 0, 128],
  ['brown', 192, 128, 64],
  ['orange', 255, 128, 0],
  ['lightgreen', 128, 192, 128],
  ['lightblue', 0, 128, 255],
  ['lavender', 128, 64, 255],
  ['lightgray', 192, 192, 192],
  ['darkgray', 128, 128, 128],
];

/** pitch in paper mm: [dash, gap, dash, gap, ...]; [] = continuous */
export const PRE_LINETYPES: Array<[string, number[]]> = [
  ['continuous', []],
  ['dashed', [6, 1.5]],
  ['dashed spaced', [6, 6]],
  ['long dashed dotted', [12, 1.5, 0.25, 1.5]],
  ['long dashed double-dotted', [12, 1.5, 0.25, 1.5, 0.25, 1.5]],
  ['long dashed triplicate-dotted', [12, 1.5, 0.25, 1.5, 0.25, 1.5, 0.25, 1.5]],
  ['dotted', [0.25, 1.5]],
  ['chain', [12, 1.5, 3.5, 1.5]],
  ['chain double dash', [12, 1.5, 3.5, 1.5, 3.5, 1.5]],
  ['dashed dotted', [6, 1.5, 0.25, 1.5]],
  ['double-dashed dotted', [6, 1.5, 6, 1.5, 0.25, 1.5]],
  ['dashed double-dotted', [6, 1.5, 0.25, 1.5, 0.25, 1.5]],
  ['double-dashed double-dotted', [6, 1.5, 6, 1.5, 0.25, 1.5, 0.25, 1.5]],
  ['dashed triplicate-dotted', [6, 1.5, 0.25, 1.5, 0.25, 1.5, 0.25, 1.5]],
  ['double-dashed triplicate-dotted', [6, 1.5, 6, 1.5, 0.25, 1.5, 0.25, 1.5, 0.25, 1.5]],
];

export const PRE_WIDTHS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0];

/** paper sizes by SXF sheet type code 0..4 (short side, long side) */
export const PAPER: Array<[string, number, number]> = [
  ['A0', 841, 1189],
  ['A1', 594, 841],
  ['A2', 420, 594],
  ['A3', 297, 420],
  ['A4', 210, 297],
];

export function hex2(n: number): string { const v = Math.max(0, Math.min(255, Math.round(n))); return (v < 16 ? '0' : '') + v.toString(16); }
export function rgbHex(r: number, g: number, b: number): string { return '#' + hex2(r) + hex2(g) + hex2(b); }

export function preColourCode(name: string): number {
  const k = name.trim().toLowerCase();
  for (let i = 0; i < PRE_COLOURS.length; i++) if (PRE_COLOURS[i][0] === k) return i + 1;
  return 0;
}
export function preLinetypeCode(name: string): number {
  const k = name.trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
  for (let i = 0; i < PRE_LINETYPES.length; i++) if (PRE_LINETYPES[i][0] === k) return i + 1;
  // tolerate spelling variants ("double dashed", "long-dashed")
  const loose = k.replace(/-/g, ' ');
  for (let i = 0; i < PRE_LINETYPES.length; i++) if (PRE_LINETYPES[i][0].replace(/-/g, ' ') === loose) return i + 1;
  return 0;
}
export function preWidthCode(w: number): number {
  for (let i = 0; i < PRE_WIDTHS.length; i++) if (Math.abs(PRE_WIDTHS[i] - w) < 0.004) return i + 1;
  return 0;
}

// --------------------------------------------------------------- symbols
// Shapes are drawn in paper mm at the given point. They return primitive lists in a local frame
// (x along the direction, y to the left), scaled by s; the caller maps them to the sheet.

export interface SymPrim { kind: 'line' | 'fill' | 'circle' | 'disc'; pts?: number[]; cx?: number; cy?: number; r?: number }

/** point marker codes 1..7 (asterisk, circle, dot, plus, square, triangle, X), base size 2.5 mm */
export function markerShape(code: number, s: number): SymPrim[] {
  const h = 1.25 * s;
  switch (code) {
    case 1: {
      const out: SymPrim[] = [];
      for (let k = 0; k < 3; k++) {
        const a = Math.PI / 2 + (k * Math.PI) / 3;
        out.push({ kind: 'line', pts: [-h * Math.cos(a), -h * Math.sin(a), h * Math.cos(a), h * Math.sin(a)] });
      }
      return out;
    }
    case 2: return [{ kind: 'circle', cx: 0, cy: 0, r: h }];
    case 3: return [{ kind: 'disc', cx: 0, cy: 0, r: 0.2 }];
    case 4: return [{ kind: 'line', pts: [-h, 0, h, 0] }, { kind: 'line', pts: [0, -h, 0, h] }];
    case 5: return [{ kind: 'line', pts: [-h, -h, h, -h, h, h, -h, h, -h, -h] }];
    case 6: {
      const side = 2.5 * s / Math.sin(Math.PI / 3);
      const y0 = -h, y1 = h;
      return [{ kind: 'line', pts: [-side / 2, y0, side / 2, y0, 0, y1, -side / 2, y0] }];
    }
    case 7: {
      const d = h / Math.SQRT2 * Math.SQRT2;
      const q = d / Math.SQRT2;
      return [{ kind: 'line', pts: [-q, -q, q, q] }, { kind: 'line', pts: [-q, q, q, -q] }];
    }
    default: return [{ kind: 'line', pts: [-h, 0, h, 0] }, { kind: 'line', pts: [0, -h, 0, h] }];
  }
}

/**
 * Terminator (arrow) codes 1..11. Local frame: tip at the origin, the symbol body extends to -x
 * (so x points "out of" the dimension line). Base sizes from the book: length 7.5, width 2.5, box/dot 2.5.
 */
export function arrowShape(code: number, s: number): SymPrim[] {
  const L = 7.5 * s, W = 1.25 * s, B = 2.5 * s;
  switch (code) {
    case 1: return [{ kind: 'line', pts: [-L, W, 0, 0, -L, -W, -L, W] }];
    case 2: return [{ kind: 'line', pts: [-B / 2, -B / 2, B / 2, -B / 2, B / 2, B / 2, -B / 2, B / 2, -B / 2, -B / 2] }];
    case 3: return [{ kind: 'circle', cx: 0, cy: 0, r: B / 2 }];
    case 4: return [{ kind: 'circle', cx: -B / 2, cy: 0, r: B / 2 }];
    case 5: return [{ kind: 'fill', pts: [-B / 2, -B / 2, B / 2, -B / 2, B / 2, B / 2, -B / 2, B / 2] }];
    case 6: return [{ kind: 'fill', pts: [0, 0, -L, W, -L, -W] }];
    case 7: return [{ kind: 'disc', cx: 0, cy: 0, r: B / 2 }];
    case 8: {
      // integral symbol: a short S curve through the point, 45 degrees
      const pts: number[] = [];
      for (let k = 0; k <= 12; k++) {
        const t = -1 + k / 6;
        const x = t * B * 0.7, y = Math.sin(t * Math.PI) * B * 0.25;
        const c = Math.SQRT1_2;
        pts.push(x * c - y * c, x * c + y * c);
      }
      return [{ kind: 'line', pts }];
    }
    case 9: return [{ kind: 'line', pts: [-L, W, 0, 0, -L, -W] }];
    case 10: {
      const c = Math.SQRT1_2 * B;
      return [{ kind: 'line', pts: [-c, -c, c, c] }];
    }
    case 11: return [{ kind: 'line', pts: [-L, W, 0, 0, -L, -W, -L, W] }];
    default: return [];
  }
}
