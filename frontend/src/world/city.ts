import * as THREE from 'three';
import { CITY } from '@flying-tung-tung/shared';

import { mulberry32, pickWeighted } from '../utils/rng';

import type { PropLibrary } from './propLibrary';

export interface BuildingAabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  cellX: number;
  cellZ: number;
}

export interface CityResult {
  buildings: BuildingAabb[];
  /** "x,z" cell key -> indices into `buildings`. */
  cellLookup: Map<string, number[]>;
  meshes: THREE.InstancedMesh[];
}

/** Translate a world position to a cell key, or null if outside the grid. */
export function worldToCellKey(x: number, z: number): string | null {
  const half = (CITY.GRID_SIZE * CITY.CELL_SIZE) / 2;
  if (x < -half || x > half || z < -half || z > half) return null;
  const cx = Math.floor((x + half) / CITY.CELL_SIZE);
  const cz = Math.floor((z + half) / CITY.CELL_SIZE);
  return `${cx},${cz}`;
}

interface CellPlan {
  kind: 'empty' | 'park' | 'building';
  propId: string;
  height: number;
  rotation: number;
}

/**
 * Generates the city. Deterministic given the seed (CITY.SEED).
 * Buildings are rendered via one InstancedMesh per prop type for perf.
 */
export function buildCity(scene: THREE.Scene, lib: PropLibrary): CityResult {
  const rng = mulberry32(CITY.SEED);

  const buildingProps = ['building_a', 'building_b', 'building_c'].filter((id) => lib.has(id));
  const treeProp = lib.has('tree') ? 'tree' : null;

  const half = (CITY.GRID_SIZE * CITY.CELL_SIZE) / 2;

  // Center cell where the player respawns. Cells inside the safe radius are
  // force-empty so respawn always has clear air.
  const spawnCellX = Math.floor(CITY.GRID_SIZE / 2);
  const spawnCellZ = Math.floor(CITY.GRID_SIZE / 2);

  // First pass: decide what's in each cell.
  const plans: CellPlan[][] = [];
  for (let x = 0; x < CITY.GRID_SIZE; x++) {
    plans.push([]);
    for (let z = 0; z < CITY.GRID_SIZE; z++) {
      const cdx = Math.abs(x - spawnCellX);
      const cdz = Math.abs(z - spawnCellZ);
      const inSpawnPlaza = Math.max(cdx, cdz) <= CITY.SPAWN_SAFE_RADIUS_CELLS;

      const r = rng();
      let kind: CellPlan['kind'] = 'building';
      if (inSpawnPlaza) kind = 'empty';
      else if (r < CITY.EMPTY_CHANCE) kind = 'empty';
      else if (r < CITY.EMPTY_CHANCE + CITY.PARK_CHANCE) kind = 'park';

      const propId =
        kind === 'building'
          ? (pickWeighted(
              rng,
              buildingProps.length > 0
                ? buildingProps.map((id) => ({ value: id, weight: 1 }))
                : [{ value: 'building_a', weight: 1 }]
            ) ?? 'building_a')
          : kind === 'park' && treeProp
            ? treeProp
            : '';

      // Building heights:
      //  - rare super-tall: small chance, height is its own range so a few
      //    landmark towers really stand out;
      //  - otherwise gamma-curved roll keeps most buildings short with a
      //    long tail, plus a small per-cell skyscraper bonus.
      let height = 0;
      if (kind === 'building') {
        if (rng() < CITY.SUPERTALL_CHANCE) {
          height = CITY.SUPERTALL_BASE + rng() * CITY.SUPERTALL_RANGE;
        } else {
          const baseRoll = Math.pow(rng(), CITY.HEIGHT_GAMMA);
          height = CITY.HEIGHT_MIN + baseRoll * (CITY.HEIGHT_MAX - CITY.HEIGHT_MIN);
          if (rng() < CITY.SKYSCRAPER_CHANCE) height *= CITY.SKYSCRAPER_MULT;
        }
      } else if (kind === 'park') {
        height = 4 + rng() * 4;
      }

      const rotation = Math.floor(rng() * 4) * (Math.PI / 2);
      plans[x]!.push({ kind, propId, height, rotation });
    }
  }

  // Group counts per prop.
  const counts = new Map<string, number>();
  for (let x = 0; x < CITY.GRID_SIZE; x++) {
    for (let z = 0; z < CITY.GRID_SIZE; z++) {
      const p = plans[x]![z]!;
      if (p.kind !== 'empty' && p.propId) counts.set(p.propId, (counts.get(p.propId) ?? 0) + 1);
    }
  }

  // Create one InstancedMesh per prop type.
  const meshes: THREE.InstancedMesh[] = [];
  const cursors = new Map<string, number>();
  const propMeshes = new Map<string, THREE.InstancedMesh>();
  for (const [propId, count] of counts) {
    const tpl = lib.get(propId);
    if (!tpl) continue;
    const mesh = new THREE.InstancedMesh(tpl.geometry, tpl.material, count);
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);
    meshes.push(mesh);
    propMeshes.set(propId, mesh);
    cursors.set(propId, 0);
  }

  // Second pass: place instances + collect AABBs.
  const buildings: BuildingAabb[] = [];
  const cellLookup = new Map<string, number[]>();

  const tmpMatrix = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpEuler = new THREE.Euler();

  for (let x = 0; x < CITY.GRID_SIZE; x++) {
    for (let z = 0; z < CITY.GRID_SIZE; z++) {
      const p = plans[x]![z]!;
      if (p.kind === 'empty' || !p.propId) continue;

      const tpl = lib.get(p.propId);
      const mesh = propMeshes.get(p.propId);
      if (!tpl || !mesh) continue;

      // Cell center in world coords.
      const wx = -half + x * CITY.CELL_SIZE + CITY.CELL_SIZE / 2;
      const wz = -half + z * CITY.CELL_SIZE + CITY.CELL_SIZE / 2;

      // Footprint: keep prop within cell minus road border.
      const footprint = CITY.CELL_SIZE - CITY.ROAD_WIDTH;
      const footprintScaleX = footprint / Math.max(0.001, tpl.size.x);
      const footprintScaleZ = footprint / Math.max(0.001, tpl.size.z);
      const planScale = Math.min(footprintScaleX, footprintScaleZ);

      // Height scale only meaningful for buildings.
      const heightScale =
        p.kind === 'building'
          ? p.height / Math.max(0.001, tpl.size.y)
          : (p.height || 4) / Math.max(0.001, tpl.size.y);

      tmpPos.set(wx, 0, wz);
      tmpEuler.set(0, p.rotation, 0, 'YXZ');
      tmpQuat.setFromEuler(tmpEuler);
      tmpScale.set(planScale, heightScale, planScale);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);

      const cursor = cursors.get(p.propId)!;
      mesh.setMatrixAt(cursor, tmpMatrix);
      cursors.set(p.propId, cursor + 1);

      if (p.kind === 'building') {
        const halfFoot = footprint / 2;
        const aabb: BuildingAabb = {
          minX: wx - halfFoot,
          maxX: wx + halfFoot,
          minY: 0,
          maxY: tpl.size.y * heightScale,
          minZ: wz - halfFoot,
          maxZ: wz + halfFoot,
          cellX: x,
          cellZ: z,
        };
        const idx = buildings.push(aabb) - 1;
        const key = `${x},${z}`;
        const list = cellLookup.get(key);
        if (list) list.push(idx);
        else cellLookup.set(key, [idx]);
      }
    }
  }

  for (const m of meshes) {
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }

  return { buildings, cellLookup, meshes };
}
