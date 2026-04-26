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

  // Outer green terrain ring. We previously used a single huge plane sat
  // 0.05 below the pavement, but with the camera's far plane at 5000 the
  // depth-buffer precision over the city area dropped below that gap and
  // produced visible z-fighting (the "epileptic" flicker reported in QA).
  // Fix: build a rectangular ring with a city-sized hole so the two
  // surfaces never overlap, AND drop the ring 1 unit below the pavement
  // for an extra safety margin (it's never visible from above because the
  // pavement is opaque).
  const outerSize = cityWorld * 4;
  const outerHalf = outerSize / 2;
  const cityHalf = cityWorld / 2;

  const ringShape = new THREE.Shape();
  ringShape.moveTo(-outerHalf, -outerHalf);
  ringShape.lineTo(outerHalf, -outerHalf);
  ringShape.lineTo(outerHalf, outerHalf);
  ringShape.lineTo(-outerHalf, outerHalf);
  ringShape.lineTo(-outerHalf, -outerHalf);

  const hole = new THREE.Path();
  hole.moveTo(-cityHalf, -cityHalf);
  hole.lineTo(cityHalf, -cityHalf);
  hole.lineTo(cityHalf, cityHalf);
  hole.lineTo(-cityHalf, cityHalf);
  hole.lineTo(-cityHalf, -cityHalf);
  ringShape.holes.push(hole);

  const outerMat = new THREE.MeshLambertMaterial({ color: 0x4f6b3b });
  const outerGeom = new THREE.ShapeGeometry(ringShape);
  const outer = new THREE.Mesh(outerGeom, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -1.0;
  scene.add(outer);

  return { city, outer };
}
