# 06 — Assets

## What we already have

- [`assets/tung-tung.glb`](../assets/tung-tung.glb) — primary player model.
- [`assets/angelic-tung-tung.glb`](../assets/angelic-tung-tung.glb) — alt skin (e.g. turbo / power-up state).

These are committed at the **repo root** under `assets/`. The frontend will consume them via `frontend/public/models/` (copied or symlinked at install time).

## What we need to source (free)

| Need | Recommended pack | License | Notes |
|------|------------------|---------|-------|
| Buildings (skyscrapers, houses, shops) | **Kenney "City Kit (Commercial)"** + **Kenney "City Kit (Suburban)"** | CC0 | Tiny GLB/FBX, perfect low-poly look. https://kenney.nl/assets/city-kit-commercial |
| Buildings (alternative larger pack) | **Quaternius "Ultimate Modular City Pack"** | CC0 | Bigger variety, slightly higher poly. https://quaternius.com |
| Trees / parks | **Kenney "Nature Kit"** | CC0 | Tree, bush, rock low-poly props. https://kenney.nl/assets/nature-kit |
| Skybox / sun | `three/examples/jsm/objects/Sky.js` | MIT (Three.js) | Built-in, no download. |
| SFX (pew, turbo) | **Kenney Sci-Fi Sounds** or freesound.org CC0 picks | CC0 | Optional in MVP. |
| Road / ground texture | Generated in code via `<canvas>` | n/a | Avoids extra dep. |

All listed packs are **CC0** (public domain) — no attribution required, fully redistributable. We will still credit the authors in the README out of courtesy.

## Asset pipeline

1. Download chosen packs to a temporary location.
2. Trim to only the GLB files we actually use (target: ~10–15 building props + 3–5 nature props).
3. Place them under `frontend/public/models/city/` and `frontend/public/models/nature/`.
4. Run them through [`gltf-transform`](https://gltf-transform.dev/) (optional) for compression:
   ```
   npx gltf-transform optimize in.glb out.glb --texture-compress webp
   ```
5. Commit only the optimized files.

We will document exact filenames + sources in `frontend/public/models/CREDITS.md`.

## Loading strategy

`frontend/src/world/propLibrary.ts`:

```ts
const URLS = {
  building_a: '/models/city/building_a.glb',
  building_b: '/models/city/building_b.glb',
  // ...
  tree:       '/models/nature/tree.glb',
};

export async function preload(): Promise<PropLibrary> {
  const loader = new GLTFLoader();
  const entries = await Promise.all(
    Object.entries(URLS).map(async ([id, url]) => {
      const gltf = await loader.loadAsync(url);
      const mesh = extractFirstMesh(gltf.scene);
      return [id, mesh] as const;
    })
  );
  return new Map(entries);
}
```

`extractFirstMesh` walks the GLB scene, finds the first `Mesh`, and returns `{ geometry, material }`. The city generator uses these geometries inside `InstancedMesh` instances.

## Tung Tung plane setup

`frontend/src/entities/plane.ts`:

1. Load `tung-tung.glb`.
2. Compute mesh bounding box → derive **nose offset** (max Z) and **tail offset** for projectile spawn / camera anchor.
3. If the GLB has animations, play the idle clip with `AnimationMixer`.
4. Expose `setPose(pos, yaw, pitch, roll)` that applies an Euler ZYX or quaternion.
5. Optional: swap material/skin to `angelic-tung-tung.glb` while `state.player.turbo === true`.

## Scaling

The Tung Tung GLB might be ~1 unit or huge. We'll normalize:

```ts
const desiredLength = 6; // world units
const bbox = new THREE.Box3().setFromObject(scene);
const len = bbox.max.z - bbox.min.z;
scene.scale.setScalar(desiredLength / len);
```

Same normalization will be applied per-prop to keep the city visually consistent.

## Licensing footer (planned README excerpt)

```
Character models © respective authors (assets/*.glb).
City props by Kenney (kenney.nl) — CC0.
Nature props by Kenney — CC0.
Three.js MIT.
```

## Things we explicitly will NOT do

- No paid Sketchfab models.
- No Mapbox/Cesium real-world data (avoids API keys).
- No DRACO/Meshopt decoders unless file sizes warrant it (post-MVP optimization).
