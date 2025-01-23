import { createRectangleVertexArray } from '../utils/geometry'
import { ShaderProgram, bindTexture } from '../utils/shader-program'
import type { BoundingBoxScaling } from './final'

export class ParticleRenderer {
  public particleSize: number

  private program: ShaderProgram
  private width: number
  private height: number
  private numParticles: number
  private particleTexture: WebGLTexture
  private particlePositionTexture: WebGLTexture | null
  private positionBuffer: WebGLBuffer | null
  private texCoordBuffer: WebGLBuffer | null
  private vertexArray: WebGLVertexArrayObject | null
  private widthParticlePositionTexture: number
  private heightParticlePositionTexture: number
  private isSpriteRenderer: boolean

  constructor(
    program: ShaderProgram,
    width: number,
    height: number,
    numParticles: number,
    particleSize: number,
    particleTexture: WebGLTexture,
    widthParticlePositionTexture: number,
    heightParticlePositionTexture: number,
    isSpriteRenderer: boolean
  ) {
    this.program = program

    this.width = width
    this.height = height
    this.numParticles = numParticles
    this.particleSize = particleSize
    this.particleTexture = particleTexture
    this.particlePositionTexture = null
    this.widthParticlePositionTexture = widthParticlePositionTexture
    this.heightParticlePositionTexture = heightParticlePositionTexture

    this.positionBuffer = null
    this.texCoordBuffer = null
    this.vertexArray = null

    this.isSpriteRenderer = isSpriteRenderer
  }

  initialise(): void {
    // We need to flip the vertical texture coordinate since we are using a
    // texture loaded from an image, which is vertically flipped w.r.t. clip
    // space coordinates.
    const doFlipV = true
    const [positionBuffer, texCoordBuffer, vertexArray] =
      createRectangleVertexArray(
        this.program,
        -0.5,
        0.5,
        -0.5,
        0.5,
        doFlipV,
        'a_position',
        'a_tex_coord'
      )
    this.positionBuffer = positionBuffer
    this.texCoordBuffer = texCoordBuffer
    this.vertexArray = vertexArray
    this.particlePositionTexture = this.resetParticlePositionTexture()
  }

  destruct(): void {
    const gl = this.program.gl
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteBuffer(this.texCoordBuffer)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteTexture(this.particlePositionTexture)
    gl.deleteTexture(this.particleTexture)
    this.program.destruct()
  }

  setDimensions(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  setNumParticles(
    numParticles: number,
    widthParticlePositionTexture: number,
    heightParticlePositionTexture: number
  ): void {
    this.numParticles = numParticles
    this.widthParticlePositionTexture = widthParticlePositionTexture
    this.heightParticlePositionTexture = heightParticlePositionTexture
    this.particlePositionTexture = this.resetParticlePositionTexture()
  }

  render(particleBuffer: WebGLBuffer, scaling?: BoundingBoxScaling): void {
    if (!this.particlePositionTexture) {
      throw new Error(
        'No particle position texture defined, particle renderer was not initialised?'
      )
    }
    if (this.isSpriteRenderer && scaling === undefined) {
      throw new Error(
        'Must specify bounding box scaling when rendering sprites.'
      )
    }

    const gl = this.program.gl
    this.program.use()

    gl.enable(gl.BLEND)
    if (!this.isSpriteRenderer) {
      // We keep the current state of the frame buffer and render the particles on
      // top of it, ignoring alpha for this blending as it has already been taken
      // care of in the texture render.
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX)
      gl.blendFunc(gl.ONE, gl.ONE)
    } else {
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    }

    gl.bindVertexArray(this.vertexArray)
    this.updateParticleTextureFromBuffer(particleBuffer)

    bindTexture(this.program, 'u_particle_texture', 0, this.particleTexture)
    bindTexture(
      this.program,
      'u_particle_position_texture',
      1,
      this.particlePositionTexture
    )
    this.bindUniforms(scaling)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.numParticles)

    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)
  }

  private resetParticlePositionTexture(): WebGLTexture {
    const gl = this.program.gl

    if (this.particlePositionTexture) {
      gl.deleteTexture(this.particlePositionTexture)
    }

    const texture = gl.createTexture()
    if (texture === null) {
      throw new Error('Failed to create texture.')
    }

    gl.bindTexture(gl.TEXTURE_2D, texture)

    // Allocate storage for the texture.
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      gl.RGBA32F,
      this.widthParticlePositionTexture,
      this.heightParticlePositionTexture
    )

    // We use a 32-bit floating point texture for the particles that we do not
    // want to (and cannot) interpolate, so use nearest neighbour filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    gl.bindTexture(gl.TEXTURE_2D, null)

    return texture
  }

  private updateParticleTextureFromBuffer(particleBuffer: WebGLBuffer): void {
    if (!this.particlePositionTexture) {
      throw new Error(
        'No particle position texture defined, particle renderer was not initialised?'
      )
    }
    const gl = this.program.gl
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, particleBuffer)
    gl.bindTexture(gl.TEXTURE_2D, this.particlePositionTexture)

    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0, // level
      0, // x-offset
      0, // y-offset
      this.widthParticlePositionTexture,
      this.heightParticlePositionTexture,
      gl.RGBA,
      gl.FLOAT,
      0 // offset into the pixel unpack buffer
    )

    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null)
  }

  private bindUniforms(scaling?: BoundingBoxScaling): void {
    const gl = this.program.gl

    // Properties of the texture used to render the particle sprites; rescale
    // particle size to clip coordinates.
    gl.uniform1f(
      this.program.getUniformLocation('u_particle_size'),
      this.particleSize / this.width
    )
    gl.uniform1f(
      this.program.getUniformLocation('u_aspect_ratio'),
      this.width / this.height
    )
    gl.uniform1i(
      this.program.getUniformLocation('u_is_sprite'),
      this.isSpriteRenderer ? 1 : 0
    )

    // Width of the data texture to retrieve the particle positions in the
    // vertex shader.
    gl.uniform1i(
      this.program.getUniformLocation('u_width'),
      this.widthParticlePositionTexture
    )

    // Scaling parameters for the bounding box.
    gl.uniform2f(
      this.program.getUniformLocation('u_bbox_scale'),
      scaling?.scaleX ?? 1.0,
      scaling?.scaleY ?? 1.0
    )
    gl.uniform2f(
      this.program.getUniformLocation('u_bbox_offset'),
      scaling?.offsetX ?? 0.0,
      scaling?.offsetY ?? 0.0
    )
  }
}
