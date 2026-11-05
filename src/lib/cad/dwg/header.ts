// AcDb:Header variables (ODS chapter 9). We decode only up to the values we use
// (units, extents, limits, ltscale, point display, INSUNITS) and stop.
import { BitReader } from './bits.ts';
import type { Container } from './container.ts';

export interface HeaderVars {
  ltscale: number; pdmode: number; pdsize: number; textsize: number; lunits: number; aunits: number;
  insunits: number; measurement: number | null;
  extMin: [number, number, number] | null; extMax: [number, number, number] | null;
  pextMin: [number, number, number] | null; pextMax: [number, number, number] | null;
  limMin: [number, number] | null; limMax: [number, number] | null;
  plimMin: [number, number] | null; plimMax: [number, number] | null;
  tilemode: number; psltscale: number; ok: boolean; stage: string;
  dimscale: number; dimasz: number; dimtxt: number;
}

export function parseHeader(c: Container, decoder: TextDecoder, warnings: string[]): HeaderVars {
  const hv: HeaderVars = {
    ltscale: 1, pdmode: 0, pdsize: 0, textsize: 2.5, lunits: 2, aunits: 0, insunits: 0, measurement: null,
    extMin: null, extMax: null, pextMin: null, pextMax: null, limMin: null, limMax: null, plimMin: null, plimMax: null,
    tilemode: 1, psltscale: 1, ok: false, stage: 'start', dimscale: 1, dimasz: 2.5, dimtxt: 2.5,
  };
  const d = c.header;
  if (!d || d.length < 40) return hv;
  const ver = c.ver;
  const r = new BitReader(d, 0, d.length * 8, ver, decoder);
  try {
    r.bit = 16 * 8;
    r.RL(); // size
    if (ver >= 32 || (ver >= 24 && c.maint > 3)) r.RL();
    if (ver >= 21) r.RL(); // size in bits (sample finding: also present in R2010+)
    const TV = () => { if (ver < 21) r.T(); };
    const H = () => { if (ver < 21) r.H(); };
    const CMC = () => {
      if (ver < 18) { r.BS(); return; }
      r.BS(); r.BL(); const f = r.RC();
      if (ver < 21) { if (f & 1) r.T(); if (f & 2) r.T(); }
    };
    if (ver >= 27) r.BLL();
    r.BD(); r.BD(); r.BD(); r.BD(); TV(); TV(); TV(); TV(); r.BL(); r.BL();
    if (ver <= 14) r.BS();
    if (ver < 18) H();
    r.B(); r.B(); // DIMASO DIMSHO
    if (ver <= 14) r.B();
    r.B(); r.B(); r.B(); r.B(); r.B(); hv.psltscale = r.B(); r.B(); // PLINEGEN ORTHO REGEN FILL QTEXT PSLTSCALE LIMCHECK
    if (ver <= 14) r.B();
    if (ver >= 18) r.B();
    r.B(); r.B(); r.B(); r.B(); // USRTIMER SKPOLY ANGDIR SPLFRAME
    if (ver <= 14) { r.B(); r.B(); }
    r.B(); r.B(); // MIRRTEXT WORLDVIEW
    if (ver <= 14) r.B();
    hv.tilemode = r.B(); r.B(); r.B(); // TILEMODE PLIMCHECK VISRETAIN
    if (ver <= 14) r.B();
    r.B(); r.B(); r.BS(); // DISPSILH PELLIPSE PROXYGRAPHICS
    if (ver <= 14) r.BS();
    r.BS(); hv.lunits = r.BS(); r.BS(); hv.aunits = r.BS(); r.BS(); // TREEDEPTH LUNITS LUPREC AUNITS AUPREC
    if (ver <= 14) r.BS();
    r.BS(); // ATTMODE
    if (ver <= 14) r.BS();
    hv.pdmode = r.BS();
    if (ver <= 14) r.BS();
    if (ver >= 18) { r.BL(); r.BL(); r.BL(); }
    for (let i = 0; i < 5; i++) r.BS(); // USERI1-5
    for (let i = 0; i < 14; i++) r.BS(); // SPLINESEGS .. TEXTQLTY
    hv.ltscale = r.BD(); hv.textsize = r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); hv.pdsize = r.BD(); r.BD();
    for (let i = 0; i < 5; i++) r.BD(); // USERR
    r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); r.BD(); // CHAMFERA-D FACETRES CMLSCALE CELTSCALE
    hv.stage = 'dates';
    if (ver <= 18) TV(); // MENUNAME
    r.BL(); r.BL(); r.BL(); r.BL();
    if (ver >= 18) { r.BL(); r.BL(); r.BL(); }
    r.BL(); r.BL(); r.BL(); r.BL();
    CMC(); // CECOLOR
    r.H(); // HANDSEED (always in data stream)
    H(); H(); H(); // CLAYER TEXTSTYLE CELTYPE
    if (ver >= 21) H();
    H(); H(); // DIMSTYLE CMLSTYLE
    if (ver >= 15) r.BD(); // PSVPSCALE
    hv.stage = 'pspace';
    r.P3BD(); hv.pextMin = r.P3BD(); hv.pextMax = r.P3BD(); hv.plimMin = r.P2RD(); hv.plimMax = r.P2RD();
    r.BD(); r.P3BD(); r.P3BD(); r.P3BD(); H();
    if (ver >= 15) { H(); r.BS(); H(); for (let i = 0; i < 6; i++) r.P3BD(); }
    hv.stage = 'mspace';
    r.P3BD(); hv.extMin = r.P3BD(); hv.extMax = r.P3BD(); hv.limMin = r.P2RD(); hv.limMax = r.P2RD();
    r.BD(); r.P3BD(); r.P3BD(); r.P3BD(); H();
    if (ver >= 15) { H(); r.BS(); H(); for (let i = 0; i < 6; i++) r.P3BD(); }
    hv.stage = 'dim';
    if (ver >= 15) { TV(); TV(); } // DIMPOST DIMAPOST (R13-R14 store them later as T)
    if (ver <= 14) {
      for (let i = 0; i < 11; i++) r.B();
      r.RC(); r.RC(); r.B(); r.B(); r.RC(); r.RC(); r.RC(); r.B(); r.RC(); r.RC(); r.RC(); r.RC();
      for (let i = 0; i < 6; i++) r.BS();
      H();
    }
    hv.dimscale = r.BD(); hv.dimasz = r.BD();
    for (let i = 0; i < 7; i++) r.BD(); // DIMEXO .. DIMTM
    if (ver >= 21) { r.BD(); r.BD(); r.BS(); CMC(); }
    if (ver >= 15) { for (let i = 0; i < 6; i++) r.B(); r.BS(); r.BS(); r.BS(); }
    if (ver >= 21) r.BS();
    hv.dimtxt = r.BD();
    for (let i = 0; i < 7; i++) r.BD(); // DIMCEN .. DIMGAP
    if (ver <= 14) { r.T(); r.T(); r.T(); r.T(); r.T(); }
    if (ver >= 15) { r.BD(); r.B(); r.BS(); r.B(); r.B(); r.B(); r.B(); }
    CMC(); CMC(); CMC();
    if (ver >= 15) {
      for (let i = 0; i < 11; i++) r.BS(); // DIMADEC .. DIMJUST
      r.B(); r.B(); r.BS(); r.BS(); r.BS(); r.BS(); r.B(); r.BS();
    }
    if (ver >= 21) r.B();
    if (ver >= 24) { r.B(); r.BD(); TV(); r.BD(); TV(); }
    if (ver >= 15) { H(); H(); H(); H(); H(); }
    if (ver >= 21) { H(); H(); H(); }
    if (ver >= 15) { r.BS(); r.BS(); }
    hv.stage = 'controls';
    for (let i = 0; i < 9; i++) H();
    if (ver <= 15) H();
    H(); H(); H();
    if (ver >= 15) { r.BS(); r.BS(); TV(); TV(); H(); H(); H(); }
    if (ver >= 18) { H(); H(); }
    if (ver >= 21) H();
    if (ver >= 27) H();
    if (ver >= 15) {
      r.BL(); // flags
      hv.insunits = r.BS();
      hv.stage = 'insunits';
    }
    hv.ok = true;
  } catch (e) {
    warnings.push('header variables decoded up to ' + hv.stage + ': ' + (e as Error).message);
  }
  return hv;
}
