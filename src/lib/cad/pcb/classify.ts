// Layer function from X2 .FileFunction or, failing that, from the file name conventions of common PCB tools
// (KiCad, Altium/Protel, Eagle, EasyEDA, Fritzing, LibrePCB, Cadence Allegro, Zuken CR-5000, Ucamco). Own code.
import type { PcbLayerKind, PcbSide } from './types.ts';

export interface LayerClass { kind: PcbLayerKind; side: PcbSide; order: number; label: string; plated?: boolean; skip?: boolean }

/** from a .FileFunction value such as 'Copper,L2,Inr,Plane' */
export function fromFileFunction(fn: string): LayerClass | null {
  const f = fn.split(',').map((x) => x.trim());
  const side = (s?: string): PcbSide => (/^Top/i.test(s ?? '') ? 'top' : /^Bot/i.test(s ?? '') ? 'bottom' : /^Inr/i.test(s ?? '') ? 'inner' : null);
  switch (f[0].toLowerCase()) {
    case 'copper': {
      const n = parseInt((f[1] ?? '').replace(/^L/i, ''), 10) || 0;
      const sd = side(f[2]) ?? (n === 1 ? 'top' : 'inner');
      return { kind: 'copper', side: sd, order: n, label: sd === 'top' ? 'Top copper' : sd === 'bottom' ? 'Bottom copper' : `Inner copper L${n}` };
    }
    case 'plated': return { kind: 'drill', side: 'both', order: 0, label: `Plated holes (${f[3] ?? 'PTH'} ${f[1]}-${f[2]})${f[4] ? ' ' + f[4] : ''}`, plated: true };
    case 'nonplated': return { kind: 'drill', side: 'both', order: 0, label: `Non-plated holes (${f[3] ?? 'NPTH'})${f[4] ? ' ' + f[4] : ''}`, plated: false };
    case 'profile': return { kind: 'outline', side: 'both', order: 0, label: 'Board outline' };
    case 'soldermask': return { kind: 'mask', side: side(f[1]), order: 0, label: side(f[1]) === 'bottom' ? 'Bottom solder mask' : 'Top solder mask' };
    case 'legend': return { kind: 'silk', side: side(f[1]), order: 0, label: side(f[1]) === 'bottom' ? 'Bottom silkscreen' : 'Top silkscreen' };
    case 'paste': return { kind: 'paste', side: side(f[1]), order: 0, label: side(f[1]) === 'bottom' ? 'Bottom paste' : 'Top paste' };
    case 'component': return { kind: 'component', side: side(f[2]), order: parseInt((f[1] ?? '').replace(/^L/i, ''), 10) || 0, label: side(f[2]) === 'bottom' ? 'Bottom components' : 'Top components' };
    case 'glue': case 'carbonmask': case 'goldmask': case 'heatsinkmask': case 'peelablemask': case 'silvermask': case 'tinmask': case 'depthrout': case 'vcut': case 'viafill': case 'pads':
      return { kind: 'other', side: side(f[1]), order: 0, label: `${f[0]}${f[1] ? ' ' + f[1] : ''}` };
    case 'drillmap': case 'fabricationdrawing': case 'vcutmap': case 'assemblydrawing': case 'arraydrawing': case 'otherdrawing':
      return { kind: 'drawing', side: side(f[1]), order: 0, label: f.slice(0, 2).join(' ') };
    case 'other': return { kind: 'other', side: null, order: 0, label: f.slice(1).join(' ') || 'Other' };
  }
  return null;
}

const base = (name: string) => name.replace(/\\/g, '/').split('/').pop() ?? name;

