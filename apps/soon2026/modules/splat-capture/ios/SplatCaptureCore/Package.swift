// swift-tools-version:5.9
// The ARKit-free core of the SplatCapture module, as a package so its logic can be
// unit tested with XCTest on the Mac (`swift test`). The pod compiles these same
// sources into the app (see ../SplatCapture.podspec).
import PackageDescription

let package = Package(
  name: "SplatCaptureCore",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [
    .library(name: "SplatCaptureCore", targets: ["SplatCaptureCore"])
  ],
  targets: [
    .target(name: "SplatCaptureCore"),
    .testTarget(name: "SplatCaptureCoreTests", dependencies: ["SplatCaptureCore"]),
  ]
)
