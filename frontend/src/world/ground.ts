import * as THREE from 'three';
import { CITY } from '@flying-tung-tung/shared';

/**
 * Generates a tiled road/pavement texture procedurally on a canvas
 * so we don't need to ship an image file. One canvas tile represents
 * one city cell: pavement square inset inside a road border.
 */
function makeRoadTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Asphalt
  ctx.fillStyle = '#33363c';
  ctx.fillRect(0, 0, size, size);

  // Pavement square (inset for road border)
  const inset = 12;
  ctx.fillStyle = '#5b5e64';
  ctx.fillRect(inset, inset, size - inset * 2, size - inset * 2);

  // Lane markings
  ctx.strokeStyle = '#d8c87a';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, inset);
  ctx.moveTo(size / 2, size - inset);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(inset, size / 2);
  ctx.moveTo(size - inset, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function addGround(scene: THREE.Scene): { city: THREE.Mesh; outer: THREE.Mesh } {
  const cityWorld = CITY.GRID_SIZE * CITY.CELL_SIZE;

  // City pavement plane
  const tex = makeRoadTexture();
  tex.repeat.set(CITY.GRID_SIZE, CITY.GRID_SIZE);
  const cityMat = new THREE.MeshLambertMaterial({ map: tex });
  const cityGeom = new THREE.PlaneGeometry(cityWorld, cityWorld);
  const city = new THREE.Mesh(cityGeom, cityMat);
  city.rotation.x = -Math.PI / 2;
  city.position.y = 0.0;
  scene.add(city);

  // Outer green terrain plane
  const outerSize = cityWorld * 4;
  const outerMat = new THREE.MeshLambertMaterial({ color: 0x4f6b3b });
  const outerGeom = new THREE.PlaneGeometry(outerSize, outerSize);
  const outer = new THREE.Mesh(outerGeom, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.05; // just below pavement to avoid z-fighting
  scene.add(outer);

  return { city, outer };
}
