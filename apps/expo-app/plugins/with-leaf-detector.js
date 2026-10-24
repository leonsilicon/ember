// Embeds packages/owlvit's leaf detector in the iOS app, so detection works from the first launch
// without the splat server. Read by src/hooks/use-detections.ts from the app bundle.
const { IOSConfig, withXcodeProject } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'owlvit-leaves.json';
/** The model's name in the app. The build's own name changes with every build; this one doesn't. */
const MODEL = 'owlvit-leaves.pte';

module.exports = function withLeafDetector(config) {
  return withXcodeProject(config, (config) => {
    // `eas build --local` prebuilds a copy of the repo that leaves out gitignored files, dist/ included,
    // so the TestFlight workflow points LEAF_DETECTOR_DIST at its checkout's dist/.
    const dist =
      process.env.LEAF_DETECTOR_DIST ?? path.resolve(config.modRequest.projectRoot, '../../packages/owlvit/dist');
    const manifestPath = path.join(dist, MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `The leaf detector isn't built (no ${manifestPath}). Build it with \`bun run --filter @soon2026/owlvit build\`, then prebuild again.`,
      );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const dir = path.join(config.modRequest.platformProjectRoot, 'LeafDetector');
    fs.mkdirSync(dir, { recursive: true });
    // A clone on APFS, so the ~180 MB model takes no time or space to copy.
    fs.copyFileSync(path.join(dist, manifest.model), path.join(dir, MODEL), fs.constants.COPYFILE_FICLONE);
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ ...manifest, model: MODEL }, null, 2));
    // Copied to the root of the app bundle. Adding them again on a later prebuild is a no-op.
    for (const file of [MODEL, MANIFEST]) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: `LeafDetector/${file}`,
        groupName: 'Resources',
        project: config.modResults,
        isBuildFile: true,
      });
    }
    return config;
  });
};
