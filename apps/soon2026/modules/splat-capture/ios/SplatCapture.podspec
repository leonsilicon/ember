Pod::Spec.new do |s|
  s.name           = 'SplatCapture'
  s.version        = '1.0.0'
  s.summary        = 'ARKit capture for Gaussian splats'
  s.description    = 'Records ARKit frames, poses and a LiDAR or feature-point seed cloud as a Brush-ready dataset.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'SceneKit', 'CoreImage', 'CoreVideo'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # The module sources, plus the ARKit-free core that also builds as a Swift package
  # for XCTest (SplatCaptureCore/Package.swift and its Tests are not compiled here).
  s.source_files = "*.swift", "SplatCaptureCore/Sources/**/*.swift"
end
