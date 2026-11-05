// IFC (ISO 16739: IFC2X3, IFC4, IFC4X3) reader producing RvtGeometry (metres, Z up).
// Clean-room implementation from the published buildingSMART IFC schema documentation and
// ISO 10303-21 / ISO 10303-42 concepts. See NOTEBOOK.md for sources.
//
// Entry points: sniffIfc(bytes), readIfc(bytes, onProgress, options)

import { StepFile, Ref, Enum, Typed, stepError, num, str, enumv, list, refs } from './step.ts';
import type { Arg } from './step.ts';
import * as G from './geom.ts';
import type { Mesh, M, Profile, Loop2 } from './geom.ts';
import { meshBoolean, fixTJunctions } from './csg.ts';
import { isZip, zipEntries, zipRead } from './zip.ts';
import type { RvtGeometry, GeomBucket, GeomElement, BBox3 } from './rvt-types.ts';

export interface IfcReadOptions {
  edges?: boolean;            // feature edges (default true)
  props?: boolean;            // property sets per element (default true)
  openings?: boolean;         // subtract IfcOpeningElement volumes from hosts (default true)
  includeSpaces?: boolean;    // IfcSpace volumes (default false, they hide the building)
  lod?: 'fast' | 'full';      // curve tessellation density (default full)
  maxTriangles?: number;      // default 20M
}

/** RvtGeometry plus optional IFC extras (see README.md) */
export interface IfcGeometry extends RvtGeometry {
  props?: Record<number, Record<string, string>>;
}
export interface IfcReadResult { kind: '3d'; geometry: IfcGeometry; info: Record<string, string | number> }

const enc = new TextEncoder();
const DEBUG = !!(globalThis as any).process?.env?.IFC_DEBUG;
const latin1 = new TextDecoder('latin1');

/** Recognise IFC by content: STEP header naming an IFC schema, or a zip holding a .ifc entry. */
export function sniffIfc(bytes: Uint8Array): boolean {
  if (isZip(bytes)) {
    try { return zipEntries(bytes).some((e) => /\.ifc$/i.test(e.name)); } catch { return false; }
  }
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  const head = latin1.decode(bytes.subarray(i, Math.min(bytes.length, i + 65536)));
  if (!/^\s*ISO-10303-21;/.test(head)) return false;
  const m = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(head);
  return !!m && /^IFC/i.test(m[1].trim());
}

// ------------------------------------------------------------------------------------- styles
interface Style { r: number; g: number; b: number; a: number; key: string; name: string | null }
function mkStyle(r: number, g: number, b: number, a: number, name: string | null): Style {
  const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
  r = q(r); g = q(g); b = q(b); a = q(a);
  return { r, g, b, a, key: `${r},${g},${b},${a}`, name };
}
interface Part { m: Mesh; st: Style | null }

const PREDEF_COLOURS: Record<string, [number, number, number]> = {
  black: [0, 0, 0], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0], magenta: [1, 0, 1], cyan: [0, 1, 1], white: [1, 1, 1],
};

const DEFAULT_COLOURS: [RegExp, [number, number, number], number][] = [
  [/^IfcWall/, [0.9, 0.89, 0.86], 1],
  [/^IfcCurtainWall/, [0.55, 0.72, 0.85], 0.45],
  [/^IfcWindow/, [0.55, 0.72, 0.85], 0.45],
  [/^IfcDoor/, [0.62, 0.47, 0.32], 1],
  [/^IfcSlab/, [0.74, 0.74, 0.72], 1],
  [/^IfcRoof/, [0.62, 0.33, 0.28], 1],
  [/^IfcCovering/, [0.85, 0.84, 0.8], 1],
  [/^Ifc(Column|Pile|Footing)/, [0.78, 0.78, 0.76], 1],
  [/^Ifc(Beam|Member|Plate)/, [0.68, 0.7, 0.74], 1],
  [/^Ifc(Stair|Ramp)/, [0.8, 0.78, 0.74], 1],
  [/^IfcRailing/, [0.42, 0.42, 0.46], 1],
  [/^Ifc(Furnishing|Furniture|SystemFurniture)/, [0.76, 0.62, 0.46], 1],
  [/^IfcSpace/, [0.5, 0.7, 0.95], 0.2],
  [/^IfcSite/, [0.56, 0.68, 0.46], 1],
  [/^IfcGeographicElement/, [0.45, 0.65, 0.4], 1],
  [/^Ifc(Pipe|Duct|Cable|Flow|Distribution|Valve|Pump|Fan|AirTerminal|Tank|Boiler|Chiller|Coil|Damper)/, [0.55, 0.62, 0.72], 1],
  [/^IfcReinforcing/, [0.45, 0.35, 0.3], 1],
  [/^Ifc(Road|Pavement|Course|Kerb|EarthworksFill|EarthworksCut)/, [0.55, 0.55, 0.55], 1],
  [/^IfcBuildingElementProxy/, [0.72, 0.72, 0.72], 1],
];
function defaultColour(cls: string): [number, number, number, number] {
  for (const [re, c, a] of DEFAULT_COLOURS) if (re.test(cls)) return [c[0], c[1], c[2], a];
  return [0.75, 0.75, 0.75, 1];
}

// IFC class names in their documented spelling (upper case in the file)
const CLASS_NAMES = ('IfcActuator IfcAirTerminal IfcAirTerminalBox IfcAirToAirHeatRecovery IfcAlarm IfcAlignment IfcAnnotation IfcAudioVisualAppliance ' +
  'IfcBeam IfcBeamStandardCase IfcBearing IfcBoiler IfcBorehole IfcBridge IfcBridgePart IfcBuilding IfcBuildingElementComponent IfcBuildingElementPart IfcBuildingElementProxy IfcBuildingStorey IfcBuiltElement IfcBurner ' +
  'IfcCableCarrierFitting IfcCableCarrierSegment IfcCableFitting IfcCableSegment IfcCaissonFoundation IfcChiller IfcChimney IfcCivilElement IfcCoil IfcColumn IfcColumnStandardCase ' +
  'IfcCommunicationsAppliance IfcCompressor IfcCondenser IfcController IfcConveyorSegment IfcCooledBeam IfcCoolingTower IfcCourse IfcCovering IfcCurtainWall ' +
  'IfcDamper IfcDeepFoundation IfcDiscreteAccessory IfcDistributionBoard IfcDistributionChamberElement IfcDistributionControlElement IfcDistributionElement IfcDistributionFlowElement IfcDistributionPort IfcDoor IfcDoorStandardCase ' +
  'IfcDuctFitting IfcDuctSegment IfcDuctSilencer IfcEarthworksCut IfcEarthworksElement IfcEarthworksFill IfcElectricAppliance IfcElectricDistributionBoard IfcElectricDistributionPoint IfcElectricFlowStorageDevice IfcElectricFlowTreatmentDevice ' +
  'IfcElectricGenerator IfcElectricHeater IfcElectricMotor IfcElectricTimeControl IfcElectricalElement IfcElement IfcElementAssembly IfcElementComponent IfcEnergyConversionDevice IfcEngine IfcEquipmentElement IfcEvaporativeCooler IfcEvaporator ' +
  'IfcFacility IfcFacilityPart IfcFacilityPartCommon IfcFan IfcFastener IfcFilter IfcFireSuppressionTerminal IfcFlowController IfcFlowFitting IfcFlowInstrument IfcFlowMeter IfcFlowMovingDevice IfcFlowSegment IfcFlowStorageDevice ' +
  'IfcFlowTerminal IfcFlowTreatmentDevice IfcFooting IfcFurnishingElement IfcFurniture IfcGasTerminal IfcGeographicElement IfcGeomodel IfcGeoslice IfcGeotechnicalAssembly IfcGeotechnicalElement IfcGeotechnicalStratum IfcGrid IfcHeatExchanger IfcHumidifier ' +
  'IfcImpactProtectionDevice IfcInterceptor IfcJunctionBox IfcKerb IfcLamp IfcLightFixture IfcLinearPositioningElement IfcLiquidTerminal IfcMarineFacility IfcMarinePart IfcMechanicalFastener IfcMedicalDevice IfcMember IfcMemberStandardCase ' +
  'IfcMobileTelecommunicationsAppliance IfcMooringDevice IfcMotorConnection IfcNavigationElement IfcOpeningElement IfcOpeningStandardCase IfcOutlet IfcPavement IfcPile IfcPipeFitting IfcPipeSegment IfcPlate IfcPlateStandardCase ' +
  'IfcProjectionElement IfcProtectiveDevice IfcProtectiveDeviceTrippingUnit IfcProxy IfcPump IfcRail IfcRailing IfcRailway IfcRailwayPart IfcRamp IfcRampFlight IfcReferent IfcReinforcedSoil IfcReinforcingBar IfcReinforcingElement IfcReinforcingMesh ' +
  'IfcRoad IfcRoadPart IfcRoof IfcSanitaryTerminal IfcSensor IfcShadingDevice IfcSign IfcSignal IfcSite IfcSlab IfcSlabElementedCase IfcSlabStandardCase IfcSolarDevice IfcSolidStratum IfcSpace IfcSpaceHeater IfcSpatialZone IfcStackTerminal IfcStair IfcStairFlight ' +
  'IfcStructuralCurveMember IfcStructuralSurfaceMember IfcSurfaceFeature IfcSwitchingDevice IfcSystemFurnitureElement IfcTank IfcTendon IfcTendonAnchor IfcTendonConduit IfcTrackElement IfcTransformer IfcTransportElement IfcTubeBundle ' +
  'IfcUnitaryControlElement IfcUnitaryEquipment IfcValve IfcVehicle IfcVibrationDamper IfcVibrationIsolator IfcVirtualElement IfcVoidStratum IfcVoidingFeature IfcWall IfcWallElementedCase IfcWallStandardCase IfcWasteTerminal IfcWaterStratum IfcWindow IfcWindowStandardCase ' +
  'IfcCartesianPoint IfcProject IfcSurfaceOfRevolution IfcSurfaceOfLinearExtrusion IfcSphericalSurface IfcToroidalSurface IfcConicalSurface IfcCylindricalSurface IfcSectionedSolidHorizontal IfcSectionedSpine IfcSectionedSolid IfcSectionedSurface IfcGeometricCurveSet IfcOffsetCurve2D IfcOffsetCurve3D IfcOffsetCurveByDistances IfcCurveSegment IfcGradientCurve IfcSegmentedReferenceCurve IfcCompositeCurve IfcPolygonalBoundedHalfSpace IfcBooleanClippingResult IfcBooleanResult IfcExtrudedAreaSolidTapered IfcRevolvedAreaSolidTapered IfcSweptDiskSolidPolygonal IfcAdvancedBrepWithVoids IfcFacetedBrepWithVoids IfcBSplineSurfaceWithKnots IfcRationalBSplineSurfaceWithKnots IfcTriangulatedIrregularNetwork IfcPolygonalFaceSet IfcTriangulatedFaceSet IfcIndexedPolyCurve IfcMappedItem IfcCsgSolid IfcBlock IfcSphere IfcTextLiteral IfcFixedReferenceSweptAreaSolid IfcSurfaceCurveSweptAreaSolid IfcDirectrixCurveSweptAreaSolid IfcCurveBoundedPlane IfcCurveBoundedSurface IfcRectangularTrimmedSurface IfcLinearPlacement IfcGridPlacement IfcArbitraryOpenProfileDef IfcCenterLineProfileDef IfcAsymmetricIShapeProfileDef IfcRoundedRectangleProfileDef IfcRectangleHollowProfileDef IfcCircleHollowProfileDef IfcMirroredProfileDef IfcDerivedProfileDef IfcCompositeProfileDef').split(' ');
const CLASS_BY_UPPER = new Map(CLASS_NAMES.map((n) => [n.toUpperCase(), n]));
export function ifcClassName(upper: string): string {
  const k = CLASS_BY_UPPER.get(upper);
  if (k) return k;
  if (upper.startsWith('IFC')) return 'Ifc' + upper.charAt(3) + upper.slice(4).toLowerCase();
  return upper;
}

const SKIP_CLASSES = new Set(['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVIRTUALELEMENT', 'IFCANNOTATION', 'IFCGRID', 'IFCALIGNMENT', 'IFCVOIDINGFEATURE', 'IFCSPATIALZONE']);
const BODY_IDS = new Set(['body', 'facetation', 'body-fallback', 'mesh']);
const NON_BODY_IDS = new Set(['axis', 'footprint', 'box', 'annotation', 'profile', 'clearance', 'plan', 'reference', 'lighting', 'cog', 'surface', 'survey', 'boundingbox']);
const SOLID_REP_TYPES = new Set(['sweptsolid', 'advancedsweptsolid', 'brep', 'advancedbrep', 'csg', 'clipping', 'mappedrepresentation', 'tessellation', 'surfacemodel', 'solidmodel', 'triangulatedfaceset']);

const PREFIX: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18 };

// ------------------------------------------------------------------------------------- reader
class IfcReader {
  f: StepFile;
  opt: Required<IfcReadOptions>;
  schema = '';
  lenScale = 1;          // file length unit -> metres
  angScale = 1;          // file plane angle unit -> radians
  lenUnitName = 'm';
  angUnitName = 'radian';
  eps = 1e-5;            // CSG tolerance in file units
  warnCounts = new Map<string, number>();
  placementCache = new Map<number, M>();
  mapCache = new Map<number, Part[]>();
  itemStyle = new Map<number, Style>();
  matStyle = new Map<number, Style>();
  layerOf = new Map<number, string>();
  layerStyle = new Map<number, Style>();
  colourMapOf = new Map<number, number>();
  styleCache = new Map<number, Style | null>();
  skippedFaces = 0;
  depth = 0;
  boolNest = 0;
  budget = { ops: 0 };

  constructor(f: StepFile, opt: Required<IfcReadOptions>) { this.f = f; this.opt = opt; }

  warn(msg: string) { this.warnCounts.set(msg, (this.warnCounts.get(msg) || 0) + 1); }
  A(id: number): Arg[] { return this.f.args(id) || []; }
  T(id: number): string { return this.f.typeOf(id); }
  rid(v: Arg): number { return v instanceof Ref ? v.id : 0; }

