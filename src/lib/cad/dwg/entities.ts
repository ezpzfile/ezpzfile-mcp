// Object specific data (ODS 20.4). Each decoder reads data from h.dat, strings via TV(h), handles from h.hdl.
import type { ObjHead, Color } from './objects.ts';
import { TV, readCMC, readENC } from './objects.ts';

export type V2 = [number, number];
export type V3 = [number, number, number];

export interface Ent {
  kind: string;
  [k: string]: any;
}

function scale3(r: ObjHead['dat'], ver: number): V3 {
  if (ver < 15) return [r.BD(), r.BD(), r.BD()];
  const f = r.BB();
  if (f === 3) return [1, 1, 1];
  if (f === 1) { const y = r.DD(1), z = r.DD(1); return [1, y, z]; }
  if (f === 2) { const x = r.RD(); return [x, x, x]; }
  const x = r.RD(); const y = r.DD(x); const z = r.DD(x); return [x, y, z];
}

function textCommon(h: ObjHead): any {
  const r = h.dat, ver = h.ver;
  const e: any = {};
  if (ver < 15) {
    const elev = r.BD();
    e.ins = r.P2RD(); e.align = r.P2RD(); e.elev = elev;
    e.ext = r.P3BD(); e.thick = r.BD(); e.oblique = r.BD(); e.rot = r.BD(); e.height = r.BD(); e.wfactor = r.BD();
    e.text = TV(h); e.gen = r.BS(); e.halign = r.BS(); e.valign = r.BS();
  } else {
    const df = r.RC();
    e.elev = (df & 1) ? 0 : r.RD();
    e.ins = r.P2RD();
    e.align = (df & 2) ? null : [r.DD(e.ins[0]), r.DD(e.ins[1])];
    e.ext = r.BE(); e.thick = r.BT();
    e.oblique = (df & 4) ? 0 : r.RD();
    e.rot = (df & 8) ? 0 : r.RD();
    e.height = r.RD();
    e.wfactor = (df & 0x10) ? 1 : r.RD();
    e.text = TV(h);
    e.gen = (df & 0x20) ? 0 : r.BS();
    e.halign = (df & 0x40) ? 0 : r.BS();
    e.valign = (df & 0x80) ? 0 : r.BS();
  }
  return e;
}

function mtextBody(h: ObjHead, e: any) {
  const r = h.dat, ver = h.ver;
  e.ins = r.P3BD(); e.ext = r.P3BD(); e.xdir = r.P3BD();
  e.rectW = r.BD();
  if (ver >= 21) e.rectH = r.BD();
  e.height = r.BD(); e.attach = r.BS(); e.drawDir = r.BS();
  e.extH = r.BD(); e.extW = r.BD();
  e.text = TV(h);
  if (ver >= 15) { e.lsStyle = r.BS(); e.lsFactor = r.BD(); r.B(); }
  if (ver >= 18) {
    const bg = r.BL();
    // sample finding: the background scale factor is a BD (not BL)
    if ((bg & 1) || (ver >= 32 && (bg & 0x10))) { r.BD(); readCMC(h); r.BL(); }
  }
  e.style = h.hdl.HR(h.handle);
}

function dimCommon(h: ObjHead, e: any) {
  const r = h.dat, ver = h.ver;
  if (ver >= 24) r.RC();
  e.ext = r.P3BD(); e.textMid = r.P2RD(); e.elev = r.BD(); e.flags1 = r.RC();
  e.userText = TV(h);
  e.textRot = r.BD(); e.horizDir = r.BD();
  e.insScale = [r.BD(), r.BD(), r.BD()]; e.insRot = r.BD();
  if (ver >= 15) { e.attach = r.BS(); e.lsStyle = r.BS(); e.lsFactor = r.BD(); e.measure = r.BD(); }
  if (ver >= 21) { r.B(); r.B(); r.B(); }
  e.pt12 = r.P2RD();
}
function dimHandles(h: ObjHead, e: any) {
  e.dimstyle = h.hdl.HR(h.handle);
  e.block = h.hdl.HR(h.handle);
}

