import type { ShaderProgram } from '../utils/shader-program'
import type { VelocityImage } from '../utils/velocity-image'

/** Coordinate system of a regular grid. */
export type RegularGridCrs = 'EPSG:4326' | 'EPSG:3857'

/**
 * A regular grid, described by its cell centres.
 *
 * This follows Tempo's grid geometry: `(x0, y0)` is the centre of cell (0, 0),
 * and `dy` is negative when rows run from north to south.
 */
export interface RegularGrid {
  /** EPSG:4326: x and y in degrees. EPSG:3857: x and y in metres. */
  crs: RegularGridCrs
  /** Number of columns. */
  nx: number
  /** Number of rows. */
  ny: number
  /** x of the centre of cell (0, 0). */
  x0: number
  /** y of the centre of cell (0, 0). */
  y0: number
  /** Cell width; must be positive. */
  dx: number
  /** Cell height; negative when rows run from north to south. */
  dy: number
}

/** Value used for missing components in float textures; GPUs may flush NaN. */
export const MISSING_FLOAT_SENTINEL = -3e38

// EPSG:3857 uses the WGS 84 semi-major axis as its sphere radius.
const MERCATOR_RADIUS = 6378137
const MERCATOR_MAX_LATITUDE = 85.05112878
// Relative tolerance for deciding whether a grid covers the whole earth.
const WRAP_TOLERANCE = 1e-6

// Must match the constants in sample_velocity.glsl.
const GLSL_CRS = { 'EPSG:4326': 0, 'EPSG:3857': 1 } as const
const GLSL_ENCODING = { rg8: 0, float32: 1 } as const

type Values =
  | { encoding: 'rg8'; image: VelocityImage }
  | { encoding: 'float32'; u: Float32Array; v: Float32Array }

/**
 * A velocity field on a regular grid in geographic mode.
 *
 * Components are true east (u) and north (v), in physical units. Values are
 * stored row-major with row 0 at `y0`, either as 8-bit RG with offset and
 * scale ({@link RegularVelocityChunk.fromImage}) or as float32
 * ({@link RegularVelocityChunk.fromComponents}).
 *
 * The same sampling is implemented on the CPU ({@link sample}) and on the GPU
 * (`sample_velocity.glsl`).
 */
export class RegularVelocityChunk {
  /** Whether the grid covers the whole earth in x, and so wraps around. */
  readonly wraps: boolean

  private constructor(
    readonly grid: Readonly<RegularGrid>,
    private readonly values: Values
  ) {
    validateGrid(grid)
    const period = periodOf(grid.crs)
    this.wraps = grid.nx * grid.dx >= period * (1 - WRAP_TOLERANCE)
  }

  /**
   * Creates a chunk from an 8-bit velocity image, e.g. a FEWS GeoTIFF.
   *
   * @param grid grid of the image; `nx` and `ny` must match its size.
   * @param image image whose rows follow the grid's rows: row 0 is at `y0`.
   */
  static fromImage(grid: RegularGrid, image: VelocityImage): RegularVelocityChunk {
    if (image.width !== grid.nx || image.height !== grid.ny) {
      throw new Error(
        `Image is ${image.width} × ${image.height}, but the grid is ${grid.nx} × ${grid.ny}.`
      )
    }
    return new RegularVelocityChunk({ ...grid }, { encoding: 'rg8', image })
  }

  /**
   * Creates a chunk from float components, without quantisation.
   *
   * @param grid grid of the components.
   * @param u row-major east components; NaN (or any non-finite value) is missing.
   * @param v row-major north components, same layout as `u`.
   */
  static fromComponents(
    grid: RegularGrid,
    u: ArrayLike<number>,
    v: ArrayLike<number>
  ): RegularVelocityChunk {
    validateGrid(grid)
    const numCells = grid.nx * grid.ny
    if (u.length !== numCells || v.length !== numCells) {
      throw new Error(
        `Expected ${numCells} values per component, got ${u.length} and ${v.length}.`
      )
    }
    return new RegularVelocityChunk(
      { ...grid },
      { encoding: 'float32', u: Float32Array.from(u), v: Float32Array.from(v) }
    )
  }

  /**
   * Returns the fractional (column, row) of a position. Cell centres are at
   * integer positions.
   *
   * @param lon longitude in degrees.
   * @param lat latitude in degrees.
   */
  gridPosition(lon: number, lat: number): [number, number] {
    const { crs, x0, y0, dx, dy } = this.grid
    let x: number
    let y: number
    if (crs === 'EPSG:3857') {
      const latClamped = Math.min(
        Math.max(lat, -MERCATOR_MAX_LATITUDE),
        MERCATOR_MAX_LATITUDE
      )
      x = (MERCATOR_RADIUS * lon * Math.PI) / 180
      y =
        MERCATOR_RADIUS *
        Math.log(Math.tan(Math.PI / 4 + (latClamped * Math.PI) / 360))
    } else {
      x = lon
      y = lat
    }
    const period = periodOf(crs)
    const west = x0 - 0.5 * dx
    const column = positiveModulo(x - west, period) / dx - 0.5
    const row = (y - y0) / dy
    return [column, row]
  }

  /**
   * Returns the velocity of one cell.
   *
   * @returns `[u, v]`, or null if the cell is missing or outside the grid.
   */
  cellVelocity(column: number, row: number): [number, number] | null {
    const { nx, ny } = this.grid
    if (this.wraps) column = positiveModulo(column, nx)
    if (column < 0 || column >= nx || row < 0 || row >= ny) return null
    if (this.values.encoding === 'rg8') {
      return this.values.image.velocityAt(column, row)
    }
    const index = row * nx + column
    const u = this.values.u[index] as number
    const v = this.values.v[index] as number
    return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null
  }

