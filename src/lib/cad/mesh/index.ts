// Mesh formats entry point: sniff by bytes and dispatch.
export { readGltf, sniffGltf } from './gltf.ts';
export { readObj, sniffObj } from './obj.ts';
export { readStl, sniffStl } from './stl.ts';
export { read3ds, sniff3ds } from './tds.ts';
export { readFbx, sniffFbx } from './fbx.ts';
export { MeshError, type MeshErrorCode, type MeshResult } from './common.ts';

import { readGltf, sniffGltf } from './gltf.ts';
import { readObj, sniffObj } from './obj.ts';
import { readStl, sniffStl } from './stl.ts';
import { read3ds, sniff3ds } from './tds.ts';
import { readFbx, sniffFbx } from './fbx.ts';
import { MeshError, type MeshResult, type Progress } from './common.ts';

export type MeshFormat = 'gltf' | 'fbx' | '3ds' | 'stl' | 'obj';

/** recognise the format from the bytes (order matters: binary signatures first, the loose OBJ test last) */
export function sniffMesh(bytes: Uint8Array): MeshFormat | null {
  if (sniffGltf(bytes)) return 'gltf';
  if (sniffFbx(bytes)) return 'fbx';
  if (sniff3ds(bytes)) return '3ds';
  if (sniffStl(bytes)) return 'stl';
  if (sniffObj(bytes)) return 'obj';
  return null;
}

export async function readMesh(bytes: Uint8Array, onProgress?: Progress): Promise<MeshResult> {
  switch (sniffMesh(bytes)) {
    case 'gltf': return readGltf(bytes, onProgress);
    case 'fbx': return readFbx(bytes, onProgress);
    case '3ds': return read3ds(bytes, onProgress);
    case 'stl': return readStl(bytes, onProgress);
    case 'obj': return readObj(bytes, onProgress);
    default: throw new MeshError('not-format', 'Not a recognised mesh file (glTF, GLB, FBX, 3DS, STL, OBJ)');
  }
}