  // ------------------------------------------------------------------ basic geometry
  P(v: Arg): number[] {
    const out = [0, 0, 0];
    if (v instanceof Ref) {
      const t = this.T(v.id);
      if (t === 'IFCCARTESIANPOINT') this.f.point(v.id, out);
      else if (t === 'IFCVERTEXPOINT') return this.P(this.A(v.id)[0]);
      else this.warn(`point type ${t} not supported`);
    } else if (Array.isArray(v)) { for (let i = 0; i < 3 && i < v.length; i++) out[i] = num(v[i]); }
    return out;
  }
  D(v: Arg, def: number[] | null = null): number[] | null {
    if (!(v instanceof Ref)) return def;
    const out = [0, 0, 0];
    const t = this.T(v.id);
    if (t === 'IFCDIRECTION') this.f.point(v.id, out);
    else if (t === 'IFCVECTOR') { const a = this.A(v.id); const d = this.D(a[0], [1, 0, 0])!; return d; }
    else return def;
    const l = Math.hypot(out[0], out[1], out[2]);
    if (!(l > 1e-300)) return def;
    return [out[0] / l, out[1] / l, out[2] / l];
  }
  frame(o: number[], z: number[], x: number[]): M {
    z = G.norm3(z);
    let xx = G.sub3(x, z.map((q) => q * G.dot3(x, z)));
    if (G.len3(xx) < 1e-9) { const alt = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; xx = G.sub3(alt, z.map((q) => q * G.dot3(alt, z))); }
    xx = G.norm3(xx);
    const y = G.cross3(z, xx);
    return G.fromAxes(o, xx, y, z);
  }
  axis(v: Arg): M {
    if (!(v instanceof Ref)) return G.ident();
    const t = this.T(v.id), a = this.A(v.id);
    if (t === 'IFCAXIS2PLACEMENT3D') return this.frame(this.P(a[0]), this.D(a[1], [0, 0, 1])!, this.D(a[2], [1, 0, 0])!);
    if (t === 'IFCAXIS2PLACEMENT2D') { const x = this.D(a[1], [1, 0, 0])!; return this.frame(this.P(a[0]), [0, 0, 1], [x[0], x[1], 0]); }
    if (t === 'IFCAXIS1PLACEMENT') return this.frame(this.P(a[0]), this.D(a[1], [0, 0, 1])!, [1, 0, 0]);
    if (t.startsWith('IFCCARTESIANTRANSFORMATIONOPERATOR')) return this.xformOp(v);
    this.warn(`placement type ${t} not supported`);
    return G.ident();
  }
  /** IfcCartesianTransformationOperator2D/3D (+NonUniform), ISO 10303-42 base_axis rules */
  xformOp(v: Arg): M {
    if (!(v instanceof Ref)) return G.ident();
    const t = this.T(v.id), a = this.A(v.id);
    const is3 = t.includes('3D');
    const ax1 = this.D(a[0]), ax2 = this.D(a[1]);
    const o = this.P(a[2]);
    const s = typeof a[3] === 'number' || a[3] instanceof Typed ? num(a[3], 1) : 1;
    let s2 = s, s3 = s;
    let z = [0, 0, 1];
    if (is3) {
      z = this.D(a[4], [0, 0, 1])!;
      if (t.endsWith('NONUNIFORM')) { s2 = a[5] != null ? num(a[5], s) : s; s3 = a[6] != null ? num(a[6], s) : s; }
    } else if (t.endsWith('NONUNIFORM')) s2 = a[4] != null ? num(a[4], s) : s;
    // first_proj_axis
    let xv = ax1 || (Math.abs(Math.abs(z[0]) - 1) < 1e-9 ? [0, 1, 0] : [1, 0, 0]);
    xv = G.norm3(G.sub3(xv, z.map((q) => q * G.dot3(xv, z))));
    // second_proj_axis
    let yv = ax2 || G.cross3(z, xv);
    yv = G.sub3(yv, z.map((q) => q * G.dot3(yv, z)));
    yv = G.sub3(yv, xv.map((q) => q * G.dot3(yv, xv)));
    yv = G.len3(yv) < 1e-9 ? G.cross3(z, xv) : G.norm3(yv);
    const m = G.fromAxes(o, xv.map((q) => q * s), yv.map((q) => q * s2), z.map((q) => q * s3));
    return m;
  }
  placement(id: number): M {
    const c = this.placementCache.get(id);
    if (c) return c;
    if (this.depth > 200) { this.warn('placement chain too deep (cycle?)'); return G.ident(); }
    this.depth++;
    let m: M;
    try {
      const t = this.T(id), a = this.A(id);
      if (t === 'IFCLOCALPLACEMENT') {
        const rel = a[0] instanceof Ref ? this.placement(a[0].id) : null;
        const loc = this.axis(a[1]);
        m = rel ? G.mul(rel, loc) : loc;
      } else if (t === 'IFCLINEARPLACEMENT') {
        const rel = a[0] instanceof Ref ? this.placement(a[0].id) : null;
        if (a[2] instanceof Ref) { const loc = this.axis(a[2]); m = rel ? G.mul(rel, loc) : loc; }
        else { this.warn('IfcLinearPlacement without CartesianPosition: element placed at its reference'); m = rel || G.ident(); }
      } else if (t === 'IFCGRIDPLACEMENT') {
        m = this.gridPlacement(a);
      } else { this.warn(t ? `object placement ${t} not supported` : 'reference to a missing entity (truncated or broken file)'); m = G.ident(); }
    } finally { this.depth--; }
    this.placementCache.set(id, m);
    return m;
  }
  private gridOfAxis: Map<number, number> | null = null;
  gridPlacement(a: Arg[]): M {
    // IFC4+: (PlacementRelTo, PlacementLocation, PlacementRefDirection); IFC2X3: (PlacementLocation, PlacementRefDirection)
    if (a.length >= 3 || (a[0] instanceof Ref && this.T(a[0].id) !== 'IFCVIRTUALGRIDINTERSECTION')) a = a.slice(1);
    // IfcVirtualGridIntersection(IntersectingAxes, OffsetDistances)
    const vi = a[0] instanceof Ref ? this.A(a[0].id) : [];
    const axes = refs(vi[0]);
    const offs = list(vi[1]).map((x) => num(x));
    if (!this.gridOfAxis) {
      this.gridOfAxis = new Map();
      for (const g of this.f.idsOfType('IFCGRID')) {
        const ga = this.A(g);
        for (const k of [7, 8, 9]) for (const ax of refs(ga[k])) this.gridOfAxis.set(ax, g);
      }
    }
    if (axes.length < 2) { this.warn('IfcGridPlacement without two axes'); return G.ident(); }
    const line = (ax: number) => {
      const aa = this.A(ax);
      const c = this.curve(this.rid(aa[1]));
      if (!c || c.pts.length < 2) return null;
      let p0 = c.pts[0], p1 = c.pts[c.pts.length - 1];
      if (enumv(aa[2]) === 'F') { const t = p0; p0 = p1; p1 = t; }
      return [p0, p1];
    };
    const l1 = line(axes[0]), l2 = line(axes[1]);
    const grid = this.gridOfAxis.get(axes[0]);
    const gm = grid ? (this.A(grid)[5] instanceof Ref ? this.placement((this.A(grid)[5] as Ref).id) : G.ident()) : G.ident();
    if (!l1 || !l2) return gm;
    const d1 = G.norm3(G.sub3(l1[1], l1[0])), d2 = G.norm3(G.sub3(l2[1], l2[0]));
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    let p = l1[0];
    if (Math.abs(den) > 1e-12) {
      const dx = l2[0][0] - l1[0][0], dy = l2[0][1] - l1[0][1];
      const t = (dx * d2[1] - dy * d2[0]) / den;
      p = [l1[0][0] + d1[0] * t, l1[0][1] + d1[1] * t, 0];
    }
    // offsets: along first axis normal, second axis normal, z
    const n1 = [-d1[1], d1[0], 0];
    const o = [p[0] + (offs[0] || 0) * n1[0], p[1] + (offs[0] || 0) * n1[1], offs[2] || 0];
    if (offs[1]) { const n2 = [-d2[1], d2[0], 0]; o[0] += offs[1] * n2[0]; o[1] += offs[1] * n2[1]; }
    let xdir = d1;
    if (a[1] instanceof Ref) {
      const rt = this.T(a[1].id);
      if (rt === 'IFCDIRECTION') xdir = this.D(a[1], d1)!;
      else if (rt === 'IFCVIRTUALGRIDINTERSECTION') {
        const q = this.gridPlacement([a[1]]);
        const dx = q[3] - gm[3], dy = q[7] - gm[7];
        const loc = [gm[0] * o[0] + gm[1] * o[1] + gm[3], gm[4] * o[0] + gm[5] * o[1] + gm[7]];
        void dx; void dy;
        const v = [q[3] - loc[0], q[7] - loc[1], 0];
        if (G.len3(v) > 1e-9) { const ig = G.inv(gm); xdir = G.norm3([ig[0] * v[0] + ig[1] * v[1], ig[4] * v[0] + ig[5] * v[1], 0]); }
      }
    }
    return G.mul(gm, this.frame(o, [0, 0, 1], xdir));
  }

  // ------------------------------------------------------------------ units
  readUnits() {
    let ua = 0;
    const proj = this.f.idsOfType('IFCPROJECT', 'IFCPROJECTLIBRARY')[0];
    if (proj) ua = this.rid(this.A(proj)[8]);
    if (!ua) ua = this.f.idsOfType('IFCUNITASSIGNMENT')[0] || 0;
    if (!ua) { this.warn('no IfcUnitAssignment: assuming metres and radians'); return; }
    const unitScale = (id: number, depth = 0): { type: string; scale: number; name: string } | null => {
      if (depth > 5) return null;
      const t = this.T(id), a = this.A(id);
      if (t === 'IFCSIUNIT') {
        const pre = enumv(a[2]);
        const nm = enumv(a[3]) || '';
        let s = pre ? PREFIX[pre] ?? 1 : 1;
        if (nm === 'DEGREE') s = Math.PI / 180;
        return { type: enumv(a[1]) || '', scale: s, name: (pre ? pre.toLowerCase() : '') + nm.toLowerCase() };
      }
      if (t === 'IFCCONVERSIONBASEDUNIT' || t === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
        const mw = this.A(this.rid(a[3]));
        const v = num(mw[0], 1);
        const base = this.rid(mw[1]) ? unitScale(this.rid(mw[1]), depth + 1) : null;
        return { type: enumv(a[1]) || '', scale: v * (base ? base.scale : 1), name: (str(a[2]) || '').toLowerCase() };
      }
      return null;
    };
    for (const u of refs(this.A(ua)[0])) {
      const r = unitScale(u);
      if (!r) continue;
      if (r.type === 'LENGTHUNIT') { this.lenScale = r.scale; this.lenUnitName = r.name || 'm'; }
      if (r.type === 'PLANEANGLEUNIT') { this.angScale = r.scale; this.angUnitName = r.name || 'radian'; }
    }
    if (!(this.lenScale > 0)) this.lenScale = 1;
    this.eps = 1e-6 / this.lenScale;
  }

  // ------------------------------------------------------------------ styles
  colour(v: Arg): [number, number, number] | null {
    if (!(v instanceof Ref)) return null;
    const t = this.T(v.id), a = this.A(v.id);
    if (t === 'IFCCOLOURRGB') return [num(a[1]), num(a[2]), num(a[3])];
    if (t === 'IFCDRAUGHTINGPREDEFINEDCOLOUR') return PREDEF_COLOURS[(str(a[0]) || '').toLowerCase()] || null;
    return null;
  }
  /** style from a list of IfcPresentationStyleSelect / IfcPresentationStyleAssignment */
  styleFrom(styles: Arg, depth = 0): Style | null {
    let fill: Style | null = null;
    for (const s of refs(styles)) {
      const t = this.T(s), a = this.A(s);
      if (t === 'IFCPRESENTATIONSTYLEASSIGNMENT' && depth < 3) { const r = this.styleFrom(a[0], depth + 1); if (r) return r; continue; }
      if (t === 'IFCSURFACESTYLE') {
        const c = this.styleCache.get(s);
        if (c !== undefined) { if (c) return c; continue; }
        let res: Style | null = null;
        const name = str(a[0]);
        for (const e of refs(a[2])) {
          const et = this.T(e), ea = this.A(e);
          if (et === 'IFCSURFACESTYLERENDERING' || et === 'IFCSURFACESTYLESHADING') {
            const col = this.colour(ea[0]);
            if (!col) continue;
            const tr = ea.length > 1 && ea[1] != null ? num(ea[1]) : 0;
            res = mkStyle(col[0], col[1], col[2], 1 - Math.max(0, Math.min(1, tr)), name);
            if (et === 'IFCSURFACESTYLERENDERING') break;
          }
        }
        this.styleCache.set(s, res);
        if (res) return res;
      }
      if (t === 'IFCFILLAREASTYLE' && !fill) {
        for (const e of list(a[1])) { const col = this.colour(e); if (col) { fill = mkStyle(col[0], col[1], col[2], 1, str(a[0])); break; } }
      }
    }
    return fill;
  }
  readStyles() {
    for (const id of this.f.idsOfType('IFCSTYLEDITEM')) {
      const a = this.f.argsNoCache(id) || [];
      if (!(a[0] instanceof Ref)) continue;
      const st = this.styleFrom(a[1]);
      if (st) this.itemStyle.set(a[0].id, st);
    }
    for (const id of this.f.idsOfType('IFCMATERIALDEFINITIONREPRESENTATION')) {
      const a = this.A(id);
      const mat = this.rid(a[3]);
      if (!mat) continue;
      for (const rep of refs(a[2])) {
        for (const it of refs(this.A(rep)[3])) {
          const ia = this.A(it);
          if (this.T(it) !== 'IFCSTYLEDITEM') continue;
          const st = this.styleFrom(ia[1]);
          if (st && !this.matStyle.has(mat)) this.matStyle.set(mat, st);
        }
      }
    }
    for (const id of this.f.idsOfType('IFCPRESENTATIONLAYERASSIGNMENT', 'IFCPRESENTATIONLAYERWITHSTYLE')) {
      const a = this.A(id);
      const name = str(a[0]) || '';
      const withStyle = this.T(id) === 'IFCPRESENTATIONLAYERWITHSTYLE';
      const st = withStyle ? this.styleFrom(a[7]) : null;
      for (const it of refs(a[2])) {
        if (!this.layerOf.has(it)) this.layerOf.set(it, name);
        if (st && !this.layerStyle.has(it)) this.layerStyle.set(it, st);
      }
    }
    for (const id of this.f.idsOfType('IFCINDEXEDCOLOURMAP')) {
      const a = this.A(id);
      if (a[0] instanceof Ref) this.colourMapOf.set(a[0].id, id);
    }
  }
  materialStyle(id: number, depth = 0): Style | null {
    if (!id || depth > 4) return null;
    const t = this.T(id), a = this.A(id);
    switch (t) {
      case 'IFCMATERIAL': return this.matStyle.get(id) || null;
      case 'IFCMATERIALLAYERSETUSAGE': case 'IFCMATERIALPROFILESETUSAGE': case 'IFCMATERIALPROFILESETUSAGETAPERING':
        return this.materialStyle(this.rid(a[0]), depth + 1);
      case 'IFCMATERIALLAYERSET': {
        let best: Style | null = null, bt = -1;
        for (const l of refs(a[0])) {
          const la = this.A(l);
          const s = this.materialStyle(this.rid(la[0]), depth + 1);
          const th = num(la[1]);
          if (s && th > bt) { best = s; bt = th; }
        }
        return best;
      }
      case 'IFCMATERIALLIST': for (const m of refs(a[0])) { const s = this.materialStyle(m, depth + 1); if (s) return s; } return null;
      case 'IFCMATERIALPROFILESET': for (const m of refs(a[2])) { const s = this.materialStyle(this.rid(this.A(m)[2]), depth + 1); if (s) return s; } return null;
      case 'IFCMATERIALCONSTITUENTSET': for (const m of refs(a[2])) { const s = this.materialStyle(this.rid(this.A(m)[2]), depth + 1); if (s) return s; } return null;
      case 'IFCMATERIALLAYER': case 'IFCMATERIALPROFILE': case 'IFCMATERIALCONSTITUENT':
        return this.materialStyle(this.rid(a[t === 'IFCMATERIALLAYER' ? 0 : 2]), depth + 1);
    }
    return null;
  }
  materialNames(id: number, out: string[], depth = 0) {
    if (!id || depth > 4) return;
    const t = this.T(id), a = this.A(id);
    switch (t) {
      case 'IFCMATERIAL': { const n = str(a[0]); if (n && !out.includes(n)) out.push(n); return; }
      case 'IFCMATERIALLAYERSETUSAGE': case 'IFCMATERIALPROFILESETUSAGE': case 'IFCMATERIALPROFILESETUSAGETAPERING': this.materialNames(this.rid(a[0]), out, depth + 1); return;
      case 'IFCMATERIALLAYERSET': case 'IFCMATERIALLIST': for (const l of refs(a[0])) this.materialNames(l, out, depth + 1); return;
      case 'IFCMATERIALLAYER': this.materialNames(this.rid(a[0]), out, depth + 1); return;
      case 'IFCMATERIALPROFILESET': case 'IFCMATERIALCONSTITUENTSET': for (const l of refs(a[2])) this.materialNames(l, out, depth + 1); return;
      case 'IFCMATERIALPROFILE': case 'IFCMATERIALCONSTITUENT': this.materialNames(this.rid(a[2]), out, depth + 1); return;
    }
  }

