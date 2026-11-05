// AutoCAD Color Index -> RGB, generated from the structure of the AutoCAD colour wheel (no copied table):
// 1-9 fixed colours, 10-249: 24 hues in 15 degree steps x 5 brightness levels x (full / half saturation),
// 250-255: grey ramp.
function hsvRgb(h: number, v: number): [number, number, number] {
  // fully saturated hue h (degrees) at value v (0..255)
  const hp = h / 60;
  const x = 1 - Math.abs((hp % 2) - 1);
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = 1; g = x; } else if (hp < 2) { r = x; g = 1; } else if (hp < 3) { g = 1; b = x; }
  else if (hp < 4) { g = x; b = 1; } else if (hp < 5) { r = x; b = 1; } else { r = 1; b = x; }
  return [r * v, g * v, b * v];
}

export const ACI: Int32Array = (() => {
  const t = new Int32Array(256);
  const pack = (r: number, g: number, b: number) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  const fixed: [number, number, number][] = [
    [0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255],
    [128, 128, 128], [192, 192, 192],
  ];
  for (let i = 0; i < 10; i++) t[i] = pack(...fixed[i]);
  const levels = [255, 165, 127, 76, 38];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const sub = (i - 10) % 10;
    const v = levels[sub >> 1];
    let [r, g, b] = hsvRgb(hue, v);
    if (sub & 1) { r = v - (v - r) / 2; g = v - (v - g) / 2; b = v - (v - b) / 2; }
    t[i] = pack(Math.floor(r), Math.floor(g), Math.floor(b));
  }
  const greys = [51, 91, 132, 173, 214, 255];
  for (let i = 0; i < 6; i++) t[250 + i] = pack(greys[i], greys[i], greys[i]);
  return t;
})();

export function hex(rgb: number): string { return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0'); }

// colour for drawing on white paper: white / near white become black (like a plot)
// one shared string per colour (items share it instead of holding their own copy)
const colorCache = new Map<number, string>();
export function paperColor(rgb: number): string {
  let c = colorCache.get(rgb);
  if (c !== undefined) return c;
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  c = (r > 245 && g > 245 && b > 245) ? '#000000' : hex(rgb);
  if (colorCache.size < 100000) colorCache.set(rgb, c);
  return c;
}
