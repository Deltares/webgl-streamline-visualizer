import { createRectangleVertexArray } from '../utils/geometry'
import { ShaderProgram, bindTexture } from '../utils/shader-program'
import type { BoundingBoxScaling } from './final'
import type { ParticleBuffers } from './propagator'

export class ParticleRenderer {
  public particleSize: number
  public maxAge: number
  public growthRate: number

  private program: ShaderProgram
  private width: number
  private height: number
  private numParticles: number
  private particleTexture: WebGLTexture
  private particleDataTexture: WebGLTexture | null
  private particleAgeTexture: WebGLTexture | null
  private positionBuffer: WebGLBuffer | null
  private texCoordBuffer: WebGLBuffer | null
  private vertexArray: WebGLVertexArrayObject | null
  private widthParticleDataTexture: number
  private heightParticleDataTexture: number
  private isSpriteRenderer: boolean

  constructor(
    program: ShaderProgram,
    width: number,
    height: number,
    numParticles: number,
    particleSize: number,
    particleTexture: WebGLTexture,
    widthParticleDataTexture: number,
    heightParticleDataTexture: number,
    isSpriteRenderer: boolean,
    maxAge: number,
    growthRate: number
  ) {
    this.program = program

    this.width = width
    this.height = height
    this.numParticles = numParticles
    this.particleSize = particleSize
    this.particleTexture = particleTexture
    this.particleDataTexture = null
    this.particleAgeTexture = null
    this.widthParticleDataTexture = widthParticleDataTexture
    this.heightParticleDataTexture = heightParticleDataTexture

    this.maxAge = maxAge
    this.growthRate = growthRate

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
    this.resetParticleDataTextures()
  }

  destruct(): void {
    const gl = this.program.gl
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteBuffer(this.texCoordBuffer)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteTexture(this.particleDataTexture)
    gl.deleteTexture(this.particleAgeTexture)
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
    this.widthParticleDataTexture = widthParticlePositionTexture
    this.heightParticleDataTexture = heightParticlePositionTexture
    this.resetParticleDataTextures()
  }

  render(particleBuffers: ParticleBuffers, scaling?: BoundingBoxScaling): void {
    if (!this.particleDataTexture || !this.particleAgeTexture) {
      throw new Error(
        'No particle data textures defined, particle renderer was not initialised?'
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

    // Update particle data (i.e. position and velocity) and particle age data
    // texture for use in the particle renderer.
    this.updateParticleDataTextureFromBuffer(
      particleBuffers.data,
      this.particleDataTexture,
      4
    )
    this.updateParticleDataTextureFromBuffer(
      particleBuffers.age,
      this.particleAgeTexture,
      1
    )

    bindTexture(this.program, 'u_particle_texture', 0, this.particleTexture)
    bindTexture(
      this.program,
      'u_particle_data_texture',
      1,
      this.particleDataTexture
    )
    bindTexture(
      this.program,
      'u_particle_age_texture',
      2,
      this.particleAgeTexture
    )
    this.bindUniforms(scaling)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.numParticles)

    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)
  }

  private resetParticleDataTextures(): void {
    const gl = this.program.gl
    if (this.particleDataTexture) gl.deleteTexture(this.particleDataTexture)
    if (this.particleAgeTexture) gl.deleteTexture(this.particleAgeTexture)

    this.particleDataTexture = this.createParticleDataTexture(4)
    this.particleAgeTexture = this.createParticleDataTexture(1)
  }

  private createParticleDataTexture(numComponents: 1 | 4): WebGLTexture {
    const gl = this.program.gl

    const texture = gl.createTexture()
    if (texture === null) {
      throw new Error('Failed to create texture.')
    }

    gl.bindTexture(gl.TEXTURE_2D, texture)

    // Allocate storage for the texture.
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      numComponents === 1 ? gl.R32F : gl.RGBA32F,
      this.widthParticleDataTexture,
      this.heightParticleDataTexture
    )

    // We use a 32-bit floating point texture for the particles that we do not
    // want to (and cannot) interpolate, so use nearest neighbour filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    gl.bindTexture(gl.TEXTURE_2D, null)

    return texture
  }

  private updateParticleDataTextureFromBuffer(
    particleBuffer: WebGLBuffer,
    dataTexture: WebGLTexture,
    numComponents: 1 | 4
  ): void {
    if (!this.particleDataTexture) {
      throw new Error(
        'No particle position texture defined, particle renderer was not initialised?'
      )
    }
    const gl = this.program.gl
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, particleBuffer)
    gl.bindTexture(gl.TEXTURE_2D, dataTexture)

    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0, // level
      0, // x-offset
      0, // y-offset
      this.widthParticleDataTexture,
      this.heightParticleDataTexture,
      numComponents === 1 ? gl.RED : gl.RGBA,
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
      this.widthParticleDataTexture
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

    gl.uniform1f(this.program.getUniformLocation('u_max_age'), this.maxAge)
    gl.uniform1f(
      this.program.getUniformLocation('u_growth_rate'),
      this.growthRate
    )
  }
}