  // ------------------------------------------------------------------ curves
  segs(r: number, sweep: number): number {
    const rm = Math.abs(r) * this.lenScale;
    let base = rm < 0.01 ? 8 : rm < 0.05 ? 12 : rm < 0.2 ? 16 : rm < 1 ? 24 : rm < 5 ? 36 : 48;
    if (this.opt.lod === 'fast') base = Math.max(6, base >> 1);
    return Math.max(1, Math.ceil((base * Math.abs(sweep)) / (2 * Math.PI) - 1e-9));
  }
  /** conic (circle/ellipse) basis: returns local frame and radii */
  conic(id: number): { m: M; rx: number; ry: number } | null {
    const t = this.T(id), a = this.A(id);
    if (t === 'IFCCIRCLE') { const r = num(a[1]); return { m: this.axis(a[0]), rx: r, ry: r }; }
    if (t === 'IFCELLIPSE') return { m: this.axis(a[0]), rx: num(a[1]), ry: num(a[2]) };
    return null;
  }
  conicPts(c: { m: M; rx: number; ry: number }, t0: number, sweep: number): number[][] {
    const n = this.segs(Math.max(c.rx, c.ry), sweep);
    const out: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + (sweep * i) / n;
      const p = [0, 0, 0];
      G.applyM(c.m, [c.rx * Math.cos(t), c.ry * Math.sin(t), 0], p);
      out.push(p);
    }
    return out;
  }
  conicParamOf(c: { m: M; rx: number; ry: number }, p: number[]): number {
    const im = G.inv(c.m);
    const q = [0, 0, 0];
    G.applyM(im, p, q);
    return Math.atan2(q[1] / (c.ry || 1), q[0] / (c.rx || 1));
  }
  /** Polyline approximation of a curve: points in the curve's coordinate space (z = 0 for 2D). */
  curve(id: number, depth = 0): { pts: number[][]; closed: boolean } | null {
    if (!id || depth > 30) return null;
    const t = this.T(id), a = this.A(id);
    switch (t) {
      case 'IFCPOLYLINE': {
        const pts = refs(a[0]).map((p) => this.P(new Ref(p)));
        return { pts, closed: pts.length > 2 && G.len3(G.sub3(pts[0], pts[pts.length - 1])) < this.eps * 10 };
      }
      case 'IFCCIRCLE': case 'IFCELLIPSE': {
        const c = this.conic(id)!;
        const pts = this.conicPts(c, 0, 2 * Math.PI);
        pts.pop();
        return { pts, closed: true };
      }
      case 'IFCTRIMMEDCURVE': return this.trimmed(id, a, depth);
      case 'IFCCOMPOSITECURVE': case 'IFCCOMPOSITECURVEONSURFACE': case 'IFCOUTERBOUNDARYCURVE': case 'IFCBOUNDARYCURVE': {
        const pts: number[][] = [];
        for (const s of refs(a[0])) {
          const st = this.T(s), sa = this.A(s);
          let c: { pts: number[][]; closed: boolean } | null = null;
          let same = true;
          if (st === 'IFCCOMPOSITECURVESEGMENT' || st === 'IFCREPARAMETRISEDCOMPOSITECURVESEGMENT') { same = enumv(sa[1]) !== 'F'; c = this.curve(this.rid(sa[2]), depth + 1); }
          else if (st === 'IFCCURVESEGMENT') { this.warn('IfcCurveSegment (alignment geometry) not supported'); continue; }
          else c = this.curve(s, depth + 1);
          if (!c) continue;
          let sp = c.pts.slice();
          if (c.closed && sp.length) sp.push(sp[0]);
          if (!same) sp.reverse();
          if (pts.length && sp.length && G.len3(G.sub3(pts[pts.length - 1], sp[0])) < this.eps * 100) sp = sp.slice(1);
          for (const p of sp) pts.push(p);
        }
        const closed = pts.length > 2 && G.len3(G.sub3(pts[0], pts[pts.length - 1])) < this.eps * 100;
        if (closed) pts.pop();
        return { pts, closed };
      }
      case 'IFCINDEXEDPOLYCURVE': {
        const pl = this.A(this.rid(a[0]));
        const coords = list(pl[0]).map((c) => { const l = list(c); return [num(l[0]), num(l[1]), num(l[2])]; });
        const pts: number[][] = [];
        const push = (p: number[]) => { if (!pts.length || G.len3(G.sub3(pts[pts.length - 1], p)) > this.eps) pts.push(p); };
        if (a[1] == null || !list(a[1]).length) for (const p of coords) push(p);
        else for (const seg of list(a[1])) {
          if (!(seg instanceof Typed)) continue;
          const ix = list(seg.val).map((x) => num(x) - 1);
          if (seg.type === 'IFCARCINDEX' && ix.length >= 3) {
            for (const p of this.arc3(coords[ix[0]], coords[ix[1]], coords[ix[2]])) push(p);
          } else for (const k of ix) if (coords[k]) push(coords[k]);
        }
        const closed = pts.length > 2 && G.len3(G.sub3(pts[0], pts[pts.length - 1])) < this.eps * 100;
        if (closed) pts.pop();
        return { pts, closed };
      }
      case 'IFCLINE': {
        const p = this.P(a[0]);
        const va = this.A(this.rid(a[1]));
        const d = this.D(va[0], [1, 0, 0])!;
        const mlen = num(va[1], 1);
        return { pts: [p, [p[0] + d[0] * mlen, p[1] + d[1] * mlen, p[2] + d[2] * mlen]], closed: false };
      }
      case 'IFCBSPLINECURVEWITHKNOTS': case 'IFCRATIONALBSPLINECURVEWITHKNOTS': {
        const pts = this.bspline(a, t === 'IFCRATIONALBSPLINECURVEWITHKNOTS');
        const closed = pts.length > 2 && G.len3(G.sub3(pts[0], pts[pts.length - 1])) < this.eps * 100;
        if (closed) pts.pop();
        return { pts, closed };
      }
      case 'IFCOFFSETCURVE2D': {
        const c = this.curve(this.rid(a[0]), depth + 1);
        if (!c) return null;
        return { pts: offsetPolyline(c.pts, num(a[1]), c.closed), closed: c.closed };
      }
      case 'IFCPOLYGONALBOUNDEDHALFSPACE': return null;
    }
    this.warn(`curve type ${t} not supported`);
    return null;
  }
  /** points of the arc through three points (inclusive) */
  arc3(p0: number[], p1: number[], p2: number[]): number[][] {
    const u = G.sub3(p1, p0), v = G.sub3(p2, p0);
    const n = G.cross3(u, v);
    const nn = G.dot3(n, n);
    if (nn < 1e-24 * (G.dot3(u, u) * G.dot3(v, v) + 1e-300)) return [p0, p2];
    // circumcentre
    const uu = G.dot3(u, u), vv = G.dot3(v, v);
    const a = G.cross3(n, u).map((x) => x * vv), b = G.cross3(v, n).map((x) => x * uu);
    const c = [p0[0] + (a[0] + b[0]) / (2 * nn), p0[1] + (a[1] + b[1]) / (2 * nn), p0[2] + (a[2] + b[2]) / (2 * nn)];
    const r = G.len3(G.sub3(p0, c));
    const ex = G.norm3(G.sub3(p0, c)), nz = G.norm3(n), ey = G.cross3(nz, ex);
    const ang = (p: number[]) => { const d = G.sub3(p, c); let t = Math.atan2(G.dot3(d, ey), G.dot3(d, ex)); if (t < 0) t += 2 * Math.PI; return t; };
    const t2 = ang(p2);
    const ns = this.segs(r, t2);
    const out: number[][] = [];
    for (let i = 0; i <= ns; i++) {
      const t = (t2 * i) / ns;
      out.push([c[0] + r * (Math.cos(t) * ex[0] + Math.sin(t) * ey[0]), c[1] + r * (Math.cos(t) * ex[1] + Math.sin(t) * ey[1]), c[2] + r * (Math.cos(t) * ex[2] + Math.sin(t) * ey[2])]);
    }
    out[0] = p0; out[out.length - 1] = p2;
    return out;
  }
  trimmed(id: number, a: Arg[], depth: number): { pts: number[][]; closed: boolean } | null {
    const basis = this.rid(a[0]);
    const bt = this.T(basis);
    const sense = enumv(a[3]) !== 'F';
    const master = enumv(a[4]) || 'UNSPECIFIED';
    const trim = (v: Arg) => {
      let par: number | null = null, pt: number[] | null = null;
      for (const x of list(v)) {
        if (x instanceof Typed && x.type === 'IFCPARAMETERVALUE') par = num(x.val);
        else if (typeof x === 'number') par = x;
        else if (x instanceof Ref) pt = this.P(x);
      }
      return { par, pt };
    };
    const t1 = trim(a[1]), t2 = trim(a[2]);
    const useParam = (t: { par: number | null; pt: number[] | null }) => t.par != null && (master !== 'CARTESIAN' || !t.pt);
    if (bt === 'IFCCIRCLE' || bt === 'IFCELLIPSE') {
      const c = this.conic(basis)!;
      const ang = (t: { par: number | null; pt: number[] | null }) => (useParam(t) ? t.par! * this.angScale : t.pt ? this.conicParamOf(c, t.pt) : 0);
      const a1 = ang(t1);
      let a2 = ang(t2);
      let sweep: number;
      if (sense) { while (a2 <= a1 + 1e-12) a2 += 2 * Math.PI; sweep = a2 - a1; while (sweep > 2 * Math.PI + 1e-9) sweep -= 2 * Math.PI; }
      else { while (a2 >= a1 - 1e-12) a2 -= 2 * Math.PI; sweep = a2 - a1; while (sweep < -2 * Math.PI - 1e-9) sweep += 2 * Math.PI; }
      const pts = this.conicPts(c, a1, sweep);
      if (!useParam(t1) && t1.pt) pts[0] = t1.pt;
      if (!useParam(t2) && t2.pt) pts[pts.length - 1] = t2.pt;
      return { pts, closed: false };
    }
    if (bt === 'IFCLINE') {
      const la = this.A(basis);
      const p = this.P(la[0]);
      const va = this.A(this.rid(la[1]));
      const d = this.D(va[0], [1, 0, 0])!;
      const mlen = num(va[1], 1);
      const at = (t: { par: number | null; pt: number[] | null }) => (useParam(t) ? [p[0] + d[0] * mlen * t.par!, p[1] + d[1] * mlen * t.par!, p[2] + d[2] * mlen * t.par!] : t.pt || p);
      return { pts: [at(t1), at(t2)], closed: false };
    }
    const c = this.curve(basis, depth + 1);
    if (!c) return null;
    if (bt === 'IFCPOLYLINE' && (useParam(t1) || useParam(t2))) {
      const P = c.pts;
      const at = (t: { par: number | null; pt: number[] | null }) => {
        if (!useParam(t)) return t.pt!;
        const s = Math.max(0, Math.min(P.length - 1, t.par!));
        const k = Math.min(P.length - 2, Math.floor(s)), f = s - k;
        return [P[k][0] + (P[k + 1][0] - P[k][0]) * f, P[k][1] + (P[k + 1][1] - P[k][1]) * f, P[k][2] + (P[k + 1][2] - P[k][2]) * f];
      };
      const s1 = useParam(t1) ? t1.par! : 0, s2 = useParam(t2) ? t2.par! : P.length - 1;
      const out = [at(t1)];
      if (s1 <= s2) for (let k = Math.ceil(s1 + 1e-9); k < s2; k++) out.push(P[k]);
      else for (let k = Math.floor(s1 - 1e-9); k > s2; k--) out.push(P[k]);
      out.push(at(t2));
      return { pts: out, closed: false };
    }
    // other bases: cut by nearest points
    if (t1.pt && t2.pt && c.pts.length > 1) {
      const near = (q: number[]) => { let bi = 0, bd = Infinity; c.pts.forEach((p, i) => { const d = G.len3(G.sub3(p, q)); if (d < bd) { bd = d; bi = i; } }); return bi; };
      let i1 = near(t1.pt), i2 = near(t2.pt);
      let seg = i1 <= i2 ? c.pts.slice(i1, i2 + 1) : c.pts.slice(i2, i1 + 1).reverse();
      if (!sense && i1 < i2) { seg = c.pts.slice(i1, i2 + 1); }
      void i1; void i2;
      return { pts: [t1.pt, ...seg.slice(1, -1), t2.pt], closed: false };
    }
    return { pts: c.pts, closed: false };
  }
  bspline(a: Arg[], rational: boolean): number[][] {
    const deg = num(a[0]);
    const cps = refs(a[1]).map((p) => this.P(new Ref(p)));
    const mult = list(a[5]).map((x) => num(x));
    const kn = list(a[6]).map((x) => num(x));
    const w = rational ? list(a[8]).map((x) => num(x, 1)) : null;
    const knots: number[] = [];
    kn.forEach((k, i) => { for (let j = 0; j < (mult[i] || 1); j++) knots.push(k); });
    const n = cps.length;
    if (n < 2 || knots.length !== n + deg + 1) return cps;
    const t0 = knots[deg], t1 = knots[n];
    const steps = Math.max(8, Math.min(200, n * 6));
    const out: number[][] = [];
    for (let s = 0; s <= steps; s++) {
      const t = t0 + ((t1 - t0) * s) / steps;
      out.push(deBoor(deg, cps, knots, w, t));
    }
    return out;
  }

  // ------------------------------------------------------------------ profiles
  profile(id: number, depth = 0): Profile[] {
    if (!id || depth > 10) return [];
    const t = this.T(id), a = this.A(id);
    const pos = (v: Arg) => (v instanceof Ref ? this.axis(v) : null);
    const finish = (loops: Loop2[], m: M | null): Profile[] => {
      if (!loops.length) return [];
      const tl = loops.map((L) => {
        if (!m) return L;
        const o: number[] = [];
        for (let i = 0; i < L.length; i += 2) o.push(m[0] * L[i] + m[1] * L[i + 1] + m[3], m[4] * L[i] + m[5] * L[i + 1] + m[7]);
        return o;
      });
      return [{ outer: tl[0], holes: tl.slice(1) }];
    };
    const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];
    switch (t) {
      case 'IFCRECTANGLEPROFILEDEF': { const x = num(a[3]) / 2, y = num(a[4]) / 2; return finish([rect(-x, -y, x, y)], pos(a[2])); }
      case 'IFCROUNDEDRECTANGLEPROFILEDEF': {
        const x = num(a[3]) / 2, y = num(a[4]) / 2, r = Math.min(num(a[5]), x, y);
        if (!(r > 0)) return finish([rect(-x, -y, x, y)], pos(a[2]));
        const L: number[] = [];
        const n = Math.max(2, this.segs(r, Math.PI / 2));
        const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= n; i++) { const t = a0 + (Math.PI / 2) * (i / n); L.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); } };
        corner(x - r, -y + r, -Math.PI / 2); corner(x - r, y - r, 0); corner(-x + r, y - r, Math.PI / 2); corner(-x + r, -y + r, Math.PI);
        return finish([L], pos(a[2]));
      }
      case 'IFCRECTANGLEHOLLOWPROFILEDEF': {
        const x = num(a[3]) / 2, y = num(a[4]) / 2, w = num(a[5]);
        const loops = [rect(-x, -y, x, y)];
        if (w > 0 && w < x && w < y) loops.push(G.reverseLoop(rect(-x + w, -y + w, x - w, y - w)));
        return finish(loops, pos(a[2]));
      }
      case 'IFCCIRCLEPROFILEDEF': { const r = num(a[3]); return finish([G.circleLoop(r, this.segs(r, 2 * Math.PI))], pos(a[2])); }
      case 'IFCCIRCLEHOLLOWPROFILEDEF': {
        const r = num(a[3]), w = num(a[4]);
        const n = this.segs(r, 2 * Math.PI);
        const loops = [G.circleLoop(r, n)];
        if (w > 0 && w < r) loops.push(G.reverseLoop(G.circleLoop(r - w, n)));
        return finish(loops, pos(a[2]));
      }
      case 'IFCELLIPSEPROFILEDEF': {
        const rx = num(a[3]), ry = num(a[4]);
        const n = this.segs(Math.max(rx, ry), 2 * Math.PI);
        const L: number[] = [];
        for (let i = 0; i < n; i++) { const th = (2 * Math.PI * i) / n; L.push(rx * Math.cos(th), ry * Math.sin(th)); }
        return finish([L], pos(a[2]));
      }
      case 'IFCISHAPEPROFILEDEF': case 'IFCASYMMETRICISHAPEPROFILEDEF': {
        let bw: number, d: number, tw: number, tfb: number, tw2: number, tft: number;
        if (t === 'IFCASYMMETRICISHAPEPROFILEDEF' && !this.schema.startsWith('IFC2X')) {
          bw = num(a[3]); d = num(a[4]); tw = num(a[5]); tfb = num(a[6]); tw2 = num(a[8], bw); tft = num(a[9], tfb);
        } else {
          bw = num(a[3]); d = num(a[4]); tw = num(a[5]); tfb = num(a[6]); tw2 = bw; tft = tfb;
          if (t === 'IFCASYMMETRICISHAPEPROFILEDEF') { tw2 = num(a[8], bw); tft = num(a[9], tfb); }
        }
        const h = d / 2, w = tw / 2, b = bw / 2, c = tw2 / 2;
        return finish([[-b, -h, b, -h, b, -h + tfb, w, -h + tfb, w, h - tft, c, h - tft, c, h, -c, h, -c, h - tft, -w, h - tft, -w, -h + tfb, -b, -h + tfb]], pos(a[2]));
      }
      case 'IFCLSHAPEPROFILEDEF': {
        const d = num(a[3]), w = a[4] == null ? d : num(a[4]), th = num(a[5]);
        const x = w / 2, y = d / 2;
        return finish([[-x, -y, x, -y, x, -y + th, -x + th, -y + th, -x + th, y, -x, y]], pos(a[2]));
      }
      case 'IFCTSHAPEPROFILEDEF': {
        const d = num(a[3]), fw = num(a[4]), tw = num(a[5]), tf = num(a[6]);
        const h = d / 2, b = fw / 2, w = tw / 2;
        return finish([[-w, -h, w, -h, w, h - tf, b, h - tf, b, h, -b, h, -b, h - tf, -w, h - tf]], pos(a[2]));
      }
      case 'IFCUSHAPEPROFILEDEF': {
        const d = num(a[3]), fw = num(a[4]), tw = num(a[5]), tf = num(a[6]);
        const h = d / 2, b = fw / 2;
        return finish([[-b, -h, b, -h, b, -h + tf, -b + tw, -h + tf, -b + tw, h - tf, b, h - tf, b, h, -b, h]], pos(a[2]));
      }
      case 'IFCCSHAPEPROFILEDEF': {
        const d = num(a[3]), w = num(a[4]), th = num(a[5]), g = num(a[6]);
        const h = d / 2, b = w / 2;
        if (!(g > th)) return finish([[-b, -h, b, -h, b, -h + th, -b + th, -h + th, -b + th, h - th, b, h - th, b, h, -b, h]], pos(a[2]));
        return finish([[-b, -h, b, -h, b, -h + g, b - th, -h + g, b - th, -h + th, -b + th, -h + th, -b + th, h - th, b - th, h - th, b - th, h - g, b, h - g, b, h, -b, h]], pos(a[2]));
      }
      case 'IFCZSHAPEPROFILEDEF': {
        const d = num(a[3]), fw = num(a[4]), tw = num(a[5]), tf = num(a[6]);
        const h = d / 2, w = tw / 2;
        return finish([[-fw + w, -h, w, -h, w, h - tf, fw - w, h - tf, fw - w, h, -w, h, -w, -h + tf, -fw + w, -h + tf]], pos(a[2]));
      }
      case 'IFCTRAPEZIUMPROFILEDEF': {
        const bx = num(a[3]), tx = num(a[4]), yd = num(a[5]), off = num(a[6]);
        return finish([[-bx / 2, -yd / 2, bx / 2, -yd / 2, -bx / 2 + off + tx, yd / 2, -bx / 2 + off, yd / 2]], pos(a[2]));
      }
      case 'IFCARBITRARYCLOSEDPROFILEDEF': case 'IFCARBITRARYPROFILEDEFWITHVOIDS': {
        const loop = (cid: number) => {
          const c = this.curve(cid);
          if (!c) return null;
          const L: number[] = [];
          for (const p of c.pts) L.push(p[0], p[1]);
          return G.cleanLoop(L, this.eps);
        };
        const outer = loop(this.rid(a[2]));
        if (!outer || outer.length < 6) return [];
        const holes: Loop2[] = [];
        if (t === 'IFCARBITRARYPROFILEDEFWITHVOIDS') for (const h of refs(a[3])) { const L = loop(h); if (L && L.length >= 6) holes.push(L); }
        return [{ outer, holes }];
      }
      case 'IFCCENTERLINEPROFILEDEF': {
        const c = this.curve(this.rid(a[2]));
        const th = num(a[3]);
        if (!c || c.pts.length < 2) return [];
        const l = offsetPolyline(c.pts, th / 2, false), r = offsetPolyline(c.pts, -th / 2, false).reverse();
        const L: number[] = [];
        for (const p of [...l, ...r]) L.push(p[0], p[1]);
        return [{ outer: L, holes: [] }];
      }
      case 'IFCCOMPOSITEPROFILEDEF': {
        const out: Profile[] = [];
        for (const p of refs(a[2])) for (const q of this.profile(p, depth + 1)) out.push(q);
        return out;
      }
      case 'IFCDERIVEDPROFILEDEF': case 'IFCMIRROREDPROFILEDEF': {
        const parent = this.profile(this.rid(a[2]), depth + 1);
        let m = this.xformOp(a[3]);
        if (t === 'IFCMIRROREDPROFILEDEF') { const mir = G.ident(); mir[0] = -1; m = G.mul(m, mir); }
        return parent.map((p) => {
          const tr = (L: Loop2) => { const o: number[] = []; for (let i = 0; i < L.length; i += 2) o.push(m[0] * L[i] + m[1] * L[i + 1] + m[3], m[4] * L[i] + m[5] * L[i + 1] + m[7]); return o; };
          return { outer: tr(p.outer), holes: p.holes.map(tr) };
        });
      }
      case 'IFCARBITRARYOPENPROFILEDEF':
        this.warn('open profile sweeps (surfaces) not supported');
        return [];
    }
    this.warn(`profile type ${t} not supported`);
    return [];
  }

  // ------------------------------------------------------------------ items
  /** representation items -> parts in item coordinates */
  item(id: number, depth = 0): Part[] {
    if (!id || depth > 40) return [];
    const t = this.T(id), a = this.A(id);
    let parts: Part[] = [];
    let m: Mesh | null = null;
    switch (t) {
      case 'IFCEXTRUDEDAREASOLID': case 'IFCEXTRUDEDAREASOLIDTAPERED': {
        const profs = this.profile(this.rid(a[0]));
        if (!profs.length) break;
        const dir = this.D(a[2], [0, 0, 1])!;
        const depthV = num(a[3]);
        m = G.extrude(profs, dir, depthV);
        if (t === 'IFCEXTRUDEDAREASOLIDTAPERED') {
          const end = this.profile(this.rid(a[4]));
          taperTop(m, profs, end, dir, depthV);
        }
        G.orientOutward(m);
        G.transformPos(this.axis(a[1]), m.pos);
        break;
      }
      case 'IFCREVOLVEDAREASOLID': case 'IFCREVOLVEDAREASOLIDTAPERED': {
        const profs = this.profile(this.rid(a[0]));
        if (!profs.length) break;
        const ax = this.A(this.rid(a[2]));
        const o = this.P(ax[0]), d = this.D(ax[1], [0, 0, 1])!;
        const ang = num(a[3]) * this.angScale;
        let r = 0;
        for (const p of profs) for (let i = 0; i < p.outer.length; i += 2) r = Math.max(r, Math.hypot(p.outer[i] - o[0], p.outer[i + 1] - o[1]));
        m = G.revolve(profs, o, d, ang, this.segs(r, ang));
        G.transformPos(this.axis(a[1]), m.pos);
        break;
      }
      case 'IFCSWEPTDISKSOLID': case 'IFCSWEPTDISKSOLIDPOLYGONAL': {
        const c = this.curve(this.rid(a[0]));
        if (!c || c.pts.length < 2) break;
        const r = num(a[1]), ri = a[2] != null ? num(a[2]) : 0;
        const n = Math.max(6, this.segs(r, 2 * Math.PI));
        const pr: Profile = { outer: G.circleLoop(r, n), holes: ri > 0 && ri < r ? [G.reverseLoop(G.circleLoop(ri, n))] : [] };
        const path = c.closed ? [...c.pts, c.pts[0]] : c.pts;
        m = G.sweep([pr], dedupePath(path, this.eps), null);
        break;
      }
      case 'IFCSURFACECURVESWEPTAREASOLID': case 'IFCFIXEDREFERENCESWEPTAREASOLID': case 'IFCDIRECTRIXCURVESWEPTAREASOLID': {
        const profs = this.profile(this.rid(a[0]));
        const c = this.curve(this.rid(a[2]));
        if (!profs.length || !c || c.pts.length < 2) { if (c === null) this.warn(`${ifcClassName(t)} directrix not supported`); break; }
        const ref = t === 'IFCFIXEDREFERENCESWEPTAREASOLID' ? this.D(a[5], [1, 0, 0]) : null;
        const path = dedupePath(c.closed ? [...c.pts, c.pts[0]] : c.pts, this.eps);
        if (ref) m = G.sweep(profs, path, ref);
        else {
          // profile y axis follows the reference surface normal; for horizontal directrix use +Z
          m = sweepUp(profs, path);
        }
        G.transformPos(this.axis(a[1]), m.pos);
        break;
      }
      case 'IFCFACETEDBREP': case 'IFCFACETEDBREPWITHVOIDS': case 'IFCADVANCEDBREP': case 'IFCADVANCEDBREPWITHVOIDS': {
        m = G.emptyMesh();
        const vmap = new Map<number, number>();
        this.shellFaces(this.rid(a[0]), m, vmap);
        if (t.endsWith('WITHVOIDS')) for (const v of refs(a[1])) this.shellFaces(v, m, vmap);
        break;
      }
      case 'IFCCLOSEDSHELL': case 'IFCOPENSHELL': case 'IFCCONNECTEDFACESET': {
        m = G.emptyMesh();
        this.shellFaces(id, m, new Map());
        break;
      }
      case 'IFCSHELLBASEDSURFACEMODEL': case 'IFCFACEBASEDSURFACEMODEL': {
        m = G.emptyMesh();
        const vmap = new Map<number, number>();
        for (const s of refs(a[0])) this.shellFaces(s, m, vmap);
        break;
      }
      case 'IFCTRIANGULATEDFACESET': case 'IFCTRIANGULATEDIRREGULARNETWORK': case 'IFCPOLYGONALFACESET': {
        parts = this.faceSet(id, t, a);
        break;
      }
      case 'IFCBOOLEANRESULT': case 'IFCBOOLEANCLIPPINGRESULT': {
        this.boolNest++;
        try { m = this.boolean(id, a, depth); } finally { this.boolNest--; }
        if (m && this.boolNest === 0 && m.idx.length) m = fixTJunctions(m, this.eps * 10);
        const st = this.itemStyle.get(id) || this.firstStyle(this.rid(a[1]), depth);
        if (m && m.idx.length) parts = [{ m, st }];
        m = null;
        break;
      }
      case 'IFCCSGSOLID': parts = this.item(this.rid(a[0]), depth + 1); break;
      case 'IFCBLOCK': {
        m = G.boxMesh(0, 0, 0, num(a[1]), num(a[2]), num(a[3]));
        G.transformPos(this.axis(a[0]), m.pos);
        break;
      }
      case 'IFCRECTANGULARPYRAMID': {
        const x = num(a[1]), y = num(a[2]), h = num(a[3]);
        m = { pos: [0, 0, 0, x, 0, 0, x, y, 0, 0, y, 0, x / 2, y / 2, h], idx: [0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4] };
        G.orientOutward(m);
        G.transformPos(this.axis(a[0]), m.pos);
        break;
      }
      case 'IFCRIGHTCIRCULARCYLINDER': {
        const h = num(a[1]), r = num(a[2]);
        m = G.coneMesh(r, r, h, this.segs(r, 2 * Math.PI));
        G.transformPos(this.axis(a[0]), m.pos);
        break;
      }
      case 'IFCRIGHTCIRCULARCONE': {
        const h = num(a[1]), r = num(a[2]);
        m = G.coneMesh(r, 0, h, this.segs(r, 2 * Math.PI));
        G.transformPos(this.axis(a[0]), m.pos);
        break;
      }
      case 'IFCSPHERE': {
        const r = num(a[1]);
        m = G.sphereMesh(r, Math.max(8, this.segs(r, 2 * Math.PI)));
        G.transformPos(this.axis(a[0]), m.pos);
        break;
      }
      case 'IFCMAPPEDITEM': {
        const src = this.rid(a[0]);
        let base = this.mapCache.get(src);
        if (!base) {
          const ma = this.A(src);
          const origin = this.axis(ma[0]);
          base = this.repItems(this.rid(ma[1]), depth + 1);
          if (!G.isIdent(origin)) base = base.map((p) => { const q = { m: { pos: p.m.pos.slice(), idx: p.m.idx }, st: p.st }; G.transformPos(origin, q.m.pos); return q; });
          this.mapCache.set(src, base);
        }
        const tm = this.xformOp(a[1]);
        const own = this.itemStyle.get(id) || null;
        const flip = G.det3(tm) < 0;
        parts = base.map((p) => {
          const pos = p.m.pos.slice();
          G.transformPos(tm, pos);
          let idx = p.m.idx;
          if (flip) { idx = idx.slice(); for (let i = 0; i < idx.length; i += 3) { const x = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = x; } }
          return { m: { pos, idx }, st: p.st || own };
        });
        return parts;
      }
      case 'IFCHALFSPACESOLID': case 'IFCPOLYGONALBOUNDEDHALFSPACE': case 'IFCBOXEDHALFSPACE':
        this.warn('stand-alone half space item ignored');
        break;
      case 'IFCPOLYLINE': case 'IFCCOMPOSITECURVE': case 'IFCTRIMMEDCURVE': case 'IFCGEOMETRICCURVESET': case 'IFCGEOMETRICSET': case 'IFCINDEXEDPOLYCURVE':
      case 'IFCCARTESIANPOINT': case 'IFCTEXTLITERAL': case 'IFCTEXTLITERALWITHEXTENT': case 'IFCANNOTATIONFILLAREA': case 'IFCLINE': case 'IFCCIRCLE':
      case 'IFCBOUNDINGBOX': case 'IFCCURVEBOUNDEDPLANE': case 'IFCPLANE': case 'IFCAXIS2PLACEMENT3D': case 'IFCSTYLEDITEM': case 'IFCGRADIENTCURVE': case 'IFCSEGMENTEDREFERENCECURVE':
        break; // not body geometry
      case 'IFCFACESURFACE': case 'IFCADVANCEDFACE': case 'IFCFACE': {
        m = G.emptyMesh();
        this.faces([id], m, new Map());
        break;
      }
      case '':
        this.warn('reference to a missing entity (truncated or broken file)');
        break;
      default:
        this.warn(`geometry item ${ifcClassName(t)} not supported`);
    }
    if (m && m.idx.length) parts.push({ m, st: null });
    const own = this.itemStyle.get(id) || this.layerStyle.get(id) || null;
    if (own) for (const p of parts) if (!p.st) p.st = own;
    return parts;
  }
  firstStyle(id: number, depth: number): Style | null {
    if (!id || depth > 40) return null;
    const s = this.itemStyle.get(id);
    if (s) return s;
    const t = this.T(id);
    if (t === 'IFCBOOLEANRESULT' || t === 'IFCBOOLEANCLIPPINGRESULT') return this.firstStyle(this.rid(this.A(id)[1]), depth + 1);
    if (t === 'IFCCSGSOLID') return this.firstStyle(this.rid(this.A(id)[0]), depth + 1);
    return null;
  }
  repItems(rep: number, depth = 0): Part[] {
    const out: Part[] = [];
    const a = this.A(rep);
    const repStyle = this.layerStyle.get(rep) || null;
    for (const it of refs(a[3])) {
      let ps: Part[];
      try { ps = this.item(it, depth + 1); }
      catch (e) { this.warn(`geometry item failed: ${(e as Error).message}`); continue; }
      for (const p of ps) { if (!p.st && repStyle) p.st = repStyle; out.push(p); }
    }
    return out;
  }

  shellFaces(shell: number, m: Mesh, vmap: Map<number, number>) {
    if (!shell) return;
    const t = this.T(shell);
    if (t === 'IFCCLOSEDSHELL' || t === 'IFCOPENSHELL' || t === 'IFCCONNECTEDFACESET') this.faces(refs(this.A(shell)[0]), m, vmap);
    else if (t === 'IFCFACETEDBREP' || t === 'IFCADVANCEDBREP') this.shellFaces(this.rid(this.A(shell)[0]), m, vmap);
    else this.warn(`shell type ${t} not supported`);
  }
  /** Read a loop as point ids (for IfcPolyLoop) or as polyline points (IfcEdgeLoop) */
  loopPoints(loop: number): { ids: number[] | null; pts: number[][] } | null {
    const t = this.T(loop), a = this.A(loop);
    if (t === 'IFCPOLYLOOP') return { ids: refs(a[0]), pts: [] };
    if (t === 'IFCEDGELOOP') {
      const pts: number[][] = [];
      for (const oe of refs(a[0])) {
        const oa = this.A(oe);
        let eid = this.rid(oa[2]);
        let orient = enumv(oa[3]) !== 'F';
        if (this.T(oe) === 'IFCEDGECURVE') { eid = oe; orient = true; }
        const ea = this.A(eid);
        const s = this.P(ea[0]), e = this.P(ea[1]);
        let seg: number[][];
        const gid = this.rid(ea[2]);
        const gt = gid ? this.T(gid) : '';
        const same = enumv(ea[3]) !== 'F';
        if (this.T(eid) !== 'IFCEDGECURVE' || !gid || gt === 'IFCLINE') seg = [s, e];
        else if (gt === 'IFCCIRCLE' || gt === 'IFCELLIPSE') {
          const c = this.conic(gid)!;
          const a1 = this.conicParamOf(c, s);
          let a2 = this.conicParamOf(c, e);
          let sw: number;
          if (same) { while (a2 <= a1 + 1e-9) a2 += 2 * Math.PI; sw = a2 - a1; } else { while (a2 >= a1 - 1e-9) a2 -= 2 * Math.PI; sw = a2 - a1; }
          seg = this.conicPts(c, a1, sw);
          seg[0] = s; seg[seg.length - 1] = e;
        } else {
          const c = this.curve(gid);
          if (!c || c.pts.length < 2) seg = [s, e];
          else {
            seg = c.pts.slice();
            if (c.closed) seg.push(seg[0]);
            if (!same) seg.reverse();
            // orient so it runs from s to e
            if (G.len3(G.sub3(seg[0], s)) > G.len3(G.sub3(seg[seg.length - 1], s))) seg.reverse();
            seg[0] = s; seg[seg.length - 1] = e;
          }
        }
        if (!orient) seg.reverse();
        for (let i = 0; i < seg.length - 1; i++) {
          if (pts.length && G.len3(G.sub3(pts[pts.length - 1], seg[i])) < this.eps) continue;
          pts.push(seg[i]);
        }
      }
      return { ids: null, pts };
    }
    if (t === 'IFCVERTEXLOOP') return null;
    this.warn(`loop type ${t} not supported`);
    return null;
  }
  faces(faceIds: number[], m: Mesh, vmap: Map<number, number>) {
    const tmp = [0, 0, 0];
    for (const fid of faceIds) {
      const ft = this.T(fid);
      const fa = this.f.argsNoCache(fid) || [];
      const bounds = refs(fa[0]);
      let surf = 0, faceSame = true;
      if (ft === 'IFCADVANCEDFACE' || ft === 'IFCFACESURFACE') { surf = this.rid(fa[1]); faceSame = enumv(fa[2]) !== 'F'; }
      const loops: { idx: number[]; xyz: number[]; outer: boolean }[] = [];
      for (const bid of bounds) {
        const ba = this.f.argsNoCache(bid) || [];
        const lp = this.loopPoints(this.rid(ba[0]));
        if (!lp) continue;
        const orient = enumv(ba[1]) !== 'F';
        const idx: number[] = [], xyz: number[] = [];
        if (lp.ids) {
          let last = -1;
          for (const pid of lp.ids) {
            let vi = vmap.get(pid);
            if (vi === undefined) { this.f.point(pid, tmp); vi = m.pos.length / 3; m.pos.push(tmp[0], tmp[1], tmp[2]); vmap.set(pid, vi); }
            if (vi === last) continue;
            last = vi;
            idx.push(vi); xyz.push(m.pos[3 * vi], m.pos[3 * vi + 1], m.pos[3 * vi + 2]);
          }
          if (idx.length > 1 && idx[0] === idx[idx.length - 1]) { idx.pop(); xyz.length -= 3; }
        } else {
          for (const p of lp.pts) { const vi = m.pos.length / 3; m.pos.push(p[0], p[1], p[2]); idx.push(vi); xyz.push(p[0], p[1], p[2]); }
        }
        if (idx.length < 3) continue;
        if (!orient) { idx.reverse(); const r: number[] = []; for (let i = xyz.length - 3; i >= 0; i -= 3) r.push(xyz[i], xyz[i + 1], xyz[i + 2]); xyz.length = 0; xyz.push(...r); }
        loops.push({ idx, xyz, outer: this.T(bid) === 'IFCFACEOUTERBOUND' });
      }
      if (!loops.length) { this.skippedFaces++; continue; }
      if (surf && this.T(surf) !== 'IFCPLANE') {
        const done = this.curvedFace(surf, loops, m, faceSame);
        if (done) continue;
      }
      // the outer boundary encloses the others, so it is the largest loop (some exporters flag a hole as outer)
      let oi = loops.findIndex((l) => l.outer);
      if (oi < 0) oi = 0;
      if (loops.length > 1) { let best = -1; loops.forEach((l, i) => { const n = G.len3(G.newell(l.xyz)); if (n > best) { best = n; oi = i; } }); }
      const outer = loops[oi], holes = loops.filter((_, i) => i !== oi);
      if (!holes.length && outer.idx.length === 3) { m.idx.push(outer.idx[0], outer.idx[1], outer.idx[2]); continue; }
      // holes must wind opposite to the outer for the projection-based triangulation
      const tf = G.triangulate3DFill(outer.xyz, holes.map((h) => h.xyz));
      const tri = tf.tri;
      if (!tri.length) { this.skippedFaces++; continue; }
      const all = [...outer.idx];
      for (const h of holes) for (const v of h.idx) all.push(v);
      // even-odd fill vertices of a self-crossing face
      for (let i = 0; i < tf.extra3.length; i += 3) { all.push(m.pos.length / 3); m.pos.push(tf.extra3[i], tf.extra3[i + 1], tf.extra3[i + 2]); }
      for (let k = 0; k < tri.length; k++) m.idx.push(all[tri[k]]);
      void faceSame;
    }
  }
  /** non planar face surfaces: B-spline grid (untrimmed) or cylinder (parameter space triangulation) */
  curvedFace(surf: number, loops: { idx: number[]; xyz: number[]; outer: boolean }[], m: Mesh, same: boolean): boolean {
    const t = this.T(surf), a = this.A(surf);
    if (t === 'IFCBSPLINESURFACEWITHKNOTS' || t === 'IFCRATIONALBSPLINESURFACEWITHKNOTS') {
      const du = num(a[0]), dv = num(a[1]);
      const rows = list(a[2]).map((r) => refs(r).map((p) => this.P(new Ref(p))));
      const ku: number[] = [], kv: number[] = [];
      list(a[9]).forEach((k, i) => { for (let j = 0; j < num(list(a[7])[i], 1); j++) ku.push(num(k)); });
      list(a[10]).forEach((k, i) => { for (let j = 0; j < num(list(a[8])[i], 1); j++) kv.push(num(k)); });
      const W = t === 'IFCRATIONALBSPLINESURFACEWITHKNOTS' ? list(a[12]).map((r) => list(r).map((x) => num(x, 1))) : null;
      const nu = rows.length, nv = rows[0]?.length || 0;
      if (ku.length !== nu + du + 1 || kv.length !== nv + dv + 1) return false;
      const su = Math.max(4, Math.min(48, nu * 4)), sv = Math.max(4, Math.min(48, nv * 4));
      const base = m.pos.length / 3;
      for (let i = 0; i <= su; i++) {
        const u = ku[du] + ((ku[nu] - ku[du]) * i) / su;
        // evaluate column curves at u then along v
        const col: number[][] = [];
        const colW: number[] = [];
        for (let j = 0; j < nv; j++) {
          const cps = rows.map((r) => r[j]);
          const w = W ? W.map((r) => r[j]) : null;
          const p = deBoor(du, cps, ku, w, u, true);
          col.push([p[0], p[1], p[2]]); colW.push(p[3]);
        }
        for (let j = 0; j <= sv; j++) {
          const v = kv[dv] + ((kv[nv] - kv[dv]) * j) / sv;
          const p = deBoor(dv, col, kv, W ? colW : null, v);
          m.pos.push(p[0], p[1], p[2]);
        }
      }
      const tris: number[] = [];
      for (let i = 0; i < su; i++) for (let j = 0; j < sv; j++) {
        const p0 = base + i * (sv + 1) + j, p1 = p0 + 1, p2 = p0 + sv + 1, p3 = p2 + 1;
        tris.push(p0, p2, p3, p0, p3, p1);
      }
      // orient like the outer loop
      const n = G.newell(loops[0].xyz);
      const P = m.pos;
      let s = 0;
      for (let k = 0; k < tris.length; k += 3) {
        const A = 3 * tris[k], B = 3 * tris[k + 1], C = 3 * tris[k + 2];
        const c = G.cross3([P[B] - P[A], P[B + 1] - P[A + 1], P[B + 2] - P[A + 2]], [P[C] - P[A], P[C + 1] - P[A + 1], P[C + 2] - P[A + 2]]);
        s += G.dot3(c, n);
      }
      if ((s < 0) !== !same) for (let k = 0; k < tris.length; k += 3) { const x = tris[k + 1]; tris[k + 1] = tris[k + 2]; tris[k + 2] = x; }
      for (const v of tris) m.idx.push(v);
      this.warn('B-spline surface faces tessellated over their full parameter range (trims ignored)');
      return true;
    }
    if (t === 'IFCCYLINDRICALSURFACE' || t === 'IFCSURFACEOFREVOLUTION' || t === 'IFCCONICALSURFACE') {
      let fm: M, r: number;
      if (t === 'IFCSURFACEOFREVOLUTION') {
        const ax = this.A(this.rid(a[2]));
        fm = G.mul(this.axis(a[1]), this.frame(this.P(ax[0]), this.D(ax[1], [0, 0, 1])!, [1, 0, 0]));
        // mean radius of the boundary as the unrolling scale
        const im0 = G.inv(fm), q0 = [0, 0, 0];
        let sr = 0, n = 0;
        for (const l of loops) for (let i = 0; i < l.xyz.length; i += 3) { G.applyM(im0, [l.xyz[i], l.xyz[i + 1], l.xyz[i + 2]], q0); sr += Math.hypot(q0[0], q0[1]); n++; }
        r = n ? sr / n : 1;
      } else { fm = this.axis(a[0]); r = num(a[1]); }
      const im = G.inv(fm);
      // map loops to (r*theta, z), unwrap theta continuously
      const q = [0, 0, 0];
      const uv: Loop2[] = [];
      let th0: number | null = null;
      for (const l of loops) {
        const L: number[] = [];
        let prev: number | null = null;
        for (let i = 0; i < l.xyz.length; i += 3) {
          G.applyM(im, [l.xyz[i], l.xyz[i + 1], l.xyz[i + 2]], q);
          let th = Math.atan2(q[1], q[0]);
          if (th0 === null) th0 = th;
          if (prev !== null) { while (th - prev > Math.PI) th -= 2 * Math.PI; while (th - prev < -Math.PI) th += 2 * Math.PI; }
          prev = th;
          L.push(th * r, q[2]);
        }
        uv.push(L);
      }
      // domain in (r*theta, z): loops that wrap once around the axis (bands bounded by two circles without
      // a seam edge) are joined into one ring; the largest remaining loop is the outer one
      const P = 2 * Math.PI * r;
      const vid: number[][] = loops.map((l) => [...l.idx]);
      const ks = uv.map((L) => (L.length >= 4 ? Math.round((L[L.length - 2] - L[0]) / P) : 0));
      const wrap = ks.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
      let ringUV: number[] = [], ringId: number[] = [];
      const holeUV: number[][] = [], holeId: number[][] = [];
      if (wrap.length >= 2) {
        const [ia, ib] = wrap;
        const A = uv[ia], Aid = vid[ia];
        ringUV = [...A, A[0] + ks[ia] * P, A[1]]; ringId = [...Aid, Aid[0]];
        // B: reverse when it runs the same way, rotate to start where A ends, unwrap, shift to A's end
        let bu: number[] = [], bi: number[] = [];
        for (let i = 0; i < uv[ib].length; i += 2) { bu.push(uv[ib][i], uv[ib][i + 1]); bi.push(vid[ib][i / 2]); }
        if (Math.sign(ks[ia]) === Math.sign(ks[ib])) { const ru: number[] = [], ri: number[] = []; for (let i = bu.length - 2; i >= 0; i -= 2) { ru.push(bu[i], bu[i + 1]); ri.push(bi[i / 2]); } bu = ru; bi = ri; }
        const aEnd = ringUV[ringUV.length - 2];
        let best = 0, bd = Infinity;
        for (let i = 0; i < bu.length; i += 2) { const d = Math.abs((((bu[i] - aEnd) % P) + P * 1.5) % P - P / 2); if (d < bd) { bd = d; best = i / 2; } }
        const n = bi.length, ru: number[] = [], ri: number[] = [];
        for (let k = 0; k < n; k++) { const j = (best + k) % n; let u = bu[2 * j]; if (ru.length) u += Math.round((ru[ru.length - 2] - u) / P) * P; ru.push(u, bu[2 * j + 1]); ri.push(bi[j]); }
        const sh = Math.round((aEnd - ru[0]) / P) * P;
        for (let i = 0; i < ru.length; i += 2) ru[i] += sh;
        const kk = Math.round((ru[ru.length - 2] - ru[0]) / P);
        ru.push(ru[0] + kk * P, ru[1]); ri.push(ri[0]);
        ringUV.push(...ru); ringId.push(...ri);
        uv.forEach((L, i) => { if (i !== ia && i !== ib) { holeUV.push(L); holeId.push(vid[i]); } });
      } else {
        let oi = 0, ba = -1;
        uv.forEach((L, i) => { const x = Math.abs(G.area2(L)); if (x > ba) { ba = x; oi = i; } });
        ringUV = uv[oi]; ringId = vid[oi];
        uv.forEach((L, i) => { if (i !== oi) { holeUV.push(L); holeId.push(vid[i]); } });
      }
      // holes into the outer's angular range
      let u0 = Infinity, u1 = -Infinity;
      for (let i = 0; i < ringUV.length; i += 2) { u0 = Math.min(u0, ringUV[i]); u1 = Math.max(u1, ringUV[i]); }
      for (const H of holeUV) { let c = 0; for (let i = 0; i < H.length; i += 2) c += H[i]; c /= H.length / 2; const sh = Math.round(((u0 + u1) / 2 - c) / P) * P; if (sh) for (let i = 0; i < H.length; i += 2) H[i] += sh; }
      const tf = G.triangulateFill(ringUV, holeUV);
      const tri = tf.tri;
      if (!tri.length) return false;
      const all: number[] = [...ringId];
      for (const h of holeId) for (const v of h) all.push(v);
      for (let i = 0; i < tf.extra.length; i += 2) {
        const th = tf.extra[i] / r, p = [0, 0, 0];
        G.applyM(fm, [r * Math.cos(th), r * Math.sin(th), tf.extra[i + 1]], p);
        all.push(m.pos.length / 3); m.pos.push(p[0], p[1], p[2]);
      }
      // orientation: triangulate() gives CCW in (theta, z): normal = d/dtheta x d/dz = radial outward
      const outward = same;
      for (let k = 0; k < tri.length; k += 3) {
        if (outward) m.idx.push(all[tri[k]], all[tri[k + 1]], all[tri[k + 2]]);
        else m.idx.push(all[tri[k]], all[tri[k + 2]], all[tri[k + 1]]);
      }
      return true;
    }
    this.warn(`face surface ${ifcClassName(t)} approximated by its boundary`);
    return false;
  }
  faceSet(id: number, t: string, a: Arg[]): Part[] {
    const pl = this.f.argsNoCache(this.rid(a[0])) || [];
    const coords = list(pl[0]);
    const pos: number[] = [];
    for (const c of coords) { const l = list(c); pos.push(num(l[0]), num(l[1]), num(l[2])); }
    const nv = pos.length / 3;
    const isPoly = t === 'IFCPOLYGONALFACESET';
    const pn = list(isPoly ? a[3] : a[4]).map((x) => num(x) - 1);
    const map = (k: number) => (pn.length ? pn[k - 1] ?? -1 : k - 1);
    const idx: number[] = [];
    const faceOfTri: number[] = [];
    if (!isPoly) {
      const ci = list(a[3]);
      ci.forEach((tri, fi) => {
        const l = list(tri);
        const i0 = map(num(l[0])), i1 = map(num(l[1])), i2 = map(num(l[2]));
        if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= nv || i1 >= nv || i2 >= nv) { this.skippedFaces++; return; }
        idx.push(i0, i1, i2); faceOfTri.push(fi);
      });
    } else {
      const faces = refs(a[2]);
      faces.forEach((fid, fi) => {
        const fa = this.f.argsNoCache(fid) || [];
        const outer = list(fa[0]).map((x) => map(num(x)));
        if (outer.some((k) => k < 0 || k >= nv)) { this.skippedFaces++; return; }
        const holes = this.T(fid) === 'IFCINDEXEDPOLYGONALFACEWITHVOIDS' ? list(fa[1]).map((h) => list(h).map((x) => map(num(x)))) : [];
        const xyz = (L: number[]) => { const o: number[] = []; for (const k of L) o.push(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]); return o; };
        let tri: number[];
        const all = [...outer];
        for (const h of holes) for (const k of h) all.push(k);
        if (outer.length === 3 && !holes.length) tri = [0, 1, 2];
        else {
          const tf = G.triangulate3DFill(xyz(outer), holes.map(xyz));
          tri = tf.tri;
          for (let i = 0; i < tf.extra3.length; i += 3) { all.push(pos.length / 3); pos.push(tf.extra3[i], tf.extra3[i + 1], tf.extra3[i + 2]); }
        }
        for (let k = 0; k < tri.length; k += 3) { idx.push(all[tri[k]], all[tri[k + 1]], all[tri[k + 2]]); faceOfTri.push(fi); }
        if (!tri.length) this.skippedFaces++;
      });
    }
    // per-face colours
    const cm = this.colourMapOf.get(id);
    if (cm) {
      const ca = this.A(cm);
      const opacity = ca[1] != null ? num(ca[1], 1) : 1;
      const cl = this.A(this.rid(ca[2]));
      const cols = list(cl[0]).map((c) => list(c).map((x) => num(x)));
      const ci = list(ca[3]).map((x) => num(x) - 1);
      const groups = new Map<number, number[]>();
      for (let k = 0; k < faceOfTri.length; k++) {
        const c = ci[faceOfTri[k]] ?? -1;
        let g = groups.get(c);
        if (!g) { g = []; groups.set(c, g); }
        g.push(idx[3 * k], idx[3 * k + 1], idx[3 * k + 2]);
      }
      const out: Part[] = [];
      for (const [c, gi] of groups) {
        const col = cols[c];
        out.push({ m: { pos, idx: gi }, st: col ? mkStyle(col[0], col[1], col[2], opacity, null) : null });
      }
      return out;
    }
    return idx.length ? [{ m: { pos, idx }, st: null }] : [];
  }

  // ------------------------------------------------------------------ booleans
  solidMesh(id: number, depth: number): Mesh {
    const ps = this.item(id, depth + 1);
    if (ps.length === 1) return ps[0].m;
    const m = G.emptyMesh();
    for (const p of ps) G.appendMesh(m, p.m);
    return m;
  }
  boolean(id: number, a: Arg[], depth: number): Mesh | null {
    const op = enumv(a[0]) || 'DIFFERENCE';
    const A = this.solidMesh(this.rid(a[1]), depth);
    if (!A.idx.length) return A;
    const second = this.rid(a[2]);
    const st = this.T(second);
    const bop = op === 'UNION' ? 'union' : op === 'INTERSECTION' ? 'intersection' : 'difference';
    try {
      if (st === 'IFCHALFSPACESOLID' || st === 'IFCPOLYGONALBOUNDEDHALFSPACE' || st === 'IFCBOXEDHALFSPACE') {
        return this.halfSpaceOp(A, second, st, bop);
      }
      const B = this.solidMesh(second, depth);
      if (!B.idx.length) return bop === 'intersection' ? G.emptyMesh() : A;
      const ba = G.meshBBox(A.pos), bb = G.meshBBox(B.pos);
      const disjoint = ba[3] < bb[0] || bb[3] < ba[0] || ba[4] < bb[1] || bb[4] < ba[1] || ba[5] < bb[2] || bb[5] < ba[2];
      if (disjoint) { if (bop === 'difference') return A; if (bop === 'intersection') return G.emptyMesh(); const m = { pos: A.pos.slice(), idx: A.idx.slice() }; G.appendMesh(m, B); return m; }
      return this.csg(A, B, bop);
    } catch (e) {
      this.warn(`boolean operation failed (${(e as Error).message}): first operand shown`);
      return A;
    }
  }
  csg(A: Mesh, B: Mesh, op: 'union' | 'difference' | 'intersection'): Mesh {
    if (op === 'difference' && A.idx.length > 9000) {
      // local boolean: only triangles of A near B take part (the rest lies outside B)
      const bb = G.meshBBox(B.pos);
      const e = this.eps * 100;
      const near: number[] = [], far: number[] = [];
      const P = A.pos, I = A.idx;
      for (let t = 0; t < I.length; t += 3) {
        const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
        const out = Math.max(P[a], P[b], P[c]) < bb[0] - e || Math.min(P[a], P[b], P[c]) > bb[3] + e ||
          Math.max(P[a + 1], P[b + 1], P[c + 1]) < bb[1] - e || Math.min(P[a + 1], P[b + 1], P[c + 1]) > bb[4] + e ||
          Math.max(P[a + 2], P[b + 2], P[c + 2]) < bb[2] - e || Math.min(P[a + 2], P[b + 2], P[c + 2]) > bb[5] + e;
        (out ? far : near).push(I[t], I[t + 1], I[t + 2]);
      }
      if (!near.length) return A;
      const r = this.csgRaw({ pos: P, idx: near }, B, op);
      const m: Mesh = { pos: P.slice(), idx: far };
      G.appendMesh(m, r);
      return m;
    }
    return this.csgRaw(A, B, op);
  }
  csgRaw(A: Mesh, B: Mesh, op: 'union' | 'difference' | 'intersection'): Mesh {
    // run in coordinates centred on A to keep precision
    const bb = G.meshBBox(A.pos);
    const c = [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2];
    const sh = (m: Mesh, s: number) => { const P = m.pos.slice(); for (let i = 0; i < P.length; i += 3) { P[i] += s * c[0]; P[i + 1] += s * c[1]; P[i + 2] += s * c[2]; } return { pos: P, idx: m.idx }; };
    const tt = performance.now();
    const r = meshBoolean(sh(A, -1), sh(B, -1), op, this.eps * 10, this.budget);
    if (DEBUG) console.error('csg', op, A.idx.length / 3, B.idx.length / 3, '->', r.idx.length / 3, Math.round(performance.now() - tt) + 'ms');
    const P = r.pos;
    for (let i = 0; i < P.length; i += 3) { P[i] += c[0]; P[i + 1] += c[1]; P[i + 2] += c[2]; }
    return r;
  }
  halfSpaceOp(A: Mesh, hs: number, ht: string, op: 'union' | 'difference' | 'intersection'): Mesh {
    const a = this.A(hs);
    const pa = this.A(this.rid(a[0]));
    if (this.T(this.rid(a[0])) !== 'IFCPLANE') { this.warn('half space with non planar base surface ignored'); return A; }
    const pm = this.axis(pa[0]);
    const o = [pm[3], pm[7], pm[11]];
    let n = [pm[2], pm[6], pm[10]];
    // AgreementFlag TRUE: plane normal points away from the half space material
    if (enumv(a[1]) === 'F') n = n.map((x) => -x);
    // material of H: dot(p - o, n) < 0
    let inside = 0, outside = 0;
    const P = A.pos;
    const tol = this.eps * 10;
    for (let i = 0; i < P.length; i += 3) {
      const d = (P[i] - o[0]) * n[0] + (P[i + 1] - o[1]) * n[1] + (P[i + 2] - o[2]) * n[2];
      if (d < -tol) inside++; else if (d > tol) outside++;
    }
    if (op === 'union') return A;
    let poly: { m: M; loop: Loop2 } | null = null;
    if (ht === 'IFCPOLYGONALBOUNDEDHALFSPACE') {
      const c = this.curve(this.rid(a[3]));
      if (c && c.pts.length >= 3) {
        const L: number[] = [];
        for (const p of c.pts) L.push(p[0], p[1]);
        poly = { m: this.axis(a[2]), loop: G.cleanLoop(L, this.eps) };
      }
    }
    if (op === 'difference') {
      if (!inside) return A;            // nothing of A inside the half space
      if (!outside && !poly) return G.emptyMesh();
    } else {
      if (!outside) return A;
      if (!inside) return G.emptyMesh();
    }
    const bb = G.meshBBox(P);
    const diag = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
    const cen = [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2];
    const R = diag * 2 + G.len3(G.sub3(cen, o)) * 2 + 1;
    // plane frame with z = n
    const fr = this.frame(o, n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    let cutter = G.boxMesh(-R, -R, -R, R, R, 0);
    G.transformPos(fr, cutter.pos);
    if (poly) {
      // all vertices of A inside the boundary prism? then it behaves like a plain half space
      const im = G.inv(poly.m);
      const q = [0, 0, 0];
      let inP = 0, outP = 0;
      for (let i = 0; i < P.length; i += 3) { G.applyM(im, [P[i], P[i + 1], P[i + 2]], q); if (pointInLoop(q[0], q[1], poly.loop)) inP++; else outP++; }
      if (outP) {
        if (!inP && op === 'difference') {
          // prism may still cut through A between vertices; check bbox overlap in plane coords
          const pb = loopBBox(poly.loop);
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let i = 0; i < P.length; i += 3) { G.applyM(im, [P[i], P[i + 1], P[i + 2]], q); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
          if (x1 < pb[0] || x0 > pb[2] || y1 < pb[1] || y0 > pb[3]) return A;
        }
        const prism = G.extrude([{ outer: poly.loop, holes: [] }], [0, 0, 1], 2 * R);
        for (let i = 2; i < prism.pos.length; i += 3) prism.pos[i] -= R;
        G.orientOutward(prism);
        G.transformPos(poly.m, prism.pos);
        cutter = this.csg(prism, cutter, 'intersection');
        if (!cutter.idx.length) return op === 'difference' ? A : G.emptyMesh();
      } else if (op === 'difference' && !outside) return G.emptyMesh();
    }
    return this.csg(A, cutter, op);
  }
}

