import { createTexture } from './textures'

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
