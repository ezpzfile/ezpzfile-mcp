// AutoCAD Color Index (ACI) table, 256 entries, computed (not copied) from the documented layout of the index:
//   0 = BYBLOCK, 256 = BYLAYER (resolved elsewhere)
//   1..9  fixed colours: red, yellow, green, cyan, blue, magenta, white/black, dark grey, light grey
//   10..249  24 hue families of 10 entries, hue step 15 degrees starting at red (10 = 0 deg, 20 = 15 deg, ...).
//            Within a family: even offset = full saturation, odd offset = half saturation (mixed 50% with white
//            at the same value), and the value steps 100%, 80%, 60%, 50%, 30% for offsets 0/1, 2/3, 4/5, 6/7, 8/9.
//   250..255 six greys from dark to white.
// Values verified by hand against colours shown in the AutoCAD "Select Color" dialog description (e.g. 10 = 255,0,0,
// 11 = 255,127,127, 30 = 255,127,0, 140 = 0,191,255, 250 = 51,51,51).

function hueRgb(h: number): [number, number, number] {
  // piecewise linear hue ramp, h in degrees 0..360, full saturation and value
  const seg = h / 60;
  const i = Math.floor(seg) % 6;
  const f = seg - Math.floor(seg);
  switch (i) {
    case 0: return [1, f, 0];
    case 1: return [1 - f, 1, 0];
    case 2: return [0, 1, f];
    case 3: return [0, 1 - f, 1];
    case 4: return [f, 0, 1];
    default: return [1, 0, 1 - f];
  }
}

const VALUES = [1, 0.8, 0.6, 0.5, 0.3];

export const ACI_RGB: Array<[number, number, number]> = (() => {
  const t: Array<[number, number, number]> = new Array(256);
  t[0] = [0, 0, 0];
  const fixed: Array<[number, number, number]> = [
    [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192],
  ];
  for (let i = 1; i <= 9; i++) t[i] = fixed[i - 1];
  for (let i = 10; i <= 249; i++) {
    const fam = Math.floor(i / 10) - 1; // 0..23
    const off = i % 10;
    const v = VALUES[off >> 1] * 255;
    const half = (off & 1) === 1;
    const [r, g, b] = hueRgb(fam * 15);
    const ch = (c: number) => {
      const full = c * v;
      return Math.floor(half ? v - (v - full) * 0.5 : full);
    };
    t[i] = [ch(r), ch(g), ch(b)];
  }
  const greys = [51, 80, 105, 130, 190, 255];
  for (let i = 0; i < 6; i++) t[250 + i] = [greys[i], greys[i], greys[i]];
  return t;
})();

const hex2 = (n: number) => (n < 16 ? '0' : '') + n.toString(16);
export function rgbHex(r: number, g: number, b: number): string {
  return '#' + hex2(r & 255) + hex2(g & 255) + hex2(b & 255);
}

/** ACI index to CSS colour for a white sheet: index 7 (white/black) and pure white 255 are drawn black. */
export function aciHex(i: number): string {
  if (i === 7 || i === 255) return '#000000';
  const c = ACI_RGB[Math.max(1, Math.min(255, Math.abs(i) | 0))] ?? ACI_RGB[7];
  return rgbHex(c[0], c[1], c[2]);
}

/** 24 bit true colour (group 420) to CSS colour; pure white is drawn black like ACI 7. */
export function trueColorHex(v: number): string {
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  if (r === 255 && g === 255 && b === 255) return '#000000';
  return rgbHex(r, g, b);
}