// ------------------------------------------------------------------------------------- helpers
function deBoor(p: number, cps: number[][], U: number[], w: number[] | null, t: number, homog = false): number[] {
  const n = cps.length - 1;
  let k = p;
  if (t >= U[n + 1]) k = n;
  else { while (k < n && !(t >= U[k] && t < U[k + 1])) k++; }
  const d: number[][] = [];
  for (let j = 0; j <= p; j++) {
    const c = cps[k - p + j] || cps[cps.length - 1];
    const wt = w ? (w[k - p + j] ?? 1) : 1;
    d.push([c[0] * wt, c[1] * wt, c[2] * wt, wt]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = U[i + p - r + 1] - U[i];
      const al = den > 0 ? (t - U[i]) / den : 0;
      for (let q = 0; q < 4; q++) d[j][q] = (1 - al) * d[j - 1][q] + al * d[j][q];
    }
  }
  const r = d[p];
  if (homog) return [r[0] / r[3], r[1] / r[3], r[2] / r[3], r[3]];
  return [r[0] / r[3], r[1] / r[3], r[2] / r[3]];
}

function offsetPolyline(pts: number[][], d: number, closed: boolean): number[][] {
  const n = pts.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const t0 = G.norm3(G.sub3(pts[i], prev === pts[i] ? pts[i] : prev)), t1 = G.norm3(G.sub3(next === pts[i] ? pts[i] : next, pts[i]));
    const a = i === 0 && !closed ? t1 : t0, b = i === n - 1 && !closed ? t0 : t1;
    const n0 = [-a[1], a[0]], n1 = [-b[1], b[0]];
    const m = [n0[0] + n1[0], n0[1] + n1[1]];
    const ml = Math.hypot(m[0], m[1]) || 1;
    const c = (m[0] / ml) * n0[0] + (m[1] / ml) * n0[1];
    const s = d / Math.max(0.2, c);
    out.push([pts[i][0] + (m[0] / ml) * s, pts[i][1] + (m[1] / ml) * s, pts[i][2]]);
  }
  return out;
}

