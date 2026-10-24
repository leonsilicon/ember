import simd

struct ColoredPoint: Equatable {
  var position: SIMD3<Float>
  var color: SIMD3<UInt8>
}

/// The splat's starting point cloud, accumulated across frames.
///
/// Points are keyed so the same surface seen in many frames is stored once: LiDAR
/// points by the voxel they fall in (first one wins), ARKit feature points by their
/// tracking identifier (latest position wins, since ARKit keeps refining them).
struct PointCloudAccumulator {
  let voxelSize: Float
  let capacity: Int
  private(set) var points: [ColoredPoint] = []
  private var indexByKey: [UInt64: Int] = [:]

  init(voxelSize: Float = 0.02, capacity: Int = 300_000) {
    self.voxelSize = voxelSize
    self.capacity = capacity
  }

  var count: Int { points.count }

  /// Inserts under `key`. With `replace`, an existing point under that key is overwritten.
  @discardableResult
  mutating func insert(_ point: ColoredPoint, key: UInt64, replace: Bool) -> Bool {
    if let index = indexByKey[key] {
      if replace { points[index] = point }
      return replace
    }
    guard points.count < capacity else { return false }
    indexByKey[key] = points.count
    points.append(point)
    return true
  }

  @discardableResult
  mutating func insertVoxelDeduplicated(_ point: ColoredPoint) -> Bool {
    insert(point, key: voxelKey(point.position), replace: false)
  }

  /// Packs the voxel coordinates into 21 bits per axis (±10 km at 1 cm voxels).
  func voxelKey(_ p: SIMD3<Float>) -> UInt64 {
    func axis(_ v: Float) -> UInt64 {
      let q = Int64((v / voxelSize).rounded(.down)) & 0x1F_FFFF
      return UInt64(bitPattern: q)
    }
    // Set the top bit so voxel keys never collide with small ARKit identifiers.
    return (1 << 63) | (axis(p.x) << 42) | (axis(p.y) << 21) | axis(p.z)
  }
}
