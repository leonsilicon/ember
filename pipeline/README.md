# pipeline — images → Gaussian splat

One command turns a folder of photos of a scene into a `.splat` file the frontend viewer loads:

```
python3 pipeline/reconstruct.py path/to/images --splat frontend/public/splats/scene.splat
```

Stages (all CPU-capable, no CUDA needed):

1. **COLMAP** — finds camera poses + a sparse point cloud from the photos (`feature_extractor` → `exhaustive_matcher` → `mapper`).
2. **OpenSplat** — trains the Gaussian splat from the COLMAP project (Metal on Apple Silicon, CPU elsewhere).
3. Writes `scene.splat`. Open it in the web app (Scene panel → Load URL `/splats/scene.splat`, or "Open .splat").

Options: `--iters N` (default 3000; 300 is a fast smoke test, 7000+ looks good), `--downscale 2`, `--out <dir>` (project folder, default `<images>/../recon`), `--matcher sequential|exhaustive` (auto: sequential for 30+ frames in capture order — much faster for a 1 fps stream; exhaustive for small unordered sets), `--skip-colmap` to re-train with different settings.

## Install on macOS (Apple Silicon)

```
brew install colmap cmake opencv pytorch     # pytorch = libtorch; ~15 min of downloads
git clone https://github.com/pierotofy/OpenSplat ~/OpenSplat
cd ~/OpenSplat && mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_PREFIX_PATH=/opt/homebrew/opt/pytorch \
      -DTorch_DIR=$(dirname $(find /opt/homebrew/opt/pytorch/ -name TorchConfig.cmake | head -1)) ..
make -j$(sysctl -n hw.logicalcpu)
export OPENSPLAT=~/OpenSplat/build/opensplat     # or pass --opensplat
```

Metal (GPU) acceleration needs the full Xcode app plus its Metal toolchain (`xcodebuild -downloadComponent MetalToolchain`);
with only Command Line Tools installed, cmake prints "Metal compiler not found" and builds a CPU-only binary, which works but is slower
(`reconstruct.py` notices the "GPU support not built" error and re-runs OpenSplat with `--cpu`; pass `--cpu` to skip the first attempt).
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

CPU-only VM (8 cores), 16 images of a banana at 1/2 resolution: COLMAP ~30 s, OpenSplat 300 iters ~2 min. 39 iPhone photos of a desk scene: COLMAP 38 s, 3000 iters ~18 min → ~39k Gaussians. The script forces a dense refinement schedule (`--refine-every 100 --densify-until 0.8*iters`); OpenSplat's defaults barely densify below ~5000 iterations and give a blurry result.
Apple Silicon with Metal is several times faster for the OpenSplat stage.