function dedupePath(p: number[][], eps: number): number[][] {
  const o: number[][] = [];
  for (const q of p) if (!o.length || G.len3(G.sub3(o[o.length - 1], q)) > eps) o.push(q);
  return o;
}

function sweepUp(profs: Profile[], path: number[][]): Mesh {
  // frames with v = projected +Z (profile y up), u = v x t
  const fr = G.pathFrames(path, null);
  const ref: number[][] = [];
  for (const f of fr) {
    let v = G.sub3([0, 0, 1], f.t.map((x) => x * f.t[2]));
    if (G.len3(v) < 1e-6) v = f.v;
    v = G.norm3(v);
    ref.push(G.cross3(v, f.t));
  }
  // use the u of the first frame as fixed reference (good for planar horizontal curves)
  return G.sweep(profs, path, ref[0]);
}

function taperTop(m: Mesh, profs: Profile[], end: Profile[], dir: number[], depth: number) {
  // patch the top ring vertices when the end profile has the same structure
  if (end.length !== profs.length) return;
  const d = G.norm3(dir);
  let base = 0;
  for (let k = 0; k < profs.length; k++) {
    const a = [profs[k].outer, ...profs[k].holes.filter((l) => l.length >= 6)];
    const b = [end[k].outer, ...end[k].holes.filter((l) => l.length >= 6)];
    let nv = 0;
    for (const L of a) nv += L.length / 2;
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i].length !== b[i].length) same = false;
    if (same) {
      let o = 0;
      for (const L of b) for (let i = 0; i < L.length; i += 2, o++) {
        const vi = base + nv + o;
        m.pos[3 * vi] = L[i] + d[0] * depth; m.pos[3 * vi + 1] = L[i + 1] + d[1] * depth; m.pos[3 * vi + 2] = d[2] * depth;
      }
    }
    base += 2 * nv;
  }
}

