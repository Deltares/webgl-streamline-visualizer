import { MISSING_FLOAT_SENTINEL } from './regular-velocity-chunk'

export interface CurvilinearGridOptions {
  /** Texels per side of the lookup texture on the GPU; 2048 by default. */
  lookupSize?: number
}

/** Where a position lies on a curvilinear grid; see {@link CurvilinearGrid.locate}. */
export interface CurvilinearLocation {
  /** Column of the quad's corner (c, r). */
  column: number
  /** Row of the quad's corner (c, r). */
  row: number
  /** Fraction towards column c + 1, in 0..1. */
  fx: number
  /** Fraction towards row r + 1, in 0..1. */
  fy: number
}

const DEFAULT_LOOKUP_SIZE = 2048
// The aim is a few quads per bucket.
const QUADS_PER_BUCKET = 2
// Coordinates are float32, a few µ° apart at these latitudes: a point on an
// outer cell centre can fall just outside its quad. In degrees for bounding
// boxes, and as a fraction of a cell within one.
const SLACK = 1e-5
const FRACTION_SLACK = 1e-3
const MAX_NEWTON_STEPS = 16
const NEWTON_TOLERANCE = 1e-12
const MIN_DETERMINANT = 1e-30

/**
 * A curvilinear grid: every cell centre has its own longitude and latitude, as
 * in ocean models that follow a coast. Rows and columns are the model's, not
 * north-up.
 *
 * Values are interpolated within a *quad*: the four cell centres (c, r),
 * (c + 1, r), (c, r + 1) and (c + 1, r + 1), mapped bilinearly onto their
 * coordinates. A quad with a corner without coordinates does not exist, and
 * neither does the half cell beyond the outermost centres.
 *
 * This matches `tempo_grid::CurvilinearGrid`, including its lookup: the same
 * quad is found for the same position. Share one grid between fields that
 * differ only in their values, such as lead times: its GPU textures are built
 * once.
 */
export class CurvilinearGrid {
  readonly lookupSize: number
  /** Bounds of the cell centres, in degrees. */
  readonly west: number
  readonly east: number
  readonly south: number
  readonly north: number

  /** Longitudes in degrees, continuous across the antimeridian; NaN if none. */
  readonly lon: Float64Array
  /** Latitudes in degrees; NaN if none. */
  readonly lat: Float64Array

  private readonly bucketColumns: number
  private readonly bucketRows: number
  private readonly bucketWidth: number
  private readonly bucketHeight: number
  private readonly bucketOffsets: Uint32Array
  private readonly bucketQuads: Uint32Array

  /**
   * @param nx number of columns.
   * @param ny number of rows.
   * @param lon row-major cell-centre longitudes in degrees; NaN where a cell has
   *   no coordinates.
   * @param lat row-major cell-centre latitudes in degrees; same layout as `lon`.
   */
  constructor(
    readonly nx: number,
    readonly ny: number,
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    options: CurvilinearGridOptions = {}
  ) {
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2) {
      throw new Error('A curvilinear grid needs at least 2 × 2 cells.')
    }
    const numCells = nx * ny
    if (lon.length !== numCells || lat.length !== numCells) {
      throw new Error(
        `Expected ${numCells} coordinates per axis, got ${lon.length} and ${lat.length}.`
      )
    }
    this.lookupSize = options.lookupSize ?? DEFAULT_LOOKUP_SIZE

    this.lon = new Float64Array(numCells)
    this.lat = new Float64Array(numCells)
    let reference = Number.NaN
    for (let i = 0; i < numCells; i++) {
      const lonI = lon[i] as number
      const latI = lat[i] as number
      if (!Number.isFinite(lonI) || !Number.isFinite(latI)) {
        this.lon[i] = Number.NaN
        this.lat[i] = Number.NaN
        continue
      }
      if (Number.isNaN(reference)) reference = lonI
      // Keep longitudes continuous, also for a grid across the antimeridian.
      this.lon[i] = reference + wrapDegrees(lonI - reference)
      this.lat[i] = latI
    }

