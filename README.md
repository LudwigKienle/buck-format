# .buck: a look file that knows about space

A `.cube` LUT maps one color to another. It has no idea *where* a pixel is, so it cannot put haze into the background, keep the subject sharp while the distance falls off, or add warm light from the left. The tools that can (DCTL, OFX plugins, Nuke gizmos) are executable code, each tied to its own host.

`.buck` sits in between: a look is a small **declarative node graph**, color grade plus spatial effects, stored in one file without any executable content.

| Node | What it does |
|---|---|
| `color.look`, `color.cdl`, `color.lut3d`, `color.convert` | Color grade, ASC CDL, embedded 3D LUT, explicit color-space conversion |
| `light.relight` | Light from a direction, color (Kelvin) and softness, via surface normals, optional skin protection |
| `light.practicals` | Existing lamps light up (glow and light on their surroundings) or change color; manual light points |
| `sky.replace` | New sky from the depth mask: night, starry sky, moonrise, blue/golden hour, overcast, storm, sandstorm, aurora, neon night … or an embedded PNG |
| `atmos.fog` | Depth-based haze and atmosphere |
| `lens.dof` | Depth of field with focus, aperture and polygonal bokeh |
| `lens.vignette`, `film.grain`, `film.halation` | Vignette, deterministic film grain, halation and bloom |
| `mask.*` | Depth range, gradient, luma, image and combined masks |

The editor orders nodes in four levels (light → atmosphere → optics → grade), has a time-of-day switch ("Nacht" also replaces the sky and darkens the scene), understands looks in German or English (*"Dune-Look bei Nacht, Lampen leuchten warm, Filmkorn"*), and can derive a whole graph from **just a reference image**: color, light color, time of day and sky, haze, depth of field, light direction and lamps, each as a suggestion with a confidence level ([docs/REFERENCE_ANALYSIS.md](docs/REFERENCE_ANALYSIS.md)).

Depth comes from the host, or is estimated locally by a model pinned by its SHA-256 hash. Every `.buck` can also carry a plain `.cube` with the color part, so pipelines that have never heard of it keep working.

**Status:** specification draft 0.1 plus a reference prototype in the browser. Not a standard, not yet available as an OFX plugin for Resolve or Baselight.

## Try it

**Live editor:** https://ludwigkienle.github.io/buck-format/

Everything runs locally in your browser; images and models are never uploaded. The editor opens with a demo image and the look *"Dune-Look, Dunst im Hintergrund, warmes Licht von links"*. You can load your own image, describe a look in German or English, edit nodes, and save or open `.buck` files.

Run it locally:

```sh
npm ci
npm run dev
```

Then open the printed URL. `npm test` runs the test suite, `npm run build` creates the static site in `dist/`.

### Real depth estimation (optional)

Without a model, the editor uses a clearly labeled image heuristic as a stand-in for depth (it also detects the sky, including clouds that touch a ridge, and refines the sky edge at up to 1024 px, so sky replacement works; very fine detail such as branches against the sky still needs real depth). For real depth, download **Depth Anything V2 Small** (ONNX, Apache-2.0, about 99 MB) yourself and pick the file in the editor under *Hilfskanäle → Tiefe schätzen*:

- File: [`onnx/model.onnx`](https://huggingface.co/onnx-community/depth-anything-v2-small/blob/f7421df0cc30f121782ab050d42f0a423291dcde/onnx/model.onnx) from `onnx-community/depth-anything-v2-small`, revision `f7421df0cc30f121782ab050d42f0a423291dcde`
- SHA-256: `afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c`

The editor refuses any file whose hash does not match the pin. It runs via WebGPU when available, otherwise WebAssembly. The model handles still images only; each video frame would be estimated separately and could flicker.

## Specification

- [docs/BUCK_FORMAT.md](docs/BUCK_FORMAT.md): concept and specification (German): container, node graph, declared inputs, determinism, color management, temporal stability, security, roadmap and open questions
- [docs/schema/buck-1.0.schema.json](docs/schema/buck-1.0.schema.json): JSON Schema for `graph.json`
- [tests/fixtures/buck/fargo-fog-warm.json](tests/fixtures/buck/fargo-fog-warm.json): example graph

A `.buck` file is a ZIP with `mimetype`, `manifest.json` (SHA-256 per entry), `graph.json`, optional LUTs, thumbnails and masks. Readers reject scripts, external references, path traversal and zip bombs (spec §11).

## Code

- `src/buck/`: container, validator, color spaces, node implementations, graph renderer, depth estimation, text-to-graph, LUT baking and the editor UI
- `src/color/`: the look engine shared with Buckswood Auto LUT
- `tests/`: Vitest suite, including adversarial container and PNG tests

Known limits: rendering runs on the CPU in a worker (about 2 s per 1100 px preview, a half-resolution draft while you drag), there is no WebGPU render path yet; sky edges, lamp detection and the reference analysis are heuristic and meant as suggestions.

## Credits and license

Code: MIT, see [LICENSE](LICENSE). The demo image `public/demo-desert.jpg` was generated for this project with Higgsfield (GPT Image 2.5). Depth Anything V2 Small is © its authors, Apache-2.0, and is not included in this repository.