function pointInLoop(x: number, y: number, L: Loop2): boolean {
  let inside = false;
  const n = L.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = L[2 * i], yi = L[2 * i + 1], xj = L[2 * j], yj = L[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function loopBBox(L: Loop2) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < L.length; i += 2) { x0 = Math.min(x0, L[i]); x1 = Math.max(x1, L[i]); y0 = Math.min(y0, L[i + 1]); y1 = Math.max(y1, L[i + 1]); }
  return [x0, y0, x1, y1];
}

// ------------------------------------------------------------------------------------- output buckets
class F32 { a: Float32Array; n = 0; constructor(c = 1024) { this.a = new Float32Array(c); }
  reserve(k: number) { if (this.n + k > this.a.length) { let c = this.a.length * 2; while (c < this.n + k) c *= 2; const t = new Float32Array(c); t.set(this.a.subarray(0, this.n)); this.a = t; } }
  done() { return this.a.slice(0, this.n); } }
class U32 { a: Uint32Array; n = 0; constructor(c = 1024) { this.a = new Uint32Array(c); }
  reserve(k: number) { if (this.n + k > this.a.length) { let c = this.a.length * 2; while (c < this.n + k) c *= 2; const t = new Uint32Array(c); t.set(this.a.subarray(0, this.n)); this.a = t; } }
  done() { return this.a.slice(0, this.n); } }