  /**
   * Samples the velocity at a position.
   *
   * A position is missing if its nearest cell is missing or outside the grid.
   * Otherwise the velocity is interpolated bilinearly over the four
   * surrounding cells, leaving out missing ones and renormalising the weights.
   *
   * @param lon longitude in degrees.
   * @param lat latitude in degrees.
   * @returns `[u, v]`, or null if the position is missing.
   */
  sample(lon: number, lat: number): [number, number] | null {
    const [column, row] = this.gridPosition(lon, lat)
    if (
      this.cellVelocity(Math.floor(column + 0.5), Math.floor(row + 0.5)) ===
      null
    ) {
      return null
    }

    const baseColumn = Math.floor(column)
    const baseRow = Math.floor(row)
    const fx = column - baseColumn
    const fy = row - baseRow

    let u = 0
    let v = 0
    let weightSum = 0
    for (const [dc, dr, weight] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy]
    ] as const) {
      const velocity = this.cellVelocity(baseColumn + dc, baseRow + dr)
      if (velocity === null) continue
      u += weight * velocity[0]
      v += weight * velocity[1]
      weightSum += weight
    }
    return [u / weightSum, v / weightSum]
  }

  /** Largest absolute u and v of all valid cells. */
  maxVelocity(): [number, number] {
    if (this.values.encoding === 'rg8') {
      const { uOffset, uScale, vOffset, vScale } = this.values.image
      return [
        Math.max(Math.abs(uOffset), Math.abs(uOffset + uScale)),
        Math.max(Math.abs(vOffset), Math.abs(vOffset + vScale))
      ]
    }
    let uMax = 0
    let vMax = 0
    const { u, v } = this.values
    for (let i = 0; i < u.length; i++) {
      const ui = u[i] as number
      const vi = v[i] as number
      if (!Number.isFinite(ui) || !Number.isFinite(vi)) continue
      uMax = Math.max(uMax, Math.abs(ui))
      vMax = Math.max(vMax, Math.abs(vi))
    }
    return [uMax, vMax]
  }

  /**
   * Uploads the values to a new texture for `sample_velocity.glsl`.
   *
   * RG8 values become an RGB(A)8 texture; float values an RG32F texture with
   * {@link MISSING_FLOAT_SENTINEL} for missing cells. Both use nearest
   * filtering, since the shader interpolates itself. The caller owns the
   * texture.
   */
  createTexture(gl: WebGL2RenderingContext): WebGLTexture {
    if (this.values.encoding === 'rg8') {
      return this.values.image.toTexture(gl, false)
    }

    const { nx, ny } = this.grid
    const { u, v } = this.values
    const data = new Float32Array(2 * nx * ny)
    for (let i = 0; i < nx * ny; i++) {
      const ui = u[i] as number
      const vi = v[i] as number
      const isValid = Number.isFinite(ui) && Number.isFinite(vi)
      data[2 * i] = isValid ? ui : MISSING_FLOAT_SENTINEL
      data[2 * i + 1] = isValid ? vi : MISSING_FLOAT_SENTINEL
    }

    const texture = gl.createTexture()
    if (texture === null) throw new Error('Failed to create texture.')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, nx, ny)
    const unpackAlignment: number = gl.getParameter(gl.UNPACK_ALIGNMENT)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nx, ny, gl.RG, gl.FLOAT, data)
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, unpackAlignment)
      gl.bindTexture(gl.TEXTURE_2D, null)
    }
    return texture
  }

  /**
   * Sets a `VelocityGrid` uniform struct (see `sample_velocity.glsl`).
   *
   * @param program linked and currently used program.
   * @param name name of the uniform, e.g. `u_velocity_grid`.
   */
  setUniforms(program: ShaderProgram, name: string): void {
    const gl = program.gl
    const location = (member: string) =>
      program.getUniformLocation(`${name}.${member}`)
    const { crs, nx, ny, x0, y0, dx, dy } = this.grid

    gl.uniform1i(location('crs'), GLSL_CRS[crs])
    gl.uniform2f(location('origin'), x0, y0)
    gl.uniform2f(location('spacing'), dx, dy)
    gl.uniform2i(location('size'), nx, ny)
    gl.uniform1i(location('wraps'), this.wraps ? 1 : 0)
    gl.uniform1i(location('encoding'), GLSL_ENCODING[this.values.encoding])
    if (this.values.encoding === 'rg8') {
      const { uScale, uOffset, vScale, vOffset } = this.values.image
      gl.uniform4f(location('decode'), uScale, uOffset, vScale, vOffset)
    } else {
      gl.uniform4f(location('decode'), 1, 0, 1, 0)
    }
  }
}

function periodOf(crs: RegularGridCrs): number {
  return crs === 'EPSG:3857' ? 2 * Math.PI * MERCATOR_RADIUS : 360
}

function positiveModulo(value: number, period: number): number {
  return value - period * Math.floor(value / period)
}

function validateGrid(grid: RegularGrid): void {
  const { crs, nx, ny, x0, y0, dx, dy } = grid
  if (crs !== 'EPSG:4326' && crs !== 'EPSG:3857') {
    throw new Error(`Unsupported grid coordinate system "${String(crs)}".`)
  }
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx <= 0 || ny <= 0) {
    throw new Error('Grid size must be positive integers.')
  }
  if (![x0, y0, dx, dy].every(Number.isFinite)) {
    throw new Error('Grid origin and spacing must be finite.')
  }
  if (dx <= 0) throw new Error('Grid dx must be positive.')
  if (dy === 0) throw new Error('Grid dy must not be zero.')
}