    const quads: number[] = []
    let west = Infinity
    let east = -Infinity
    let south = Infinity
    let north = -Infinity
    const corners = new Float64Array(8)
    for (let row = 0; row < ny - 1; row++) {
      for (let column = 0; column < nx - 1; column++) {
        const quad = row * nx + column
        if (!this.readCorners(quad, corners)) continue
        quads.push(quad)
        for (let i = 0; i < 4; i++) {
          west = Math.min(west, corners[2 * i] as number)
          east = Math.max(east, corners[2 * i] as number)
          south = Math.min(south, corners[2 * i + 1] as number)
          north = Math.max(north, corners[2 * i + 1] as number)
        }
      }
    }
    if (quads.length === 0) {
      throw new Error('A curvilinear grid needs at least one complete quad.')
    }
    if (east - west >= 180) {
      throw new Error(
        'A curvilinear grid must span less than 180° of longitude.'
      )
    }
    this.west = west
    this.east = east
    this.south = south
    this.north = north

    // Buckets about as wide as they are high, in degrees, a few quads each.
    const target = Math.max(Math.floor(quads.length / QUADS_PER_BUCKET), 1)
    const width = Math.max(east - west, 1e-9)
    const height = Math.max(north - south, 1e-9)
    this.bucketColumns = Math.max(
      Math.ceil(Math.sqrt((target * width) / height)),
      1
    )
    this.bucketRows = Math.max(Math.ceil(target / this.bucketColumns), 1)
    this.bucketWidth = width / this.bucketColumns
    this.bucketHeight = height / this.bucketRows

    // Compressed rows: the quads of bucket b are
    // bucketQuads[bucketOffsets[b]..bucketOffsets[b + 1]]. A quad is listed in
    // every bucket its bounding box touches.
    const numBuckets = this.bucketColumns * this.bucketRows
    const offsets = new Uint32Array(numBuckets + 1)
    for (const quad of quads) {
      this.forEachBucketOfQuad(quad, corners, bucket => {
        offsets[bucket + 1] = (offsets[bucket + 1] as number) + 1
      })
    }
    for (let b = 0; b < numBuckets; b++) {
      offsets[b + 1] = (offsets[b + 1] as number) + (offsets[b] as number)
    }
    this.bucketOffsets = offsets
    const next = offsets.slice()
    this.bucketQuads = new Uint32Array(offsets[numBuckets] as number)
    for (const quad of quads) {
      this.forEachBucketOfQuad(quad, corners, bucket => {
        this.bucketQuads[next[bucket] as number] = quad
        next[bucket] = (next[bucket] as number) + 1
      })
    }
  }

  /**
   * Returns the quad holding a position, and the position's place in it.
   *
   * @param lon longitude in degrees.
   * @param lat latitude in degrees.
   * @returns the location, or null outside every quad.
   */
  locate(lon: number, lat: number): CurvilinearLocation | null {
    // Bring the longitude to the grid's side of the antimeridian.
    const centre = 0.5 * (this.west + this.east)
    const x = centre + wrapDegrees(lon - centre)
    const bucket = this.bucketOf(x, lat)
    if (bucket === null) return null

    const corners = new Float64Array(8)
    const start = this.bucketOffsets[bucket] as number
    const end = this.bucketOffsets[bucket + 1] as number
    for (let i = start; i < end; i++) {
      const quad = this.bucketQuads[i] as number
      this.readCorners(quad, corners)
      if (!isInBounds(corners, x, lat)) continue
      const fractions = inverseBilinear(corners, x, lat)
      if (fractions === null) continue
      return {
        column: quad % this.nx,
        row: Math.floor(quad / this.nx),
        fx: fractions[0],
        fy: fractions[1]
      }
    }
    return null
  }

  /** Reads a quad's corners as (lon, lat) pairs; false if one has none. */
  private readCorners(quad: number, corners: Float64Array): boolean {
    const cells = [quad, quad + 1, quad + this.nx, quad + this.nx + 1]
    for (let i = 0; i < 4; i++) {
      const lon = this.lon[cells[i] as number] as number
      if (Number.isNaN(lon)) return false
      corners[2 * i] = lon
      corners[2 * i + 1] = this.lat[cells[i] as number] as number
    }
    return true
  }

  private bucketOf(x: number, y: number): number | null {
    const index = (v: number, origin: number, step: number, length: number) => {
      // A point on an edge, or just beyond it, belongs to the bucket inside.
      if (v < origin - SLACK || v > origin + step * length + SLACK) return null
      return Math.min(Math.max(Math.floor((v - origin) / step), 0), length - 1)
    }
    const column = index(x, this.west, this.bucketWidth, this.bucketColumns)
    const row = index(y, this.south, this.bucketHeight, this.bucketRows)
    if (column === null || row === null) return null
    return row * this.bucketColumns + column
  }

  private forEachBucketOfQuad(
    quad: number,
    corners: Float64Array,
    callback: (bucket: number) => void
  ): void {
    this.readCorners(quad, corners)
    const index = (v: number, origin: number, step: number, length: number) =>
      Math.min(Math.max(Math.floor((v - origin) / step), 0), length - 1)
    const xs = [corners[0], corners[2], corners[4], corners[6]] as number[]
    const ys = [corners[1], corners[3], corners[5], corners[7]] as number[]
    const c0 = index(
      Math.min(...xs),
      this.west,
      this.bucketWidth,
      this.bucketColumns
    )
    const c1 = index(
      Math.max(...xs),
      this.west,
      this.bucketWidth,
      this.bucketColumns
    )
    const r0 = index(
      Math.min(...ys),
      this.south,
      this.bucketHeight,
      this.bucketRows
    )
    const r1 = index(
      Math.max(...ys),
      this.south,
      this.bucketHeight,
      this.bucketRows
    )
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) callback(r * this.bucketColumns + c)
    }
  }
}