interface BucketAcc {
  categoryName: string; color: [number, number, number]; opacity: number;
  pos: F32; nrm: F32; idx: U32; edges: F32;
  ranges: { elementId: number; start: number; count: number }[];
}

const COS_EDGE = Math.cos((30 * Math.PI) / 180);
const COS_SMOOTH = Math.cos((40 * Math.PI) / 180);

/** weld, compute feature edges and crease-aware normals, append to bucket. P in metres (already offset). */
function emitMesh(b: BucketAcc, elementId: number, P: Float64Array, I: ArrayLike<number>, wantEdges: boolean, bbox: number[]): number {
  const nIn = P.length / 3;
  // weld by quantised position (0.01 mm)
  const q = 1e5;
  let cap = 16;
  while (cap < nIn * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Int32Array(nIn);
  const wx: number[] = [];
  const keyX = new Int32Array(nIn), keyY = new Int32Array(nIn), keyZ = new Int32Array(nIn);
  let nW = 0;
  for (let i = 0; i < nIn; i++) {
    const x = Math.round(P[3 * i] * q), y = Math.round(P[3 * i + 1] * q), z = Math.round(P[3 * i + 2] * q);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (cap - 1);
    for (;;) {
      const e = table[h];
      if (e < 0) { table[h] = nW; keyX[nW] = x; keyY[nW] = y; keyZ[nW] = z; wx.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); remap[i] = nW++; break; }
      if (keyX[e] === x && keyY[e] === y && keyZ[e] === z) { remap[i] = e; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  // triangles + face normals
  const nT0 = I.length / 3;
  const tri = new Int32Array(I.length);
  const fn = new Float64Array(I.length);
  const sliver = new Uint8Array(nT0);
  let nT = 0;
  for (let t = 0; t < nT0; t++) {
    const a = remap[I[3 * t]], c1 = remap[I[3 * t + 1]], c2 = remap[I[3 * t + 2]];
    if (a === c1 || c1 === c2 || a === c2) continue;
    const ux = wx[3 * c1] - wx[3 * a], uy = wx[3 * c1 + 1] - wx[3 * a + 1], uz = wx[3 * c1 + 2] - wx[3 * a + 2];
    const vx = wx[3 * c2] - wx[3 * a], vy = wx[3 * c2 + 1] - wx[3 * a + 1], vz = wx[3 * c2 + 2] - wx[3 * a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-14)) continue;
    nx /= l; ny /= l; nz /= l;
    const wx2 = wx[3 * c2] - wx[3 * c1], wy2 = wx[3 * c2 + 1] - wx[3 * c1 + 1], wz2 = wx[3 * c2 + 2] - wx[3 * c1 + 2];
    const me = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx2 * wx2 + wy2 * wy2 + wz2 * wz2);
    sliver[nT] = l < me * 2e-4 ? 1 : 0;
    tri[3 * nT] = a; tri[3 * nT + 1] = c1; tri[3 * nT + 2] = c2;
    fn[3 * nT] = nx; fn[3 * nT + 1] = ny; fn[3 * nT + 2] = nz;
    nT++;
  }
  if (!nT) return 0;
  // edges
  if (wantEdges) {
    const em = new Map<number, number>(); // key -> triangle index + 1 (negative when already used twice)
    const out = b.edges;
    const pushEdge = (u: number, v: number) => {
      out.reserve(6);
      out.a[out.n++] = wx[3 * u]; out.a[out.n++] = wx[3 * u + 1]; out.a[out.n++] = wx[3 * u + 2];
      out.a[out.n++] = wx[3 * v]; out.a[out.n++] = wx[3 * v + 1]; out.a[out.n++] = wx[3 * v + 2];
    };
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const u = tri[3 * t + k], v = tri[3 * t + (k + 1) % 3];
        const key = u < v ? u * nW + v : v * nW + u;
        const e = em.get(key);
        if (sliver[t]) { if (e === undefined) em.set(key, 0); else if (e > 0) em.set(key, e); continue; }
        if (e === undefined) em.set(key, t + 1);
        else if (e === 0) { /* edge shared with a sliver: ignore */ }
        else if (e > 0) {
          const s = e - 1;
          const d = fn[3 * s] * fn[3 * t] + fn[3 * s + 1] * fn[3 * t + 1] + fn[3 * s + 2] * fn[3 * t + 2];
          if (d < COS_EDGE) pushEdge(u, v);
          em.set(key, 0);
        }
      }
    }
    for (const [key, e] of em) if (e > 0) { const u = Math.floor(key / nW), v = key - u * nW; pushEdge(u, v); }
  }
  // crease-aware normals: split vertices by normal clusters
  const head = new Int32Array(nW).fill(-1);
  const outV: number[] = []; // per output vertex: welded index
  const nextS: number[] = [];
  const acc: number[] = []; // accumulated normal
  const first: number[] = []; // first face normal of cluster
  const outIdx = new Uint32Array(nT * 3);
  for (let pass = 0; pass < 2; pass++) for (let t = 0; t < nT; t++) {
    if (sliver[t] !== pass) continue;
    const nx = fn[3 * t], ny = fn[3 * t + 1], nz = fn[3 * t + 2];
    for (let k = 0; k < 3; k++) {
      const v = tri[3 * t + k];
      let s = head[v], found = -1, bestD = -2;
      while (s >= 0) {
        const d = first[3 * s] * nx + first[3 * s + 1] * ny + first[3 * s + 2] * nz;
        if (pass === 0 && d > COS_SMOOTH) { found = s; break; }
        if (pass === 1 && d > bestD) { bestD = d; found = s; }
        s = nextS[s];
      }
      if (pass === 1 && found >= 0) { outIdx[3 * t + k] = found; continue; }
      if (found < 0) {
        found = outV.length;
        outV.push(v); nextS.push(head[v]); head[v] = found;
        first.push(nx, ny, nz); acc.push(0, 0, 0);
      }
      acc[3 * found] += nx; acc[3 * found + 1] += ny; acc[3 * found + 2] += nz;
      outIdx[3 * t + k] = found;
    }
  }
  const nO = outV.length;
  const base = b.pos.n / 3;
  b.pos.reserve(nO * 3); b.nrm.reserve(nO * 3);
  for (let i = 0; i < nO; i++) {
    const v = outV[i];
    const x = wx[3 * v], y = wx[3 * v + 1], z = wx[3 * v + 2];
    b.pos.a[b.pos.n++] = x; b.pos.a[b.pos.n++] = y; b.pos.a[b.pos.n++] = z;
    if (x < bbox[0]) bbox[0] = x; if (y < bbox[1]) bbox[1] = y; if (z < bbox[2]) bbox[2] = z;
    if (x > bbox[3]) bbox[3] = x; if (y > bbox[4]) bbox[4] = y; if (z > bbox[5]) bbox[5] = z;
    let nx = acc[3 * i], ny = acc[3 * i + 1], nz = acc[3 * i + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    b.nrm.a[b.nrm.n++] = nx; b.nrm.a[b.nrm.n++] = ny; b.nrm.a[b.nrm.n++] = nz;
  }
  const start = b.idx.n;
  b.idx.reserve(nT * 3);
  for (let i = 0; i < nT * 3; i++) b.idx.a[b.idx.n++] = outIdx[i] + base;
  const last = b.ranges[b.ranges.length - 1];
  if (last && last.elementId === elementId && last.start + last.count === start) last.count += nT * 3;
  else b.ranges.push({ elementId, start, count: nT * 3 });
  return nT;
}

// ------------------------------------------------------------------------------------- main
function fmtVal(v: Arg): string {
  if (v == null) return '';
  if (v instanceof Typed) return fmtVal(v.val);
  if (v instanceof Enum) return v.v === 'T' ? 'TRUE' : v.v === 'F' ? 'FALSE' : v.v === 'U' ? 'UNKNOWN' : v.v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(fmtVal).join(', ');
  if (v instanceof Ref) return '#' + v.id;
  return String(v);
}