export function decodeEntity(h: ObjHead): Ent | null {
  const r = h.dat, ver = h.ver;
  const hdl = h.hdl, H = () => hdl.HR(h.handle);
  // common fields first so that all entity objects share a similar shape
  const e: Ent = {
    kind: h.typeName, handle: h.handle, layer: h.layer, ltype: h.ltype, color: h.color, ltscale: h.ltscale,
    invisible: h.invisible, lweight: h.lweight, entmode: h.entmode, owner: h.owner,
  };
  switch (h.typeName) {
    case 'LINE': {
      if (ver < 15) { e.p0 = r.P3BD(); e.p1 = r.P3BD(); }
      else {
        const zz = r.B();
        const x0 = r.RD(), x1 = r.DD(x0), y0 = r.RD(), y1 = r.DD(y0);
        let z0 = 0, z1 = 0;
        if (!zz) { z0 = r.RD(); z1 = r.DD(z0); }
        e.p0 = [x0, y0, z0]; e.p1 = [x1, y1, z1];
      }
      e.thick = r.BT(); e.ext = r.BE();
      return e;
    }
    case 'POINT': e.p = r.P3BD(); e.thick = r.BT(); e.ext = r.BE(); e.xang = r.BD(); return e;
    case 'CIRCLE': e.c = r.P3BD(); e.r = r.BD(); e.thick = r.BT(); e.ext = r.BE(); return e;
    case 'ARC': e.c = r.P3BD(); e.r = r.BD(); e.thick = r.BT(); e.ext = r.BE(); e.a0 = r.BD(); e.a1 = r.BD(); return e;
    case 'ELLIPSE': e.c = r.P3BD(); e.major = r.P3BD(); e.ext = r.P3BD(); e.ratio = r.BD(); e.a0 = r.BD(); e.a1 = r.BD(); return e;
    case 'SOLID': case 'TRACE': {
      e.thick = r.BT(); const z = r.BD();
      e.pts = [r.P2RD(), r.P2RD(), r.P2RD(), r.P2RD()]; e.elev = z; e.ext = r.BE();
      return e;
    }
    case '3DFACE': {
      if (ver < 15) { e.pts = [r.P3BD(), r.P3BD(), r.P3BD(), r.P3BD()]; e.invis = r.BS(); }
      else {
        const noflag = r.B(), zz = r.B();
        const x = r.RD(), y = r.RD(), z = zz ? 0 : r.RD();
        const p0: V3 = [x, y, z];
        const p1: V3 = [r.DD(p0[0]), r.DD(p0[1]), r.DD(p0[2])];
        const p2: V3 = [r.DD(p1[0]), r.DD(p1[1]), r.DD(p1[2])];
        const p3: V3 = [r.DD(p2[0]), r.DD(p2[1]), r.DD(p2[2])];
        e.pts = [p0, p1, p2, p3]; e.invis = noflag ? 0 : r.BS();
      }
      return e;
    }
    case 'RAY': case 'XLINE': e.p = r.P3BD(); e.v = r.P3BD(); return e;
    case 'TEXT': {
      Object.assign(e, textCommon(h));
      e.style = H();
      return e;
    }
    case 'ATTRIB': case 'ATTDEF': {
      Object.assign(e, textCommon(h));
      if (ver >= 24) r.RC();
      let atype = 1;
      if (ver >= 32) atype = r.RC();
      if (atype !== 1 && ver >= 32) {
        // embedded MTEXT (R2018 multi line attribute)
        e.mtext = {};
        mtextEmbedded(h, e.mtext);
        const ann = r.BS();
        if (ann > 0) { r.bytes(ann); H(); r.BS(); }
      }
      e.tag = TV(h);
      r.BS();
      e.flags = r.RC();
      if (ver >= 21) r.B();
      if (h.typeName === 'ATTDEF') { if (ver >= 24) r.RC(); e.prompt = TV(h); }
      e.style = H();
      return e;
    }
    case 'INSERT': case 'MINSERT': {
      e.ins = r.P3BD(); e.scale = scale3(r, ver); e.rot = r.BD(); e.ext = r.P3BD();
      e.hasAttribs = r.B();
      let owned = 0;
      // sample finding: the owned object count is only stored when ATTRIBs follow
      if (ver >= 18 && e.hasAttribs) owned = r.BL();
      if (h.typeName === 'MINSERT') { e.cols = r.BS(); e.rows = r.BS(); e.colSp = r.BD(); e.rowSp = r.BD(); }
      e.block = H();
      e.attribs = [] as number[];
      if (e.hasAttribs) {
        if (ver < 18) { e.firstAttrib = H(); e.lastAttrib = H(); }
        else for (let i = 0; i < owned; i++) e.attribs.push(H());
        e.seqend = H();
      }
      return e;
    }
    case 'VERTEX_2D': {
      e.flags = r.RC(); e.p = r.P3BD();
      let sw = r.BD();
      if (sw < 0) { sw = -sw; e.sw = sw; e.ew = sw; } else { e.sw = sw; e.ew = r.BD(); }
      e.bulge = r.BD();
      if (ver >= 24) r.BL();
      e.tdir = r.BD();
      return e;
    }
    case 'VERTEX_3D': case 'VERTEX_MESH': case 'VERTEX_PFACE':
      e.flags = r.RC(); e.p = r.P3BD(); return e;
    case 'VERTEX_PFACE_FACE': e.idx = [r.BS(), r.BS(), r.BS(), r.BS()]; return e;
    case 'POLYLINE_2D': {
      e.flags = r.BS(); e.curve = r.BS(); e.sw = r.BD(); e.ew = r.BD(); e.thick = r.BT(); e.elev = r.BD(); e.ext = r.BE();
      let owned = 0; if (ver >= 18) owned = r.BL();
      readOwned(h, e, owned);
      return e;
    }
    case 'POLYLINE_3D': {
      e.sflags = r.RC(); e.cflags = r.RC(); e.flags = (e.cflags & 1) ? 1 : 0;
      let owned = 0; if (ver >= 18) owned = r.BL();
      readOwned(h, e, owned);
      return e;
    }
    case 'POLYLINE_PFACE': {
      e.nv = r.BS(); e.nf = r.BS();
      let owned = 0; if (ver >= 18) owned = r.BL();
      readOwned(h, e, owned);
      return e;
    }
    case 'POLYLINE_MESH': {
      e.flags = r.BS(); e.curve = r.BS(); e.m = r.BS(); e.n = r.BS(); r.BS(); r.BS();
      let owned = 0; if (ver >= 18) owned = r.BL();
      readOwned(h, e, owned);
      return e;
    }
    case 'LWPOLYLINE': { Object.assign(e, decodeLwData(r, ver)); return e; }
    case 'SPLINE': {
      let scen = r.BL();
      let closedFlag = false;
      if (ver >= 27) {
        const sf = r.BL(); const knotParam = r.BL();
        closedFlag = (sf & 4) !== 0;
        // sample finding: R2013+ uses the fit data layout whenever 'method fit points' (bit 1) is set
        scen = (sf & 1) ? 2 : 1;
        void knotParam;
      }
      e.degree = r.BL();
      e.fit = null; e.knots = null; e.ctrl = null; e.weights = null;
      let nfit = 0, nk = 0, nc = 0, weighted = false;
      if (scen === 2) {
        e.fitTol = r.BD(); e.tan0 = r.P3BD(); e.tan1 = r.P3BD(); nfit = r.BL();
      } else if (scen === 1) {
        e.rational = r.B(); e.closed = r.B(); e.periodic = r.B();
        r.BD(); r.BD();
        nk = r.BL(); nc = r.BL(); weighted = !!r.B();
      } else throw new Error('bad spline scenario');
      if (nk > 1000000 || nc > 1000000 || nfit > 1000000 || nk < 0 || nc < 0 || nfit < 0) throw new Error('bad spline counts');
      if (nk) { e.knots = new Float64Array(nk); for (let i = 0; i < nk; i++) e.knots[i] = r.BD(); }
      if (nc) {
        e.ctrl = new Float64Array(nc * 3); if (weighted) e.weights = new Float64Array(nc);
        for (let i = 0; i < nc; i++) { e.ctrl[i * 3] = r.BD(); e.ctrl[i * 3 + 1] = r.BD(); e.ctrl[i * 3 + 2] = r.BD(); if (weighted) e.weights[i] = r.BD(); }
      }
      if (nfit) { e.fit = new Float64Array(nfit * 3); for (let i = 0; i < nfit * 3; i++) e.fit[i] = r.BD(); }
      if (closedFlag) e.closed = true;
      return e;
    }
    case 'MTEXT': mtextBody(h, e); return e;
    case 'DIMENSION_ORDINATE': dimCommon(h, e); e.p10 = r.P3BD(); e.p13 = r.P3BD(); e.p14 = r.P3BD(); e.flags2 = r.RC(); dimHandles(h, e); return e;
    case 'DIMENSION_LINEAR': dimCommon(h, e); e.p13 = r.P3BD(); e.p14 = r.P3BD(); e.p10 = r.P3BD(); e.extRot = r.BD(); e.dimRot = r.BD(); dimHandles(h, e); return e;
    case 'DIMENSION_ALIGNED': dimCommon(h, e); e.p13 = r.P3BD(); e.p14 = r.P3BD(); e.p10 = r.P3BD(); e.extRot = r.BD(); dimHandles(h, e); return e;
    case 'DIMENSION_ANG3PT': dimCommon(h, e); e.p10 = r.P3BD(); e.p13 = r.P3BD(); e.p14 = r.P3BD(); e.p15 = r.P3BD(); dimHandles(h, e); return e;
    case 'DIMENSION_ANG2LN': dimCommon(h, e); e.p16 = r.P2RD(); e.p13 = r.P3BD(); e.p14 = r.P3BD(); e.p15 = r.P3BD(); e.p10 = r.P3BD(); dimHandles(h, e); return e;
    case 'DIMENSION_RADIUS': case 'DIMENSION_DIAMETER': dimCommon(h, e); e.p10 = r.P3BD(); e.p15 = r.P3BD(); e.leaderLen = r.BD(); dimHandles(h, e); return e;
    case 'ARC_DIMENSION': {
      dimCommon(h, e); e.p10 = r.P3BD(); e.p13 = r.P3BD(); e.p14 = r.P3BD(); e.p15 = r.P3BD();
      r.B(); r.BD(); r.BD(); r.B(); r.P3BD(); r.P3BD(); dimHandles(h, e); return e;
    }
    case 'LARGE_RADIAL_DIMENSION': {
      dimCommon(h, e); e.p10 = r.P3BD(); e.p13 = r.P3BD(); r.BD(); r.P3BD(); r.P3BD(); dimHandles(h, e); return e;
    }
    case 'LEADER': {
      r.B(); e.annotType = r.BS(); e.pathType = r.BS();
      const n = r.BL();
      if (n < 0 || n > 100000) throw new Error('bad leader count');
      e.pts = [] as V3[];
      for (let i = 0; i < n; i++) e.pts.push(r.P3BD());
      r.P3BD(); e.ext = r.P3BD(); r.P3BD(); r.P3BD();
      if (ver >= 14) r.P3BD();
      if (ver < 15) r.BD();
      r.BD(); r.BD();
      r.B(); e.arrow = r.B();
      if (ver < 15) { r.BS(); r.BD(); r.B(); r.B(); r.BS(); r.BS(); r.B(); r.B(); }
      else { r.BS(); r.B(); r.B(); }
      e.annot = H(); e.dimstyle = H();
      return e;
    }
    case 'HATCH': return decodeHatch(h, e);
    case 'VIEWPORT': {
      e.c = r.P3BD(); e.w = r.BD(); e.hgt = r.BD();
      if (ver >= 15) {
        e.target = r.P3BD(); e.dir = r.P3BD(); e.twist = r.BD(); e.viewHeight = r.BD(); e.lens = r.BD();
        r.BD(); r.BD(); r.BD();
        e.viewCenter = r.P2RD(); r.P2RD(); r.P2RD(); r.P2RD(); r.BS();
        if (ver >= 21) r.BS();
        const nfrozen = r.BL(); e.status = r.BL(); TV(h); r.RC(); r.B(); r.B();
        r.P3BD(); r.P3BD(); r.P3BD(); r.BD(); r.BS();
        if (ver >= 18) r.BS();
        if (ver >= 21) { r.B(); r.RC(); r.BD(); r.BD(); readCMC(h); }
        e.frozen = [] as number[];
        if (nfrozen > 0 && nfrozen < 100000) for (let i = 0; i < nfrozen; i++) e.frozen.push(H());
        e.clip = H();
      }
      return e;
    }
    case 'MLEADER': return decodeMLeader(h, e);
    case 'SHAPE': case 'TOLERANCE': case 'MLINE': case 'IMAGE': case 'WIPEOUT': case 'OLE2FRAME': case 'OLEFRAME':
    case 'REGION': case '3DSOLID': case 'BODY': case 'ACAD_PROXY_ENTITY': case 'ACAD_TABLE':
      return e;
    case 'BLOCK': e.name = TV(h); return e;
    case 'ENDBLK': case 'SEQEND': return e;
    default: return e;
  }
}

