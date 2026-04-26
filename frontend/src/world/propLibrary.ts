import * as THREE from 'three';

import { loadGLTF } from '../utils/loaders';

export interface PropTemplate {
  id: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Local-space size — used to align bottom to ground. */
  size: THREE.Vector3;
  /** Local-space center offset (used to plant base on Y=0). */
  baseOffsetY: number;
}

export type PropLibrary = Map<string, PropTemplate>;

/**
 * URLs of GLB props to preload. These files are expected under
 * `frontend/public/models/...` and are sourced from CC0 packs
 * (see plans/06_ASSETS.md).
 *
 * If a file is missing, we fall back to a procedural cube prop so
 * the city still renders during development.
 */
export const PROP_URLS: Record<string, string> = {
  building_a: '/models/city/building_a.glb',
  building_b: '/models/city/building_b.glb',
  building_c: '/models/city/building_c.glb',
  tree: '/models/nature/tree.glb',
};

function extractFirstMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

function makeFallbackProp(id: string): PropTemplate {
  // Slightly different colors per id so dev cities still look varied.
  const hue = ((Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) * 53) % 360) / 360;
  const color = new THREE.Color().setHSL(hue, 0.35, 0.55);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshLambertMaterial({ color });
  return {
    id,
    geometry,
    material,
    size: new THREE.Vector3(1, 1, 1),
    baseOffsetY: 0.5,
  };
}

async function loadProp(id: string, url: string): Promise<PropTemplate> {
  try {
    const gltf = await loadGLTF(url);
    const mesh = extractFirstMesh(gltf.scene);
    if (!mesh) return makeFallbackProp(id);

    // Bake transforms into geometry so the prop is in local space.
    mesh.updateMatrixWorld(true);
    const geom = mesh.geometry.clone();
    geom.applyMatrix4(mesh.matrixWorld);
    geom.computeBoundingBox();
    const bbox = geom.boundingBox!;

    const size = new THREE.Vector3();
    bbox.getSize(size);
    // Translate so base sits at Y=0.
    geom.translate(-bbox.min.x - size.x / 2, -bbox.min.y, -bbox.min.z - size.z / 2);

    const matSource = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!matSource) return makeFallbackProp(id);
    const material = matSource.clone();

    return { id, geometry: geom, material, size, baseOffsetY: 0 };
  } catch {
    // No model file present yet — fall back to procedural cube.
    return makeFallbackProp(id);
  }
}

export async function preloadPropLibrary(
  onProgress?: (msg: string) => void
): Promise<PropLibrary> {
  const lib: PropLibrary = new Map();
  const entries = Object.entries(PROP_URLS);
  let i = 0;
  for (const [id, url] of entries) {
    i++;
    onProgress?.(`Loading prop ${i}/${entries.length}: ${id}`);
    const tpl = await loadProp(id, url);
    lib.set(id, tpl);
  }
  return lib;
}