export async function readIfc(
  bytes: Uint8Array,
  onProgress?: (stage: string, ratio: number) => void,
  options: IfcReadOptions = {},
): Promise<IfcReadResult> {
  const t0 = performance.now();
  const opt: Required<IfcReadOptions> = {
    edges: options.edges ?? true, props: options.props ?? true, openings: options.openings ?? true,
    includeSpaces: options.includeSpaces ?? false, lod: options.lod ?? 'full', maxTriangles: options.maxTriangles ?? 20_000_000,
  };
  let container = 'ifc';
  if (isZip(bytes)) {
    onProgress?.('unzip', 0);
    const entries = zipEntries(bytes);
    const e = entries.find((x) => /\.ifc$/i.test(x.name) && !x.name.startsWith('__MACOSX'));
    if (!e) throw stepError('not-format', 'zip archive without an .ifc file');
    bytes = await zipRead(bytes, e);
    container = 'ifczip';
  }
  if (!sniffIfc(bytes)) {
    // STEP but not IFC, or not STEP at all
    const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    if (/ISO-10303-21/.test(head)) throw stepError('not-format', 'STEP file with a non IFC schema');
    throw stepError('not-format', 'not an IFC file');
  }
  onProgress?.('index', 0);
  let f: StepFile;
  try { f = new StepFile(bytes, onProgress); }
  catch (e) { if ((e as { code?: string }).code) throw e; throw stepError('corrupt', 'STEP parse failed: ' + (e as Error).message); }
  const schema = (f.header.schemas[0] || '').toUpperCase();
  const warnings: string[] = [...f.warnings];
  if (!/^IFC(2X3|4)/.test(schema)) {
    if (/^IFC(1|2X$|2X_FINAL|2X2)/.test(schema)) warnings.push(`schema ${schema} is older than IFC2X3; reading with IFC2X3 rules`);
    else warnings.push(`schema ${schema} not known; reading with IFC4 rules`);
  }
  const R = new IfcReader(f, opt);
  R.schema = schema;
  R.readUnits();
  onProgress?.('styles', 0);
  R.readStyles();

  // relations
  const containedIn = new Map<number, number>();
  const parentOf = new Map<number, number>();
  const voids = new Map<number, number[]>();
  const typeOf = new Map<number, number>();
  const psetsOf = new Map<number, number[]>();
  const matOf = new Map<number, number>();
  const relArgs = (id: number) => f.argsNoCache(id) || [];
  for (const id of f.idsOfType('IFCRELCONTAINEDINSPATIALSTRUCTURE')) { const a = relArgs(id); const s = R.rid(a[5]); for (const e of refs(a[4])) containedIn.set(e, s); }
  for (const id of f.idsOfType('IFCRELAGGREGATES', 'IFCRELNESTS')) { const a = relArgs(id); const p = R.rid(a[4]); for (const e of refs(a[5])) if (!parentOf.has(e)) parentOf.set(e, p); }
  for (const id of f.idsOfType('IFCRELVOIDSELEMENT')) { const a = relArgs(id); const h = R.rid(a[4]), o = R.rid(a[5]); if (!h || !o) continue; let l = voids.get(h); if (!l) voids.set(h, (l = [])); l.push(o); }
  for (const id of f.idsOfType('IFCRELDEFINESBYTYPE')) { const a = relArgs(id); const t = R.rid(a[5]); for (const e of refs(a[4])) typeOf.set(e, t); }
  for (const id of f.idsOfType('IFCRELASSOCIATESMATERIAL')) { const a = relArgs(id); const m = R.rid(a[5]); for (const e of refs(a[4])) matOf.set(e, m); }
  if (opt.props) for (const id of f.idsOfType('IFCRELDEFINESBYPROPERTIES')) {
    const a = relArgs(id);
    const p = R.rid(a[5]);
    for (const e of refs(a[4])) { let l = psetsOf.get(e); if (!l) psetsOf.set(e, (l = [])); l.push(p); }
  }
  // spatial structure names
  const levelCache = new Map<number, { id: number | null; name: string | null }>();
  const storeyTypes = new Set(['IFCBUILDINGSTOREY']);
  const spatialTypes = new Set(['IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCBUILDING', 'IFCSITE', 'IFCBRIDGE', 'IFCBRIDGEPART', 'IFCROAD', 'IFCROADPART', 'IFCRAILWAY', 'IFCRAILWAYPART', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCFACILITYPARTCOMMON', 'IFCMARINEFACILITY', 'IFCMARINEPART', 'IFCTUNNEL', 'IFCTUNNELPART', 'IFCEXTERNALSPATIALELEMENT']);
  const levelOf = (id: number): { id: number | null; name: string | null } => {
    const c = levelCache.get(id);
    if (c) return c;
    let cur = id, fallback: { id: number | null; name: string | null } | null = null;
    let res: { id: number | null; name: string | null } = { id: null, name: null };
    for (let k = 0; k < 30 && cur; k++) {
      const t = f.typeOf(cur);
      if (k > 0 || storeyTypes.has(t)) {
        if (storeyTypes.has(t)) { res = { id: cur, name: str(R.A(cur)[2]) || str(R.A(cur)[7]) }; break; }
        if (!fallback && spatialTypes.has(t) && t !== 'IFCSPACE' && t !== 'IFCSITE' && t !== 'IFCBUILDING') fallback = { id: cur, name: str(R.A(cur)[2]) || str(R.A(cur)[7]) };
      }
      const nxt: number = containedIn.get(cur) ?? parentOf.get(cur) ?? 0;
      cur = nxt;
    }
    if (res.id == null && fallback) res = fallback;
    levelCache.set(id, res);
    return res;
  };

  // product types: those whose instances reference an IfcProductDefinitionShape at attribute 6
  const pdsT = f.typeIndexOf('IFCPRODUCTDEFINITIONSHAPE');
  const productTypes = new Set<number>();
  if (pdsT >= 0) {
    const tried = new Map<number, number>();
    for (let k = 0; k < f.count; k++) {
      const t = f.types[k];
      if (productTypes.has(t)) continue;
      const n = tried.get(t) || 0;
      if (n > 40) continue;
      tried.set(t, n + 1);
      const nm = f.typeNames[t];
      if (!nm.startsWith('IFC') || nm.startsWith('IFCREL') || nm.endsWith('TYPE') || nm.endsWith('STYLE')) { tried.set(t, 99); continue; }
      const a = f.argsAt(k);
      if (a.length < 7 || typeof a[0] !== 'string') { if (a.length < 7) tried.set(t, 99); continue; }
      const r = a[6];
      if (r instanceof Ref && f.types[f.index(r.id)] === pdsT) productTypes.add(t);
    }
  }
  const products: number[] = [];
  for (let k = 0; k < f.count; k++) if (productTypes.has(f.types[k])) products.push(f.ids[k]);

  const buckets = new Map<string, BucketAcc>();
  const elements: GeomElement[] = [];
  const props: Record<number, Record<string, string>> = {};
  const gbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let triangles = 0, cutOk = 0, cutFail = 0, capped = false;
  let offset: number[] | null = null;
  const S = R.lenScale;
  const classCounts: Record<string, number> = {};

  const propsFor = (pid: number, a: Arg[], cls: string, lvl: { name: string | null }, typeId: number, mat: number): Record<string, string> => {
    const out: Record<string, string> = {};
    const put = (k: string, v: string | null | undefined) => { if (v != null && v !== '') out[k] = v; };
    put('GlobalId', str(a[0])); put('Class', cls); put('Name', str(a[2])); put('Description', str(a[3])); put('ObjectType', str(a[4]));
    if (a.length > 7 && typeof a[7] === 'string') put('Tag', a[7]);
    const last = a[a.length - 1];
    if (last instanceof Enum && last.v !== 'NOTDEFINED') put('PredefinedType', last.v);
    if (typeId) put('Type', str(R.A(typeId)[2]));
    put('Storey', lvl.name);
    if (mat) { const ns: string[] = []; R.materialNames(mat, ns); put('Material', ns.join('; ')); }
    const rep = R.rid(a[6]);
    if (rep) for (const r of refs(R.A(rep)[2])) { const l = R.layerOf.get(r); if (l) { put('Layer', l); break; } }
    const addSet = (ps: number) => {
      const t = f.typeOf(ps), pa = R.A(ps);
      const setName = str(pa[2]) || ifcClassName(t);
      if (t === 'IFCPROPERTYSET') for (const p of refs(pa[4])) addProp(setName, p, 0);
      else if (t === 'IFCELEMENTQUANTITY') for (const q of refs(pa[5])) {
        const qa = R.A(q);
        const qn = str(qa[0]);
        if (!qn) continue;
        if (f.typeOf(q) === 'IFCPHYSICALCOMPLEXQUANTITY') continue;
        put(`${setName}.${qn}`, fmtVal(qa[3]));
      }
    };
    const addProp = (setName: string, p: number, depth: number) => {
      if (depth > 3) return;
      const t = f.typeOf(p), pa = R.A(p);
      const pn = str(pa[0]);
      if (!pn) return;
      const key = `${setName}.${pn}`;
      switch (t) {
        case 'IFCPROPERTYSINGLEVALUE': put(key, fmtVal(pa[2])); break;
        case 'IFCPROPERTYENUMERATEDVALUE': case 'IFCPROPERTYLISTVALUE': put(key, fmtVal(pa[2])); break;
        case 'IFCPROPERTYBOUNDEDVALUE': { const lo = fmtVal(pa[3]), hi = fmtVal(pa[2]); put(key, lo && hi ? `${lo} .. ${hi}` : lo || hi); break; }
        case 'IFCPROPERTYTABLEVALUE': break;
        case 'IFCPROPERTYREFERENCEVALUE': put(key, str(pa[2]) || ''); break;
        case 'IFCCOMPLEXPROPERTY': for (const q of refs(pa[3])) addProp(key, q, depth + 1); break;
      }
    };
    if (typeId) for (const ps of refs(R.A(typeId)[5])) addSet(ps);
    for (const ps of psetsOf.get(pid) || []) addSet(ps);
    return out;
  };

  const productParts = (pid: number, a: Arg[]): Part[] => {
    const shape = R.rid(a[6]);
    if (!shape) return [];
    const reps = refs(R.A(shape)[2]);
    const body: number[] = [], other: number[] = [];
    for (const r of reps) {
      const rt = f.typeOf(r);
      if (!rt.startsWith('IFCSHAPEREPRESENTATION') && rt !== 'IFCTOPOLOGYREPRESENTATION') continue;
      const ra = R.A(r);
      const ident = (str(ra[1]) || '').toLowerCase(), rtype = (str(ra[2]) || '').toLowerCase();
      if (BODY_IDS.has(ident)) body.push(r);
      else if (!NON_BODY_IDS.has(ident) && (SOLID_REP_TYPES.has(rtype) || !rtype)) other.push(r);
    }
    let parts: Part[] = [];
    for (const r of [...body, ...other]) { parts = R.repItems(r); if (parts.length) break; }
    if (!parts.length) return [];
    const m = a[5] instanceof Ref ? R.placement(a[5].id) : G.ident();
    const flip = G.det3(m) < 0;
    for (const p of parts) {
      const pos = p.m.pos.slice();
      G.transformPos(m, pos);
      let idx = p.m.idx;
      if (flip) { idx = idx.slice(); for (let i = 0; i < idx.length; i += 3) { const x = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = x; } }
      p.m = { pos, idx };
    }
    return parts;
  };

  onProgress?.('geometry', 0);
  const nP = products.length;
  let lastYield = performance.now();
  for (let pi = 0; pi < nP; pi++) {
    const pid = products[pi];
    const tname = f.typeOf(pid);
    if (SKIP_CLASSES.has(tname)) continue;
    if (tname === 'IFCSPACE' && !opt.includeSpaces) continue;
    if (performance.now() - lastYield > 200) { onProgress?.('geometry', pi / nP); lastYield = performance.now(); await Promise.resolve(); }
    if (triangles > opt.maxTriangles) { capped = true; break; }
    const a = R.A(pid);
    if (DEBUG) console.error('product', pid, tname, Math.round(performance.now() - t0));
    let parts: Part[];
    R.budget = { ops: 0 };
    try { parts = productParts(pid, a); }
    catch (e) { R.warn(`element geometry failed: ${(e as Error).message}`); continue; }
    if (!parts.length) continue;
    const cls = ifcClassName(tname);
    const typeId = typeOf.get(pid) || 0;
    const mat = matOf.get(pid) || (typeId ? matOf.get(typeId) || 0 : 0);
    let elemStyle: Style | null = mat ? R.materialStyle(mat) : null;
    if (!elemStyle && typeId) { const tm = matOf.get(typeId); if (tm) elemStyle = R.materialStyle(tm); }
    // openings
    const vs = opt.openings ? voids.get(pid) : undefined;
    if (vs && vs.length) {
      const cutters: Mesh[] = [];
      for (const o of vs) {
        try {
          const op = productParts(o, R.A(o));
          const cm = G.emptyMesh();
          for (const p of op) G.appendMesh(cm, p.m);
          if (cm.idx.length) { G.orientOutward(cm); cutters.push(cm); }
        } catch { /* ignore */ }
      }
      if (cutters.length) {
        for (const p of parts) {
          const hb = G.meshBBox(p.m.pos);
          let cur = p.m;
          for (const c of cutters) {
            const cb = G.meshBBox(c.pos);
            if (cb[3] < hb[0] || hb[3] < cb[0] || cb[4] < hb[1] || hb[4] < cb[1] || cb[5] < hb[2] || hb[5] < cb[2]) continue;
            if (cur.idx.length > 600000) { cutFail++; if (DEBUG) console.error('cut skip big', pid, cur.idx.length / 3); continue; }
            try { const r = R.csg(cur, c, 'difference'); cur = r; cutOk++; }
            catch (e) { cutFail++; if (DEBUG) console.error('cut fail', pid, (e as Error).message, cur.idx.length / 3, c.idx.length / 3); }
          }
          if (cur !== p.m) p.m = fixTJunctions(cur, R.eps * 10);
        }
      }
    }
    const lvl = levelOf(pid);
    const ebox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let et = 0;
    for (const p of parts) {
      if (!p.m.idx.length) continue;
      const st = p.st || elemStyle;
      const dc = defaultColour(cls);
      const col: [number, number, number] = st ? [st.r, st.g, st.b] : [dc[0], dc[1], dc[2]];
      const alpha = st ? st.a : dc[3];
      const key = `${cls}|${col.join(',')}|${alpha}`;
      let b = buckets.get(key);
      if (!b) { b = { categoryName: cls, color: col, opacity: alpha, pos: new F32(), nrm: new F32(), idx: new U32(), edges: new F32(), ranges: [] }; buckets.set(key, b); }
      const src = p.m.pos;
      if (!offset) {
        const x = src[0] * S, y = src[1] * S, z = src[2] * S;
        offset = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1e4 ? [Math.round(x / 1000) * 1000, Math.round(y / 1000) * 1000, Math.round(z / 1000) * 1000] : [0, 0, 0];
      }
      const P = new Float64Array(src.length);
      for (let i = 0; i < src.length; i += 3) { P[i] = src[i] * S - offset[0]; P[i + 1] = src[i + 1] * S - offset[1]; P[i + 2] = src[i + 2] * S - offset[2]; }
      et += emitMesh(b, pid, P, p.m.idx, opt.edges, ebox);
    }
    if (!et) continue;
    triangles += et;
    classCounts[cls] = (classCounts[cls] || 0) + 1;
    for (let k = 0; k < 3; k++) { gbox[k] = Math.min(gbox[k], ebox[k]); gbox[k + 3] = Math.max(gbox[k + 3], ebox[k + 3]); }
    const objType = str(a[4]);
    const typeName = typeId ? str(R.A(typeId)[2]) : null;
    elements.push({
      id: pid, category: null, categoryName: cls, className: cls,
      name: str(a[2]) || str(a[0]), typeName: objType || typeName, familyName: typeName && objType && typeName !== objType ? typeName : null,
      levelId: lvl.id, levelName: lvl.name,
      bbox: { min: [ebox[0], ebox[1], ebox[2]], max: [ebox[3], ebox[4], ebox[5]] },
    });
    if (opt.props) props[pid] = propsFor(pid, a, cls, lvl, typeId, mat);
    if (R.mapCache.size > 20000) R.mapCache.clear();
  }
  onProgress?.('geometry', 1);

  const outBuckets: GeomBucket[] = [];
  const outEdges: Array<{ category: number | null; categoryName?: string | null; positions: Float32Array }> = [];
  const sorted = [...buckets.values()].sort((x, y) => x.categoryName.localeCompare(y.categoryName));
  for (const b of sorted) {
    if (!b.idx.n) continue;
    const gb: GeomBucket = { category: null, categoryName: b.categoryName, color: b.color, positions: b.pos.done(), normals: b.nrm.done(), indices: b.idx.done(), ranges: b.ranges };
    if (b.opacity < 1) gb.opacity = b.opacity;
    outBuckets.push(gb);
    outEdges.push({ category: null, categoryName: b.categoryName, positions: b.edges.done() });
  }
  if (cutFail) R.warn(`${cutFail} opening cuts skipped (mesh too complex or boolean failed)`);
  if (capped) warnings.push(`triangle limit ${opt.maxTriangles} reached: remaining elements skipped`);
  for (const [m, n] of R.warnCounts) warnings.push(n > 1 ? `${m} (x${n})` : m);
  if (!elements.length) warnings.push('no displayable 3D geometry found');
  const bbox: BBox3 = isFinite(gbox[0]) ? { min: [gbox[0], gbox[1], gbox[2]], max: [gbox[3], gbox[4], gbox[5]] } : { min: [0, 0, 0], max: [0, 0, 0] };
  const ms = Math.round(performance.now() - t0);
  const geometry: IfcGeometry = {
    units: 'm', up: 'z', bbox, buckets: outBuckets, edges: opt.edges ? outEdges : undefined, elements,
    stats: { elements: elements.length, triangles, skippedFaces: R.skippedFaces, ms }, warnings,
  };
  if (opt.props) geometry.props = props;

  // info
  const h = f.header;
  const info: Record<string, string | number> = {
    format: container === 'ifczip' ? 'IFC (zip)' : 'IFC', schema, entities: f.count,
    lengthUnit: R.lenUnitName, lengthScaleToMetre: S, planeAngleUnit: R.angUnitName, products: products.length, elementsWithGeometry: elements.length,
    openingsCut: cutOk,
  };
  if (h.originatingSystem) info.application = h.originatingSystem;
  if (h.preprocessor) info.preprocessor = h.preprocessor;
  if (h.timeStamp) info.timeStamp = h.timeStamp;
  if (h.fileName) info.fileName = h.fileName;
  if (h.author.length) info.author = h.author.join(', ');
  if (h.organization.length) info.organization = h.organization.join(', ');
  if (h.description.length) info.description = h.description.join(' ');
  const proj = f.idsOfType('IFCPROJECT')[0];
  if (proj) { const pa = R.A(proj); const n = str(pa[2]), ln = str(pa[5]); if (n) info.projectName = n; if (ln) info.projectLongName = ln; }
  const site = f.idsOfType('IFCSITE')[0];
  if (site) { const n = str(R.A(site)[2]); if (n) info.siteName = n; }
  const bld = f.idsOfType('IFCBUILDING')[0];
  if (bld) { const n = str(R.A(bld)[2]); if (n) info.buildingName = n; }
  info.storeys = f.idsOfType('IFCBUILDINGSTOREY').length;
  const app = f.idsOfType('IFCAPPLICATION')[0];
  if (app) { const aa = R.A(app); const n = [str(aa[2]), str(aa[1])].filter(Boolean).join(' '); if (n) info.authoringTool = n; }
  if (offset && (offset[0] || offset[1] || offset[2])) { info.originOffset = offset.join(','); warnings.push(`coordinates shifted by -(${offset.join(', ')}) m to keep float precision (info.originOffset)`); }
  info.classes = Object.entries(classCounts).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  info.ms = ms;
  void enc;
  return { kind: '3d', geometry, info };
}