/**
 * A velocity field on a curvilinear grid in geographic mode.
 *
 * Components are true east (u) and north (v), in physical units, in the grid's
 * native order: nothing is resampled. The same sampling is implemented on the
 * CPU ({@link sample}) and on the GPU (`sample_curvilinear.glsl`).
 */
export class CurvilinearVelocityField {
  private readonly u: Float32Array
  private readonly v: Float32Array

  /**
   * @param grid grid of the components.
   * @param u row-major east components; NaN (or any non-finite value) is missing.
   * @param v row-major north components, same layout as `u`.
   */
  constructor(
    readonly grid: CurvilinearGrid,
    u: ArrayLike<number>,
    v: ArrayLike<number>
  ) {
    const numCells = grid.nx * grid.ny
    if (u.length !== numCells || v.length !== numCells) {
      throw new Error(
        `Expected ${numCells} values per component, got ${u.length} and ${v.length}.`
      )
    }
    this.u = Float32Array.from(u)
    this.v = Float32Array.from(v)
  }

  /** Returns the velocity of one cell, or null if it is missing. */
  cellVelocity(column: number, row: number): [number, number] | null {
    const index = row * this.grid.nx + column
    const u = this.u[index] as number
    const v = this.v[index] as number
    return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null
  }

  /**
   * Samples the velocity at a position.
   *
   * A position is missing outside every quad, and if the nearest corner of its
   * quad is missing. Otherwise the velocity is interpolated bilinearly over the
   * corners, leaving out missing ones and renormalising the weights, as on
   * regular grids.
   *
   * @param lon longitude in degrees.
   * @param lat latitude in degrees.
   * @returns `[u, v]`, or null if the position is missing.
   */
  sample(lon: number, lat: number): [number, number] | null {
    const location = this.grid.locate(lon, lat)
    if (location === null) return null
    const { column, row, fx, fy } = location
    const nearest = this.cellVelocity(
      column + (fx >= 0.5 ? 1 : 0),
      row + (fy >= 0.5 ? 1 : 0)
    )
    if (nearest === null) return null

    let u = 0
    let v = 0
    let weightSum = 0
    for (const [dc, dr, weight] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy]
    ] as const) {
      const velocity = this.cellVelocity(column + dc, row + dr)
      if (velocity === null) continue
      u += weight * velocity[0]
      v += weight * velocity[1]
      weightSum += weight
    }
    return [u / weightSum, v / weightSum]
  }

  /** Largest absolute u and v of all valid cells. */
  maxVelocity(): [number, number] {
    let uMax = 0
    let vMax = 0
    for (let i = 0; i < this.u.length; i++) {
      const u = this.u[i] as number
      const v = this.v[i] as number
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue
      uMax = Math.max(uMax, Math.abs(u))
      vMax = Math.max(vMax, Math.abs(v))
    }
    return [uMax, vMax]
  }

  /**
   * Uploads the values to a new RG32F texture, with
   * {@link MISSING_FLOAT_SENTINEL} for missing cells. The caller owns it.
   */
  createTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const { nx, ny } = this.grid
    const data = new Float32Array(2 * nx * ny)
    for (let i = 0; i < nx * ny; i++) {
      const u = this.u[i] as number
      const v = this.v[i] as number
      const isValid = Number.isFinite(u) && Number.isFinite(v)
      data[2 * i] = isValid ? u : MISSING_FLOAT_SENTINEL
      data[2 * i + 1] = isValid ? v : MISSING_FLOAT_SENTINEL
    }
    return createFloatTexture(gl, nx, ny, data)
  }
}