function mtextEmbedded(h: ObjHead, e: any) {
  // embedded MTEXT inside R2018 ATTRIB/ATTDEF: fields start at insertion point
  const r = h.dat, ver = h.ver;
  e.ins = r.P3BD(); e.ext = r.P3BD(); e.xdir = r.P3BD(); e.rectW = r.BD();
  if (ver >= 21) e.rectH = r.BD();
  e.height = r.BD(); e.attach = r.BS(); e.drawDir = r.BS(); r.BD(); r.BD();
  e.text = TV(h);
  e.lsStyle = r.BS(); e.lsFactor = r.BD(); r.B();
  const bg = r.BL();
  if ((bg & 1) || (bg & 0x10)) { r.BD(); readCMC(h); r.BL(); }
}

function readOwned(h: ObjHead, e: any, owned: number) {
  const H = () => h.hdl.HR(h.handle);
  if (h.ver < 18) { e.first = H(); e.last = H(); e.owned = null; }
  else { e.owned = [] as number[]; for (let i = 0; i < owned; i++) e.owned.push(H()); }
  e.seqend = H();
}

function decodeHatch(h: ObjHead, e: Ent): Ent {
  const r = h.dat, ver = h.ver;
  e.gradient = false;
  if (ver >= 18) {
    const isGrad = r.BL(); r.BL(); r.BD(); r.BD(); r.BL(); r.BD();
    const nc = r.BL();
    e.gradColors = [] as number[];
    if (nc < 0 || nc > 1000) throw new Error('bad gradient colors');
    for (let i = 0; i < nc; i++) { r.BD(); r.BS(); e.gradColors.push(r.BL() & 0xffffff); r.RC(); }
    TV(h);
    e.gradient = isGrad !== 0;
  }
  e.z = r.BD(); e.ext = r.P3BD(); e.name = TV(h); e.solid = r.B(); r.B();
  const np = r.BL();
  if (np < 0 || np > 100000) throw new Error('bad hatch path count');
  e.paths = [] as any[];
  let pixel = false; let nbound = 0;
  for (let p = 0; p < np; p++) {
    const flag = r.BL();
    if (flag & 4) pixel = true;
    const path: any = { flag, segs: [] as any[], poly: null };
    if (!(flag & 2)) {
      const ns = r.BL();
      if (ns < 0 || ns > 1000000) throw new Error('bad hatch seg count');
      for (let s = 0; s < ns; s++) {
        const t = r.RC();
        if (t === 1) path.segs.push({ t, p0: r.P2RD(), p1: r.P2RD() });
        else if (t === 2) path.segs.push({ t, c: r.P2RD(), r: r.BD(), a0: r.BD(), a1: r.BD(), ccw: r.B() });
        else if (t === 3) path.segs.push({ t, c: r.P2RD(), major: r.P2RD(), ratio: r.BD(), a0: r.BD(), a1: r.BD(), ccw: r.B() });
        else if (t === 4) {
          const deg = r.BL(); const rat = r.B(); r.B();
          const nk = r.BL(), nc = r.BL();
          if (nk < 0 || nc < 0 || nk > 100000 || nc > 100000) throw new Error('bad hatch spline');
          const knots = new Float64Array(nk); for (let i = 0; i < nk; i++) knots[i] = r.BD();
          const ctrl = new Float64Array(nc * 3);
          const weights = rat ? new Float64Array(nc) : null;
          for (let i = 0; i < nc; i++) { ctrl[i * 3] = r.RD(); ctrl[i * 3 + 1] = r.RD(); if (rat) weights![i] = r.BD(); }
          let fit: number[] | null = null;
          if (ver >= 24) {
            const nf = r.BL();
            if (nf < 0 || nf > 100000) throw new Error('bad hatch fit');
            fit = [];
            for (let i = 0; i < nf; i++) { const q = r.P2RD(); fit.push(q[0], q[1]); }
            if (nf > 0) { r.P2RD(); r.P2RD(); }
          }
          path.segs.push({ t, deg, knots, ctrl, weights, fit });
        } else throw new Error('bad hatch edge type ' + t);
      }
    } else {
      const hasBulge = r.B(); const closed = r.B();
      const n = r.BL();
      if (n < 0 || n > 1000000) throw new Error('bad hatch poly count');
      const pts = new Float64Array(n * 2), bul = new Float64Array(n);
      for (let i = 0; i < n; i++) { pts[i * 2] = r.RD(); pts[i * 2 + 1] = r.RD(); if (hasBulge) bul[i] = r.BD(); }
      path.poly = { pts, bul, closed };
    }
    nbound += r.BL();
    e.paths.push(path);
  }
  e.style = r.BS(); e.ptype = r.BS();
  e.lines = [] as any[];
  if (!e.solid) {
    e.angle = r.BD(); e.scale = r.BD(); e.double = r.B();
    const nl = r.BS();
    for (let i = 0; i < nl; i++) {
      const ang = r.BD(), base = r.P2BD(), off = r.P2BD();
      const nd = r.BS(); const dashes: number[] = [];
      for (let k = 0; k < nd; k++) dashes.push(r.BD());
      e.lines.push({ ang, base, off, dashes });
    }
  }
  if (pixel) r.BD();
  const ns = r.BL();
  if (ns > 0 && ns < 100000) for (let i = 0; i < ns; i++) r.P2RD();
  void nbound;
  return e;
}

