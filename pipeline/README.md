# pipeline — images → Gaussian splat

One command turns a folder of photos of a scene into a `.splat` file the frontend viewer loads:

```
python3 pipeline/reconstruct.py path/to/images --splat frontend/public/splats/scene.splat
```

Stages (all CPU-capable, no CUDA needed):

1. **COLMAP** — finds camera poses + a sparse point cloud from the photos (`feature_extractor` → `exhaustive_matcher` → `mapper`).
2. **OpenSplat** — trains the Gaussian splat from the COLMAP project (Metal on Apple Silicon, CPU elsewhere).
3. Writes `scene.splat`. Open it in the web app (Scene panel → Load URL `/splats/scene.splat`, or "Open .splat").

Options: `--iters N` (default 2000; 300 is a fast smoke test, 7000+ looks good), `--downscale 2`, `--out <dir>` (project folder, default `<images>/../recon`), `--matcher sequential|exhaustive` (auto: sequential for 30+ frames in capture order — much faster for a 1 fps stream; exhaustive for small unordered sets), `--skip-colmap` to re-train with different settings.

## Install on macOS (Apple Silicon)

```
brew install colmap cmake opencv
# OpenSplat (Metal build)
git clone https://github.com/pierotofy/OpenSplat ~/OpenSplat && cd ~/OpenSplat
pip3 install torch      # or download libtorch for macOS arm64 from pytorch.org
mkdir build && cd build
cmake -DGPU_RUNTIME=MPS -DCMAKE_PREFIX_PATH=$(python3 -c 'import torch;print(torch.utils.cmake_prefix_path)') ..
make -j
export OPENSPLAT=~/OpenSplat/build/opensplat     # or pass --opensplat
```

If the Metal build gives trouble, `-DGPU_RUNTIME=CPU` works too (slower; still fine for a few thousand iterations on a small dataset).
The exact flags are maintained in the OpenSplat README (https://github.com/pierotofy/OpenSplat#macos).

## Linux (what the VM used)

```
sudo apt install colmap cmake libopencv-dev
curl -L -o libtorch.zip https://download.pytorch.org/libtorch/cpu/libtorch-cxx11-abi-shared-with-deps-2.5.1%2Bcpu.zip && unzip libtorch.zip
git clone https://github.com/pierotofy/OpenSplat && cd OpenSplat && mkdir build && cd build
cmake -DGPU_RUNTIME=CPU -DCMAKE_PREFIX_PATH=$PWD/../../libtorch -DCMAKE_BUILD_TYPE=Release .. && make -j
```

## Capturing images that reconstruct well

- 30–100 photos, walking slowly around the subject; each frame should overlap ~70% with its neighbours.
- Keep exposure/focus fixed if possible; avoid motion blur and featureless walls.
- The web app's Capture panel (webcam stand-in, 1 fps into a folder) produces a compatible `frame_0001.jpg…` set. When the depth camera is wired in, dump its RGB frames into a folder the same way — the pipeline only needs images.
- If COLMAP says it produced no model, the frames don't overlap enough; capture more densely.

## Timing

CPU-only VM (8 cores), 16 images of a banana at 1/2 resolution: COLMAP ~30 s, OpenSplat 300 iters ~2 min (2000 iters ≈ 15 min).
Apple Silicon with Metal is several times faster for the OpenSplat stage.