/** Creates an RG32F texture with nearest filtering. */
export function createFloatTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Float32Array | null
): WebGLTexture {
  const texture = gl.createTexture()
  if (texture === null) throw new Error('Failed to create texture.')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, width, height)
  if (data) {
    const unpackAlignment: number = gl.getParameter(gl.UNPACK_ALIGNMENT)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.RG,
      gl.FLOAT,
      data
    )
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, unpackAlignment)
  }
  gl.bindTexture(gl.TEXTURE_2D, null)
  return texture
}

function wrapDegrees(value: number): number {
  return value - 360 * Math.floor((value + 180) / 360)
}

function isInBounds(corners: Float64Array, x: number, y: number): boolean {
  const c0x = corners[0] as number
  const c1x = corners[2] as number
  const c2x = corners[4] as number
  const c3x = corners[6] as number
  const c0y = corners[1] as number
  const c1y = corners[3] as number
  const c2y = corners[5] as number
  const c3y = corners[7] as number
  return (
    x >= Math.min(c0x, c1x, c2x, c3x) - SLACK &&
    x <= Math.max(c0x, c1x, c2x, c3x) + SLACK &&
    y >= Math.min(c0y, c1y, c2y, c3y) - SLACK &&
    y <= Math.max(c0y, c1y, c2y, c3y) + SLACK
  )
}

/**
 * Inverts a quad's bilinear map with Newton's method. Longitudes are scaled by
 * the cosine of the latitude first, so the iteration works in roughly equal
 * units; the fractions do not depend on that scale.
 *
 * @returns the fractions, or null if the point lies outside the quad or the
 *   quad is degenerate.
 */
function inverseBilinear(
  corners: Float64Array,
  x: number,
  y: number
): [number, number] | null {
  const x0 = corners[0] as number
  const y0 = corners[1] as number
  const k = Math.cos((y0 * Math.PI) / 180)
  const bx = ((corners[2] as number) - x0) * k
  const by = (corners[3] as number) - y0
  const cx = ((corners[4] as number) - x0) * k
  const cy = (corners[5] as number) - y0
  const dx = ((corners[6] as number) - x0) * k
  const dy = (corners[7] as number) - y0
  const qx = (x - x0) * k
  const qy = y - y0

  let s = 0.5
  let t = 0.5
  for (let i = 0; i < MAX_NEWTON_STEPS; i++) {
    const fx = s * (1 - t) * bx + (1 - s) * t * cx + s * t * dx - qx
    const fy = s * (1 - t) * by + (1 - s) * t * cy + s * t * dy - qy
    // Partial derivatives along s and t.
    const sx = (1 - t) * bx + t * (dx - cx)
    const sy = (1 - t) * by + t * (dy - cy)
    const tx = (1 - s) * cx + s * (dx - bx)
    const ty = (1 - s) * cy + s * (dy - by)
    const determinant = sx * ty - sy * tx
    if (Math.abs(determinant) < MIN_DETERMINANT) return null
    const ds = (fx * ty - fy * tx) / determinant
    const dt = (sx * fy - sy * fx) / determinant
    s -= ds
    t -= dt
    if (Math.abs(ds) + Math.abs(dt) < NEWTON_TOLERANCE) break
  }
  const isInside = (v: number) =>
    v >= -FRACTION_SLACK && v <= 1 + FRACTION_SLACK
  if (!isInside(s) || !isInside(t)) return null
  return [Math.min(Math.max(s, 0), 1), Math.min(Math.max(t, 0), 1)]
}
