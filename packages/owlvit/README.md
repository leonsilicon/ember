# @soon2026/owlvit

Builds the app's on-device leaf detector: [OWL-ViT](https://huggingface.co/google/owlvit-base-patch32)
(open-vocabulary detection, the model `vlm-test.py` runs on the Mac) exported as an ExecuTorch
program that react-native-executorch runs through Core ML on the phone.

```bash
bun run --filter @soon2026/owlvit build   # from anywhere in the repo
uv run export.py                          # or from this directory
```

It needs a Mac (the export and its check go through Core ML) and [uv](https://docs.astral.sh/uv/),
which installs the pinned Python and packages (`pyproject.toml`, `uv.lock`) on the first run. The
first run also downloads the checkpoint from Hugging Face (~600 MB).

The build writes to `dist/`:

- `owlvit-leaves-<hash>.pte`, about 180 MB, named after its contents.
- `owlvit-leaves.json`, the manifest: which `.pte` is current, the labels, preprocessing and
  thresholds.

Before it writes them, it runs the exported program on this Mac and checks it against
transformers' OWL-ViT on `fixtures/leaves.jpg` (or `--image`), and refuses to write a model that
drifts. `--precision fp32` keeps the model off the Neural Engine but matches transformers exactly.
fp16, the default, moves boxes by up to ~10 px (of 768) on candidates scoring a few percent.

## How the app gets it

It's embedded in the iOS app: `apps/soon2026/plugins/with-leaf-detector.js` copies `dist/` into the
app bundle whenever the app is prebuilt (`vpx _ios` prebuilds on every build), so the phone has the
model from the first launch, without the splat server. Prebuild stops with an error until the model
is built. Core ML compiles the model the first time the app loads it, which takes a while. After
rebuilding the model, rebuild the app.

## Changing what it looks for

The text queries are fixed at build time: they're embedded once and stored in the program, so the
phone runs only OWL-ViT's image tower and heads. Edit `QUERIES` in `export.py` (label → query) and
rebuild. `CONFIDENCE_THRESHOLD` and `IOU_THRESHOLD` there are the app's defaults.

## Upgrading

`executorch` must be the version of the ExecuTorch runtime that react-native-executorch ships (see
`node_modules/react-native-executorch/third-party/include/executorch/runtime/core/version.h`), or
the phone refuses the program.

`fixtures/leaves.jpg` is "Autumn leaves on the ground in Quebec City" by Wilfredor, CC0, from
Wikimedia Commons.
