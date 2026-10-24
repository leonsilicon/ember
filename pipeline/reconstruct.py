#!/usr/bin/env python3
"""Images -> COLMAP (poses + sparse points) -> OpenSplat (Gaussian splat) -> .splat/.ply.

Usage:
  python3 pipeline/reconstruct.py <images_dir> [--out <project_dir>] [--iters 2000]
                                  [--splat <path/to/out.splat>] [--opensplat <path>]

Produces <project_dir>/images/, <project_dir>/sparse/0/ (COLMAP) and the final splat
file. Copy the splat into frontend/public/splats/ (or use --splat to write it there) and
load it from the Viewer panel.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

IMAGE_EXTS = {'.jpg', '.jpeg', '.png'}


def run(cmd, log):
    print(f'$ {" ".join(str(c) for c in cmd)}', flush=True)
    with open(log, 'ab') as f:
        f.write(f'\n$ {" ".join(str(c) for c in cmd)}\n'.encode())
        proc = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        sys.exit(f'command failed (exit {proc.returncode}); see {log}')


def which_or_die(name, override=None):
    path = shutil.which(override) if override else shutil.which(name)
    if not path:
        sys.exit(f'{name} not found. See pipeline/README.md for install steps.')
    return path


def colmap_option_prefixes(colmap):
    """COLMAP <= 3.x names these SiftExtraction/SiftMatching; 3.10+ renamed them FeatureExtraction/FeatureMatching."""
    proc = subprocess.run([colmap, 'feature_extractor', '--help'], capture_output=True, text=True)
    if 'FeatureExtraction.use_gpu' in proc.stdout + proc.stderr:
        return 'FeatureExtraction', 'FeatureMatching'
    return 'SiftExtraction', 'SiftMatching'


def promote_largest_model(sparse: Path):
    """COLMAP may split the scene into several models; OpenSplat reads sparse/0, so put the biggest there."""
    models = [p for p in sparse.iterdir() if p.is_dir() and (p / 'images.bin').exists()]
    if len(models) < 2:
        return
    largest = max(models, key=lambda p: (p / 'images.bin').stat().st_size)
    if largest.name != '0':
        tmp = sparse / '_swap'
        (sparse / '0').rename(tmp)
        largest.rename(sparse / '0')
        tmp.rename(largest)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('images', help='folder of .jpg/.png frames of one scene')
    ap.add_argument('--out', help='project dir (default: <images>/../recon)')
    ap.add_argument('--iters', type=int, default=2000, help='OpenSplat iterations (2000 quick, 7000+ nicer)')
    ap.add_argument('--splat', help='output splat path (default: <out>/scene.splat)')
    ap.add_argument('--opensplat', default=os.environ.get('OPENSPLAT'), help='path to opensplat binary')
    ap.add_argument('--colmap', default=os.environ.get('COLMAP', 'colmap'), help='path to colmap binary')
    ap.add_argument('--downscale', type=float, default=2, help='OpenSplat image downscale factor')
    ap.add_argument('--max-image-size', type=int, default=1600, help='COLMAP feature extraction max image size')
    ap.add_argument('--matcher', choices=['auto', 'sequential', 'exhaustive'], default='auto',
                    help='sequential = frames are in capture order (fast, default for 30+ images); '
                         'exhaustive = unordered photos (default for small sets)')
    ap.add_argument('--overlap', type=int, default=10, help='sequential matcher: neighbours per frame')
    ap.add_argument('--skip-colmap', action='store_true', help='reuse an existing sparse/0')
    args = ap.parse_args()

    images_src = Path(args.images).resolve()
    frames = sorted(p for p in images_src.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if len(frames) < 5:
        sys.exit(f'need at least 5 images, found {len(frames)} in {images_src}')

    out = Path(args.out).resolve() if args.out else images_src.parent / 'recon'
    splat_out = Path(args.splat).resolve() if args.splat else out / 'scene.splat'
    images = out / 'images'
    db = out / 'database.db'
    sparse = out / 'sparse'
    log = out / 'reconstruct.log'
    out.mkdir(parents=True, exist_ok=True)

    colmap = which_or_die('colmap', args.colmap)
    opensplat = which_or_die('opensplat', args.opensplat)

    if not args.skip_colmap:
        if images.exists():
            shutil.rmtree(images)
        images.mkdir()
        for p in frames:
            shutil.copy2(p, images / p.name)
        for stale in (db, sparse):
            if stale.is_dir():
                shutil.rmtree(stale)
            elif stale.exists():
                stale.unlink()
        sparse.mkdir()

        t0 = time.time()
        print(f'[1/3] COLMAP on {len(frames)} images', flush=True)
        extraction, matching = colmap_option_prefixes(colmap)
        run([colmap, 'feature_extractor', '--database_path', db, '--image_path', images,
             '--ImageReader.single_camera', '1', '--ImageReader.camera_model', 'SIMPLE_RADIAL',
             f'--{extraction}.use_gpu', '0', f'--{extraction}.max_image_size', str(args.max_image_size)], log)
        matcher = args.matcher if args.matcher != 'auto' else ('sequential' if len(frames) >= 30 else 'exhaustive')
        if matcher == 'sequential':
            run([colmap, 'sequential_matcher', '--database_path', db, f'--{matching}.use_gpu', '0',
                 '--SequentialMatching.overlap', str(args.overlap)], log)
        else:
            run([colmap, 'exhaustive_matcher', '--database_path', db, f'--{matching}.use_gpu', '0'], log)
        run([colmap, 'mapper', '--database_path', db, '--image_path', images, '--output_path', sparse], log)
        promote_largest_model(sparse)
        print(f'      done in {time.time() - t0:.0f}s ({matcher} matching)', flush=True)

    model = sparse / '0'
    if not (model / 'cameras.bin').exists():
        sys.exit(f'COLMAP produced no model in {model}. Need more overlap between frames; see {log}')

    # OpenSplat expects the COLMAP layout <project>/images + <project>/sparse/0.
    t0 = time.time()
    print(f'[2/3] OpenSplat {args.iters} iterations', flush=True)
    run([opensplat, out, '-n', str(args.iters), '-d', str(args.downscale), '--center', '-o', splat_out], log)
    print(f'      done in {time.time() - t0:.0f}s', flush=True)

    print(f'[3/3] splat written: {splat_out} ({splat_out.stat().st_size / 1e6:.1f} MB)')
    print('Copy it to frontend/public/splats/ or load it from the Viewer panel.')


if __name__ == '__main__':
    main()