function decodeMLeader(h: ObjHead, e: Ent): Ent {
  const r = h.dat, ver = h.ver;
  const H = () => h.hdl.HR(h.handle);
  if (ver >= 24) r.BS();
  // MLeaderAnnotContext: AcDbObjectContextData + AcDbAnnotScaleObjectContextData
  if (ver >= 24) { r.BS(); r.B(); r.B(); }
  H(); // scale
  const nroots = r.BL();
  if (nroots < 0 || nroots > 1000) throw new Error('bad mleader roots');
  e.lines = [] as V3[][];
  for (let i = 0; i < nroots; i++) {
    r.B(); r.B(); const conn = r.P3BD(); r.P3BD();
    const nb = r.BL(); for (let k = 0; k < nb; k++) { r.P3BD(); r.P3BD(); }
    r.BL(); r.BD();
    const nl = r.BL();
    if (nl < 0 || nl > 1000) throw new Error('bad mleader lines');
    for (let k = 0; k < nl; k++) {
      const np = r.BL();
      if (np < 0 || np > 10000) throw new Error('bad mleader points');
      const pts: V3[] = [];
      for (let j = 0; j < np; j++) pts.push(r.P3BD());
      pts.push(conn);
      e.lines.push(pts);
      const nbi = r.BL(); if (nbi) { r.BL(); const nse = r.BL(); for (let j = 0; j < nse; j++) { r.P3BD(); r.P3BD(); } }
      r.BL();
      if (ver >= 24) { r.BS(); readCMC(h); H(); r.BL(); r.BD(); H(); r.BL(); }
    }
    if (ver >= 24) r.BS();
  }
  e.scale = r.BD(); e.base = r.P3BD(); e.textHeight = r.BD(); r.BD(); r.BD(); r.BS(); r.BS(); e.textAlign = r.BS(); r.BS();
  e.hasText = r.B();
  if (e.hasText) {
    e.text = TV(h); r.P3BD(); e.textStyle = H(); e.textLoc = r.P3BD(); e.textDir = r.P3BD(); e.textRot = r.BD();
    e.textW = r.BD(); r.BD(); r.BD(); r.BS(); e.textColor = readCMC(h); e.textAttach = r.BS();
  } else {
    e.hasBlock = r.B();
    if (e.hasBlock) {
      e.contentBlock = H(); r.P3BD(); e.blockLoc = r.P3BD(); e.blockScale = r.P3BD(); e.blockRot = r.BD();
    }
  }
  return e;
}

