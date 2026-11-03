import { createTexture } from './textures'

/**
 * A velocity field quantised to 8 bits per component.
 *
 * Data contract:
 * - `data` is row-major, RGB or RGBA (inferred from its length), one byte per
 *   channel. R holds the u component, G the v component.
 * - A component is decoded as `byte / 255 * scale + offset`: `uScale` and
 *   `vScale` are per *normalised* texel value (0..1), not per byte.
 * - A pixel is missing if R = G = 255, or if it has alpha and A = 0.
 * - Rows run from north to south.
 * - In screen mode (`StreamlineVisualiser.setVelocityImage`), the image covers
 *   the current viewport's bounding box in EPSG:3857. In geographic mode, a
 *   `RegularVelocityChunk` gives it a grid.
 *
 * Use {@link VelocityImage.fromComponents} to build one from float components.
 */
export class VelocityImage {
  constructor(
    private readonly data: Uint8Array | Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
    readonly uOffset: number,
    readonly vOffset: number,
    readonly uScale: number,
    readonly vScale: number
  ) {}

  /**
   * Quantises float components to an RGBA image.
   *
   * Offset and scale are chosen per component from the range of its finite
   * values. Valid values use bytes 0..254, so that a valid pixel can never
   * equal the R = G = 255 missing sentinel. Pixels where either component is
   * not finite (e.g. NaN) are marked missing.
   *
   * @param u row-major u components, rows from north to south.
   * @param v row-major v components, same layout as `u`.
   * @param width number of columns.
   * @param height number of rows.
   */
  static fromComponents(
    u: ArrayLike<number>,
    v: ArrayLike<number>,
    width: number,
    height: number
  ): VelocityImage {
    const numPixels = width * height
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error('Width and height must be integers.')
    }
    if (u.length !== numPixels || v.length !== numPixels) {
      throw new Error(
        `Expected ${numPixels} values per component, got ${u.length} and ${v.length}.`
      )
    }

    const isValid = (i: number) =>
      Number.isFinite(u[i]) && Number.isFinite(v[i])

    let uMin = Infinity
    let uMax = -Infinity
    let vMin = Infinity
    let vMax = -Infinity
    for (let i = 0; i < numPixels; i++) {
      if (!isValid(i)) continue
      const ui = u[i] as number
      const vi = v[i] as number
      uMin = Math.min(uMin, ui)
      uMax = Math.max(uMax, ui)
      vMin = Math.min(vMin, vi)
      vMax = Math.max(vMax, vi)
    }
    if (uMin > uMax) {
      // No valid values at all.
      uMin = uMax = vMin = vMax = 0
    }

    const MAX_VALID_BYTE = 254
    const uRange = uMax - uMin
    const vRange = vMax - vMin
    const quantise = (value: number, min: number, range: number) =>
      range > 0 ? Math.round(((value - min) / range) * MAX_VALID_BYTE) : 0

    const data = new Uint8Array(4 * numPixels)
    for (let i = 0; i < numPixels; i++) {
      if (isValid(i)) {
        data[4 * i] = quantise(u[i] as number, uMin, uRange)
        data[4 * i + 1] = quantise(v[i] as number, vMin, vRange)
        data[4 * i + 3] = 255
      } else {
        data[4 * i] = 255
        data[4 * i + 1] = 255
        data[4 * i + 3] = 0
      }
    }

    // Byte 254 must decode to the maximum: 254 / 255 * scale = range.
    const toScale = (range: number) => (range * 255) / MAX_VALID_BYTE
    return new VelocityImage(
      data,
      width,
      height,
      uMin,
      vMin,
      toScale(uRange),
      toScale(vRange)
    )
  }

  /** Number of channels per pixel: 3 (RGB) or 4 (RGBA). */
  get numChannels(): 3 | 4 {
    const numPixels = this.width * this.height
    if (this.data.length === 3 * numPixels) return 3
    if (this.data.length === 4 * numPixels) return 4
    throw new Error('Only RGB or RGBA velocity images are supported.')
  }

  /**
   * Decodes the velocity of one pixel.
   *
   * @returns `[u, v]`, or null if the pixel is missing or outside the image.
   */
  velocityAt(column: number, row: number): [number, number] | null {
    if (
      column < 0 ||
      column >= this.width ||
      row < 0 ||
      row >= this.height
    ) {
      return null
    }
    const channels = this.numChannels
    const index = channels * (row * this.width + column)
    const r = this.data[index] as number
    const g = this.data[index + 1] as number
    const a = channels === 4 ? (this.data[index + 3] as number) : 255
    if ((r === 255 && g === 255) || a === 0) return null
    return [
      (r / 255) * this.uScale + this.uOffset,
      (g / 255) * this.vScale + this.vOffset
    ]
  }

  maxVelocity(): [number, number] {
    const computeU = (r: number) => r * this.uScale + this.uOffset
    const computeV = (g: number) => g * this.vScale + this.vOffset

    return [
      Math.max(computeU(0), computeU(1)),
      Math.max(computeV(0), computeV(1))
    ]
  }

  toTexture(gl: WebGL2RenderingContext, interpolate: boolean): WebGLTexture {
    return createTexture(
      gl,
      interpolate ? gl.LINEAR : gl.NEAREST,
      this.data,
      this.width,
      this.height
    )
  }
}