/** from the file name; null when nothing matches */
export function fromFileName(path: string): LayerClass | null {
  const file = base(path);
  const lower = file.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  const stem = dot >= 0 ? lower.slice(0, dot) : lower;
  const C = (kind: PcbLayerKind, side: PcbSide, order: number, label: string, plated?: boolean): LayerClass => ({ kind, side, order, label, plated });
  // job files, reports, aperture lists and pick-and-place are not image layers
  if (/^(gbrjob|apr|apr_lib|rep|extrep|drr|ldp|lst|log|xy|csv|pos|rpt|txt_report|html|pdf|md|zip|ipc|d356|bom|xlsx|xls|json|dtb|drp|pho|plt|phl|ptb|pnp)$/.test(ext) || /how-to-order|readme|status report|\bpick ?place\b|-pos$/.test(lower)) return { ...C('other', null, 0, file), skip: true };
  // KiCad: <name>-F_Cu.gbr, -B_Mask.gbr, -In1_Cu.gbr, -Edge_Cuts.gbr, -F_Silkscreen.gbr / -F_SilkS, -PTH.drl
  let m: RegExpExecArray | null;
  if ((m = /[-_.](f|b)[._](cu|mask|silks?(?:creen)?|paste|adhes(?:ive)?|fab|courtyard|crtyd)$/.exec(stem))) {
    const sd: PcbSide = m[1] === 'f' ? 'top' : 'bottom';
    const t = m[2];
    if (t === 'cu') return C('copper', sd, sd === 'top' ? 1 : 99, sd === 'top' ? 'Top copper' : 'Bottom copper');
    if (t === 'mask') return C('mask', sd, 0, sd === 'top' ? 'Top solder mask' : 'Bottom solder mask');
    if (t.startsWith('silk')) return C('silk', sd, 0, sd === 'top' ? 'Top silkscreen' : 'Bottom silkscreen');
    if (t === 'paste') return C('paste', sd, 0, sd === 'top' ? 'Top paste' : 'Bottom paste');
    return C('drawing', sd, 0, `${sd === 'top' ? 'Top' : 'Bottom'} ${t}`);
  }
  if ((m = /[-_.]in(\d+)[._]cu$/.exec(stem))) return C('copper', 'inner', parseInt(m[1], 10) + 1, `Inner copper In${m[1]}`);
  if (/[-_.]edge[._]cuts$/.test(stem)) return C('outline', 'both', 0, 'Board outline');
  if (/(^|[-_])(npth|non[-_ ]?plated)([-_.]|$)/.test(stem) && /^(drl|txt|xnc|drd|exc|nc|tap|cnc)$/.test(ext)) return C('drill', 'both', 0, 'Non-plated holes', false);
  if (/[-_](pth|plated)([-_.]|$)/.test(stem) && /^(drl|txt|xnc|drd|exc|nc|tap|cnc)$/.test(ext)) return C('drill', 'both', 0, 'Plated holes', true);
  if (/-(npth|pth)-drl_map$|drl_map|drill_?map/.test(stem)) return C('drawing', null, 0, 'Drill map');
  if (/-(npth|pth)-drl$/.test(stem)) return C('drill', 'both', 0, /npth/.test(stem) ? 'Non-plated holes' : 'Plated holes', !/npth/.test(stem));
  // LibrePCB: _COPPER-TOP, _COPPER-IN1, _SOLDERMASK-TOP, _SILKSCREEN-TOP, _SOLDERPASTE-TOP, _OUTLINES, _DRILLS-PTH, _PnP-TOP
  if ((m = /_copper-(top|bottom|in(\d+))$/.exec(stem))) return m[1] === 'top' ? C('copper', 'top', 1, 'Top copper') : m[1] === 'bottom' ? C('copper', 'bottom', 99, 'Bottom copper') : C('copper', 'inner', parseInt(m[2], 10) + 1, `Inner copper In${m[2]}`);
  if ((m = /_(soldermask|silkscreen|solderpaste)-(top|bottom)$/.exec(stem))) {
    const sd: PcbSide = m[2] === 'top' ? 'top' : 'bottom';
    const k: PcbLayerKind = m[1] === 'soldermask' ? 'mask' : m[1] === 'silkscreen' ? 'silk' : 'paste';
    return C(k, sd, 0, `${sd === 'top' ? 'Top' : 'Bottom'} ${k === 'mask' ? 'solder mask' : k === 'silk' ? 'silkscreen' : 'paste'}`);
  }
  if (/_outlines?$/.test(stem)) return C('outline', 'both', 0, 'Board outline');
  if ((m = /_drills?-(npth|pth)$/.exec(stem))) return C('drill', 'both', 0, m[1] === 'npth' ? 'Non-plated holes' : 'Plated holes', m[1] !== 'npth');
  if ((m = /_pnp-(top|bot)$/.exec(stem))) return C('component', m[1] === 'top' ? 'top' : 'bottom', 0, m[1] === 'top' ? 'Top components' : 'Bottom components');
  if ((m = /-pnp_(top|bottom)$/.exec(stem))) return C('component', m[1] === 'top' ? 'top' : 'bottom', 0, m[1] === 'top' ? 'Top components' : 'Bottom components');
  // EasyEDA: Gerber_TopLayer.GTL, Gerber_BoardOutlineLayer.GKO, Drill_PTH_Through.DRL
  if (/^drill_npth/.test(stem)) return C('drill', 'both', 0, 'Non-plated holes', false);
  if (/^drill_pth/.test(stem)) return C('drill', 'both', 0, /via/.test(stem) ? 'Plated holes (vias)' : 'Plated holes', true);
  if ((m = /^gerber_(inner|mid)(?:layer)?(\d+)/.exec(stem))) return C('copper', 'inner', parseInt(m[2], 10) + 1, `Inner copper ${m[2]}`);
  if (/^gerber_documentlayer|^gerber_document/.test(stem)) return C('drawing', null, 0, 'Document');
  // Fritzing: _copperTop.gtl, _contour.gm1, _drill.txt, _maskTop.gts, _silkTop.gto
  if (/_contour$/.test(stem)) return C('outline', 'both', 0, 'Board outline');
  if (/_drill$/.test(stem) && /^(txt|drl)$/.test(ext)) return C('drill', 'both', 0, 'Holes');
  // Allegro .art, Zuken .phd and similar plain names
  const words = stem.replace(/^.*[\\/]/, '');
  if (/^(top|cmp|component|toplayer|top_layer|copper_?top|l1|layer_?1|art01|etch_?top)$/.test(words) && !/^(gto|gts|gtp)$/.test(ext)) return C('copper', 'top', 1, 'Top copper');
  if (/^(bottom|bot|sol|solder|bottomlayer|bottom_layer|copper_?bottom|etch_?bottom)$/.test(words) && !/^(gbo|gbs|gbp)$/.test(ext)) return C('copper', 'bottom', 99, 'Bottom copper');
  if ((m = /^(?:int|inner|in|l|layer_?|gnd|pwr|vcc)?(\d+)$/.exec(words)) && /^(art|phd|gbr|pho|ger|gdo|lgr|ly\d*)$/.test(ext)) {
    const n = parseInt(m[1], 10);
    if (/^int|^inner|^in/.test(words)) return C('copper', 'inner', n + 1, `Inner copper ${words.toUpperCase()}`);
    return C('copper', n === 1 ? 'top' : 'inner', n, `Copper L${n}`);
  }
  if (/^(mask|solder_?mask|sm|smask|resist|sr)_?(top|a|t)$|^(top|t)_?(mask|resist)$|^masktop$|^smt$|^soldermask_top$|^resista$/.test(words)) return C('mask', 'top', 0, 'Top solder mask');
  if (/^(mask|solder_?mask|sm|smask|resist|sr)_?(bot|bottom|b)$|^(bot|bottom|b)_?(mask|resist)$|^maskbot$|^smb$|^soldermask_bottom$|^resistb$/.test(words)) return C('mask', 'bottom', 0, 'Bottom solder mask');
  if (/^(silk|silkscreen|ss|legend|sst|silka|silk_?top|top_?silk|silktop|sstop|plc)$/.test(words)) return C('silk', 'top', 0, 'Top silkscreen');
  if (/^(ssb|silkb|silk_?bot(tom)?|bot(tom)?_?silk|silkbot|ssbot|pls)$/.test(words)) return C('silk', 'bottom', 0, 'Bottom silkscreen');
  if (/^(paste_?top|pastetop|pastea|top_?paste|spt|crc|cream_?top)$/.test(words)) return C('paste', 'top', 0, 'Top paste');
  if (/^(paste_?bot(tom)?|pastebot|pasteb|bot(tom)?_?paste|spb|crs|cream_?bot(tom)?)$/.test(words)) return C('paste', 'bottom', 0, 'Bottom paste');
  if (/^(outline|board_?outline|boardoutline|profile|contour|dim|dimension|edge|edges|border|rout|route)$/.test(words)) return C('outline', 'both', 0, 'Board outline');
  if (/^(asy|assy|assembly|fab|drawing|drill_?draw|drilldraw|nc_?drill_?draw)/.test(words) || /^(asy|fab)/.test(words)) return C('drawing', /bot/.test(words) ? 'bottom' : /top/.test(words) ? 'top' : null, 0, `Drawing ${file}`);
  if (/^drillpads?$/.test(words)) return C('other', null, 0, 'Drill pads');
  // Protel / Altium / Eagle extensions
  switch (ext) {
    case 'gtl': return C('copper', 'top', 1, 'Top copper');
    case 'gbl': return C('copper', 'bottom', 99, 'Bottom copper');
    case 'gto': return C('silk', 'top', 0, 'Top silkscreen');
    case 'gbo': return C('silk', 'bottom', 0, 'Bottom silkscreen');
    case 'gts': return C('mask', 'top', 0, 'Top solder mask');
    case 'gbs': return C('mask', 'bottom', 0, 'Bottom solder mask');
    case 'gtp': return C('paste', 'top', 0, 'Top paste');
    case 'gbp': return C('paste', 'bottom', 0, 'Bottom paste');
    case 'gko': return C('outline', 'both', 0, 'Board outline (keep-out)');
    case 'gml': case 'gm1': case 'gmb': case 'oln': case 'out': case 'outline': case 'gbr_outline': case 'gm': return C('outline', 'both', 0, 'Board outline');
    case 'gpt': return C('other', 'top', 0, 'Top pad master');
    case 'gpb': return C('other', 'bottom', 0, 'Bottom pad master');
    case 'gd1': case 'gd2': return C('drawing', null, 0, 'Drill drawing');
    case 'gg1': case 'gg2': return C('drawing', null, 0, 'Drill guide');
    case 'cmp': case 'top': return C('copper', 'top', 1, 'Top copper');
    case 'sol': case 'bot': return C('copper', 'bottom', 99, 'Bottom copper');
    case 'stc': return C('mask', 'top', 0, 'Top solder mask');
    case 'sts': return C('mask', 'bottom', 0, 'Bottom solder mask');
    case 'plc': return C('silk', 'top', 0, 'Top silkscreen');
    case 'pls': return C('silk', 'bottom', 0, 'Bottom silkscreen');
    case 'crc': return C('paste', 'top', 0, 'Top paste');
    case 'crs': return C('paste', 'bottom', 0, 'Bottom paste');
    case 'dim': case 'gml_': return C('outline', 'both', 0, 'Board outline');
    case 'drd': case 'drl': case 'xnc': case 'exc': case 'xln': case 'nc': case 'tap': case 'cnc': case 'txt': case 'drill':
      return C('drill', 'both', 0, /npth|non[-_ ]?plated|_np\b/.test(stem) ? 'Non-plated holes' : /board[-_ ]?edge[-_ ]?rout|outline/.test(stem) ? 'Board outline (rout)' : 'Holes', /npth|non[-_ ]?plated/.test(stem) ? false : /plated|pth/.test(stem) ? true : undefined);
  }
  if ((m = /^g(\d+)$/.exec(ext))) { const n = parseInt(m[1], 10); return C('copper', 'inner', n + 1, `Inner copper G${n}`); }
  if ((m = /^gp(\d+)$/.exec(ext))) { const n = parseInt(m[1], 10); return C('copper', 'inner', 50 + n, `Inner plane GP${n}`); }
  if ((m = /^gm(\d+)$/.exec(ext))) return C('drawing', null, 0, `Mechanical ${m[1]}`);
  if ((m = /^ly(\d+)$/.exec(ext))) { const n = parseInt(m[1], 10); return C('copper', 'inner', n, `Inner copper ${n}`); }
  return null;
}

export function layerColor(kind: PcbLayerKind, side: PcbSide, order: number): { color: string; opacity?: number } {
  switch (kind) {
    case 'copper':
      if (side === 'top') return { color: '#d03c32' };
      if (side === 'bottom') return { color: '#3c6fd0' };
      return { color: ['#c8b400', '#c050c0', '#00a8a8', '#d08020', '#70a030', '#a07050'][Math.abs(order) % 6] };
    case 'mask': return { color: '#22a04a', opacity: 0.45 };
    case 'silk': return side === 'bottom' ? { color: '#e6d34a' } : { color: '#f2f2f2' };
    case 'paste': return { color: '#9aa0a8', opacity: 0.8 };
    case 'outline': return { color: '#f0c020' };
    case 'drill': return { color: '#000000' };
    case 'component': return { color: '#e080ff' };
    case 'board': return { color: '#1d3a2a' };
    case 'drawing': return { color: '#8090a0' };
    case 'diff': return { color: '#ff8000' };
    default: return { color: '#a0a0a0' };
  }
}