// -------------------------------------------------------------------------------- tables / objects
export function decodeTable(h: ObjHead): any {
  const r = h.dat, ver = h.ver;
  const H = () => h.hdl.HR(h.handle);
  const o: any = { kind: h.typeName, handle: h.handle };
  const tableHead = () => {
    o.name = TV(h);
    // sample finding: R2007+ stores only one BS here (flags), older versions B 64-flag, BS xrefindex+1, B xdep
    if (ver >= 21) { o.flags70 = r.BS(); }
    else { r.B(); r.BS(); r.B(); }
  };
  switch (h.typeName) {
    case 'LAYER': {
      tableHead();
      if (ver < 15) {
        // sample finding: the "on" bit reads 0 for layers that are on, so off is taken from the negated colour only
        o.frozen = !!r.B(); r.B(); o.on = true; r.B(); o.locked = !!r.B();
      } else {
        const v = r.BS();
        o.flagsRaw = v;
        o.frozen = (v & 1) !== 0; o.on = (v & 2) === 0; o.locked = (v & 8) !== 0; o.plot = (v & 16) !== 0;
        o.lweight = (v & 0x3e0) >> 5;
      }
      o.color = readCMC(h);
      H(); // xref block
      if (ver >= 15) H(); // plotstyle
      if (ver >= 21) H(); // material
      o.ltype = H();
      return o;
    }
    case 'LTYPE': {
      tableHead();
      o.desc = TV(h); o.patLen = r.BD(); r.RC();
      const nd = r.RC();
      o.dashes = [] as number[];
      let hasText = false;
      for (let i = 0; i < nd; i++) {
        const len = r.BD(); r.BS(); r.RD(); r.RD(); r.BD(); r.BD(); const sf = r.BS();
        if (sf & 2) hasText = true;
        o.dashes.push(len);
      }
      if (ver <= 18) r.bytes(256);
      else if (hasText) r.bytes(512);
      return o;
    }
    case 'STYLE': {
      tableHead();
      o.vertical = r.B(); o.shapeFile = r.B(); o.fixedH = r.BD(); o.wfactor = r.BD(); o.oblique = r.BD();
      r.RC(); r.BD(); o.font = TV(h); o.bigfont = TV(h);
      return o;
    }
    case 'BLOCK_HEADER': {
      tableHead();
      o.anonymous = r.B(); o.hasAtts = r.B(); o.isXref = r.B(); o.overlaid = r.B();
      if (ver >= 15) r.B();
      let owned = 0;
      if (ver >= 18) owned = r.BL();
      o.base = r.P3BD();
      o.xrefPath = TV(h);
      let ninserts = 0;
      if (ver >= 15) {
        for (let g = 0; g < 1000000; g++) { if (r.RC() === 0) break; ninserts++; }
        o.desc = TV(h);
        const pn = r.BL();
        if (pn > 0) r.skipBits(pn * 8);
      }
      if (ver >= 21) { o.units = r.BS(); r.B(); r.RC(); }
      H(); // null
      o.blockEnt = H();
      o.entities = null;
      if (ver < 18) {
        if (!o.isXref && !o.overlaid) { o.first = H(); o.last = H(); }
      } else {
        o.entities = [] as number[];
        for (let i = 0; i < owned; i++) o.entities.push(H());
      }
      o.endblk = H();
      if (ver >= 15) { for (let i = 0; i < ninserts; i++) H(); o.layout = H(); }
      return o;
    }
    case 'LAYOUT': {
      TV(h); TV(h); r.BS();
      o.margins = [r.BD(), r.BD(), r.BD(), r.BD()];
      o.paperW = r.BD(); o.paperH = r.BD(); o.paperSize = TV(h);
      o.plotOrigin = r.P2BD(); o.paperUnits = r.BS(); o.plotRot = r.BS(); o.plotType = r.BS();
      o.winMin = r.P2BD(); o.winMax = r.P2BD();
      if (ver < 18) r.T();
      o.realUnits = r.BD(); o.drawUnits = r.BD(); TV(h); o.scaleType = r.BS(); o.scaleFactor = r.BD(); r.P2BD();
      if (ver >= 18) { r.BS(); r.BS(); r.BS(); }
      o.name = TV(h); o.tab = r.BL(); o.flag = r.BS(); r.P3BD();
      o.limMin = r.P2RD(); o.limMax = r.P2RD(); o.insBase = r.P3BD(); r.P3BD(); r.P3BD(); r.BD(); r.BS();
      o.extMin = r.P3BD(); o.extMax = r.P3BD();
      let nvp = 0;
      if (ver >= 18) nvp = r.BL();  // sample finding: BL, not RL
      if (ver >= 18) H(); // plot view
      if (ver >= 21) H(); // visual style
      o.block = H(); o.lastVp = H();
      void nvp;
      return o;
    }
    case 'DICTIONARY': case 'ACDBDICTIONARYWDFLT': {
      const n = r.BL();
      if (ver === 14) r.RC();
      if (ver >= 15) { r.BS(); r.RC(); }
      o.items = [] as [string, number][];
      if (n < 0 || n > 1000000) return o;
      const names: string[] = [];
      for (let i = 0; i < n; i++) names.push(TV(h));
      for (let i = 0; i < n; i++) o.items.push([names[i], H()]);
      return o;
    }
    default: return o;
  }
}

