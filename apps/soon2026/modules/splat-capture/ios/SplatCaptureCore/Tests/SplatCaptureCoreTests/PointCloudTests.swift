import simd
import XCTest

@testable import SplatCaptureCore

final class PointCloudTests: XCTestCase {
  func point(_ x: Float, _ y: Float, _ z: Float, _ c: UInt8 = 0) -> ColoredPoint {
    ColoredPoint(position: SIMD3(x, y, z), color: SIMD3(c, c, c))
  }

  func testVoxelDedupKeepsFirstPointPerVoxel() {
    var cloud = PointCloudAccumulator(voxelSize: 0.1, capacity: 100)
    XCTAssertTrue(cloud.insertVoxelDeduplicated(point(0.01, 0.01, 0.01, 1)))
    XCTAssertFalse(cloud.insertVoxelDeduplicated(point(0.09, 0.05, 0.02, 2)))
    XCTAssertTrue(cloud.insertVoxelDeduplicated(point(0.11, 0.05, 0.02, 3)))
    XCTAssertEqual(cloud.points.map(\.color.x), [1, 3])
  }

  func testNegativeCoordinatesLandInDistinctVoxels() {
    var cloud = PointCloudAccumulator(voxelSize: 0.1, capacity: 100)
    cloud.insertVoxelDeduplicated(point(0.05, 0, 0))
    cloud.insertVoxelDeduplicated(point(-0.05, 0, 0))
    cloud.insertVoxelDeduplicated(point(0, -0.05, -3))
    XCTAssertEqual(cloud.count, 3)
  }

  func testFeaturePointsUpdateInPlaceByIdentifier() {
    var cloud = PointCloudAccumulator(capacity: 100)
    cloud.insert(point(1, 1, 1, 10), key: 42, replace: true)
    cloud.insert(point(1.01, 1, 1, 20), key: 42, replace: true)
    XCTAssertEqual(cloud.points, [point(1.01, 1, 1, 20)])
  }

  func testCapacityIsAHardCap() {
    var cloud = PointCloudAccumulator(voxelSize: 0.01, capacity: 2)
    for i in 0..<5 { cloud.insertVoxelDeduplicated(point(Float(i), 0, 0)) }
    XCTAssertEqual(cloud.count, 2)
  }
}
