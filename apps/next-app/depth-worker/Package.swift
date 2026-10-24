// swift-tools-version:5.9
// Depth worker for the live reconstruction (apps/next-app/src/live): decodes camera JPEGs and runs
// Depth Anything V2 through Core ML, talking to the Bun server over stdin/stdout.
// Built by scripts/install-depth.sh into bin/depth_worker.
import PackageDescription

let package = Package(
  name: "depth-worker",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "depth_worker"),
  ]
)