export function colorOf(c: Color): Color { return c; }
export { readENC };

// LWPOLYLINE data from the flags on (also used inside proxy graphics)
export function decodeLwData(r: ObjHead['dat'], ver: number): any {
  const e: any = {};
  const f = r.BS();
  e.flags = f;
  e.cw = (f & 4) ? r.BD() : 0;
  e.elev = (f & 8) ? r.BD() : 0;
  e.thick = (f & 2) ? r.BD() : 0;
  e.ext = (f & 1) ? r.P3BD() : [0, 0, 1];
  const np = r.BL();
  const nb = (f & 16) ? r.BL() : 0;
  const nid = (ver >= 24 && (f & 1024)) ? r.BL() : 0;
  const nw = (f & 32) ? r.BL() : 0;
  if (np < 0 || np > 5000000 || nb > 5000000 || nw > 5000000 || nb < 0 || nw < 0 || nid < 0) throw new Error('bad lwpolyline counts');
  const pts = new Float64Array(np * 2);
  if (ver < 15) for (let i = 0; i < np; i++) { pts[i * 2] = r.RD(); pts[i * 2 + 1] = r.RD(); }
  else if (np > 0) {
    pts[0] = r.RD(); pts[1] = r.RD();
    for (let i = 1; i < np; i++) { pts[i * 2] = r.DD(pts[i * 2 - 2]); pts[i * 2 + 1] = r.DD(pts[i * 2 - 1]); }
  }
  const bulges = new Float64Array(np);
  for (let i = 0; i < nb; i++) { const b = r.BD(); if (i < np) bulges[i] = b; }
  for (let i = 0; i < nid; i++) r.BL();
  let widths: Float64Array | null = null;
  if (nw) { widths = new Float64Array(np * 2); for (let i = 0; i < nw; i++) { const a = r.BD(), b = r.BD(); if (i < np) { widths[i * 2] = a; widths[i * 2 + 1] = b; } } }
  e.pts = pts; e.bulges = bulges; e.widths = widths;
  e.closed = (f & 512) !== 0;
  return e;
}
