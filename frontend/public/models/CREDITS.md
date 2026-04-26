# Model credits

## Character

| File | Source | License |
|------|--------|---------|
| `character/tung-tung.glb` | Project asset (see `/assets`) | © project owners |
| `character/angelic-tung-tung.glb` | Project asset (see `/assets`) | © project owners |

## City props (CC0)

When city props are added, list them here. Suggested sources:

- **Kenney "City Kit (Commercial)"** — https://kenney.nl/assets/city-kit-commercial — CC0
- **Kenney "City Kit (Suburban)"** — https://kenney.nl/assets/city-kit-suburban — CC0
- **Quaternius "Ultimate Modular City Pack"** — https://quaternius.com — CC0

Place files into:
- `city/building_a.glb`, `city/building_b.glb`, `city/building_c.glb`
- `nature/tree.glb`

The frontend expects these exact filenames (see [`src/world/propLibrary.ts`](../../src/world/propLibrary.ts:1)). If a file is missing the city falls back to procedural cube props automatically — the game still runs, it just looks blocky.
