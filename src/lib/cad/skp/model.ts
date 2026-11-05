// Intermediate SketchUp model, filled by both readers (VFF zip container 2021+ and the legacy object stream).
// Coordinates are SketchUp internal units: inches.

export interface SkpMaterial {
  id: number;                        // id used by the entities that reference it (file specific)
  name: string;
  color: [number, number, number];   // 0..1 sRGB
  opacity: number;                   // 0..1
  textureName?: string;              // texture file name as stored
  textureIndex?: number;             // index into SkpModel.textures when the image bytes are embedded
}

export interface SkpLayer { id: number; name: string; visible: boolean }

export interface SkpFace {
  loops: Int32Array[];               // vertex indices into SkpEntities.verts; loop 0 is the outer loop
  normal: [number, number, number];  // plane normal (front side)
  mat: number;                       // front material id, 0 = default
  back: number;                      // back material id, 0 = default
  layer: number;                     // layer id, 0 = default layer
  hidden: boolean;
}

export interface SkpInstance {
  id: number;
  def: number;                       // definition id
  xf: Float64Array;                  // 4x4 column-major, inches
  name: string;
  mat: number;
  layer: number;
  hidden: boolean;
  group: boolean;
}

export interface SkpEntities {
  verts: Float64Array;               // xyz, inches
  faces: SkpFace[];
  edges: Int32Array;                 // visible (not soft, not hidden) edges: pairs of vertex indices
  edgeLayers: Int32Array;            // layer id per visible edge
  instances: SkpInstance[];
  counts: { edges: number; softEdges: number; hiddenEdges: number; curves: number; texts: number; guides: number; dims: number; images: number };
}

export interface SkpDefinition {
  id: number;
  name: string;
  ents: SkpEntities;
}

export interface SkpModel {
  version: string;                   // e.g. "{23.1.315}"
  container: 'vff' | 'legacy';
  defs: Map<number, SkpDefinition>;
  root: SkpEntities;
  materials: Map<number, SkpMaterial>;
  layers: Map<number, SkpLayer>;
  defaultLayer: number;              // id of "Layer0" (Untagged) if known
  textures: Array<{ name: string; mime: string; bytes: Uint8Array }>;
  info: Record<string, string | number>;
  warnings: string[];
}

export function emptyEntities(): SkpEntities {
  return {
    verts: new Float64Array(0), faces: [], edges: new Int32Array(0), edgeLayers: new Int32Array(0), instances: [],
    counts: { edges: 0, softEdges: 0, hiddenEdges: 0, curves: 0, texts: 0, guides: 0, dims: 0, images: 0 },
  };
}
