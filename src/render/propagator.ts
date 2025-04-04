import { SpeedCurve } from '../utils/speedcurve'
import {
  ShaderProgram,
  bindAttribute,
  bindTexture
} from '../utils/shader-program'
import { VelocityImage } from '../utils/wms'

export class ParticleBuffers {
  private gl: WebGL2RenderingContext
  readonly data: WebGLBuffer
  readonly age: WebGLBuffer

  constructor(gl: WebGL2RenderingContext, numParticlesAllocate: number) {
    this.gl = gl
    this.data = ParticleBuffers.createBuffer(gl, 4, numParticlesAllocate)
    this.age = ParticleBuffers.createBuffer(gl, 1, numParticlesAllocate)
  }

  destroy(): void {
    this.gl.deleteBuffer(this.data)
    this.gl.deleteBuffer(this.age)
  }

  initialise(
    initialCoordinates: Float32Array,
    initialAges: Float32Array
  ): void {
    const gl = this.gl

    gl.bindBuffer(gl.ARRAY_BUFFER, this.data)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, initialCoordinates)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.age)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, initialAges)

    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  resetAges(newAges: Float32Array): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.age)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, newAges)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private static createBuffer(
    gl: WebGL2RenderingContext,
    numFloatsPerParticle: number,
    numParticlesAllocate: number
  ): WebGLBuffer {
    const buffer = gl.createBuffer()
    const numBytesBuffer = 4 * numFloatsPerParticle * numParticlesAllocate
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, numBytesBuffer, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return buffer
  }
}

export class ParticlePropagator {
  private program: ShaderProgram
  private width: number
  private height: number
  private numParticles: number
  private numParticlesAllocate: number
  private maxAge: number
  private speedCurve: SpeedCurve
  private inputBuffers: ParticleBuffers | null
  private outputBuffers: ParticleBuffers | null
  private transformFeedback: WebGLTransformFeedback | null
  private velocityImage: VelocityImage | null
  private velocityTexture: WebGLTexture | null

  constructor(
    program: ShaderProgram,
    width: number,
    height: number,
    numParticles: number,
    numParticlesAllocate: number,
    maxAge: number,
    speedCurve: SpeedCurve
  ) {
    this.program = program
    this.width = width
    this.height = height

    this.numParticles = numParticles
    this.numParticlesAllocate = numParticlesAllocate
    this.maxAge = maxAge

    this.velocityImage = null
    this.velocityTexture = null
    this.speedCurve = speedCurve

    this.inputBuffers = null
    this.outputBuffers = null
    this.transformFeedback = null
  }

  get buffers(): ParticleBuffers {
    if (!this.outputBuffers) {
      throw new Error(
        'No output buffer defined, particle renderer was not initialised?'
      )
    }
    return this.outputBuffers
  }

  initialise(): void {
    const gl = this.program.gl

    this.resetBuffers()
    this.transformFeedback = gl.createTransformFeedback()
  }

  destruct(): void {
    const gl = this.program.gl
    if (this.inputBuffers) this.inputBuffers.destroy()
    if (this.outputBuffers) this.outputBuffers.destroy()

    gl.deleteTransformFeedback(this.transformFeedback)
    gl.deleteTexture(this.velocityTexture)
    this.program.destruct()
  }

  setDimensions(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  setVelocityImage(velocityImage: VelocityImage): void {
    this.velocityImage = velocityImage
    this.velocityTexture = velocityImage.toTexture(this.program.gl, false)
  }

  setNumParticles(numParticles: number, numParticlesAllocate: number): void {
    this.numParticles = numParticles
    this.numParticlesAllocate = numParticlesAllocate

    this.resetBuffers()
  }

  setMaxAge(maxAge: number): void {
    this.maxAge = maxAge

    // Reset all particle ages to spread all over the new age range.
    this.resetBuffers()
  }

  setSpeedCurve(speedCurve: SpeedCurve): void {
    this.speedCurve = speedCurve
  }

  resetAges(): void {
    const initialAges = this.generateInitialParticleAges()
    // Set the new ages on the output buffer, since we swap the buffers at the
    // start of rendering.
    this.outputBuffers?.resetAges(initialAges)
  }

  update(dt: number): void {
    const gl = this.program.gl
    this.program.use()

    if (!this.inputBuffers || !this.outputBuffers) {
      throw new Error(
        'Input buffer and/or output buffer is not defined, particle renderer was not initialised?'
      )
    }
    if (!this.velocityTexture) {
      throw new Error(
        'Velocity texture is not defined, no velocity image was set?'
      )
    }

    // We need to swap the buffers before we do the update, since we use the
    // output buffer in later rendering steps, so it should not have been
    // swapped out.
    this.swapBuffers()

    bindAttribute(
      gl,
      this.inputBuffers.data,
      this.program.getAttributeLocation('a_particle_data'),
      4
    )
    bindAttribute(
      gl,
      this.inputBuffers.age,
      this.program.getAttributeLocation('a_particle_age'),
      1
    )
    bindTexture(this.program, 'u_velocity_texture', 0, this.velocityTexture)
    this.bindUniforms(dt)

    // Bind transform feedback and buffer so we can write the updated positions
    // of the particles from the vertex shader to the output buffer.
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.transformFeedback)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.outputBuffers.data)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.outputBuffers.age)

    // Do not run the fragment shader; we do the particle updates in the vertex
    // shader only.
    gl.enable(gl.RASTERIZER_DISCARD)

    gl.beginTransformFeedback(gl.POINTS)
    gl.drawArrays(gl.POINTS, 0, this.numParticles)
    gl.endTransformFeedback()

    // Re-enable the fragment shader and unbind the transform feedback.
    gl.disable(gl.RASTERIZER_DISCARD)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
  }

  private resetBuffers(): void {
    if (this.inputBuffers) this.inputBuffers.destroy()
    if (this.outputBuffers) this.outputBuffers.destroy()

    const gl = this.program.gl
    this.inputBuffers = new ParticleBuffers(gl, this.numParticlesAllocate)
    this.outputBuffers = new ParticleBuffers(gl, this.numParticlesAllocate)

    // Initialise input buffer with random particle positions and ages.
    const initialCoordinates = this.generateInitialParticleData()
    const initialAges = this.generateInitialParticleAges()
    this.inputBuffers.initialise(initialCoordinates, initialAges)

    // Since we swap the buffers immediately in the update function, swap them
    // here too.
    this.swapBuffers()
  }

  private bindUniforms(dt: number): void {
    if (!this.velocityImage) {
      throw new Error(
        'Velocity image is not defined, no velocity image was set?'
      )
    }
    const gl = this.program.gl

    // Time step such that the propagation is proportional to the time spent on
    // this frame.
    gl.uniform1f(this.program.getUniformLocation('u_dt'), dt)

    // Uniforms for correctly scaling the velocity.
    gl.uniform1f(
      this.program.getUniformLocation('u_aspect_ratio'),
      this.height / this.width
    )
    gl.uniform2f(
      this.program.getUniformLocation('u_scale_in'),
      this.velocityImage.uScale,
      this.velocityImage.vScale
    )
    gl.uniform2f(
      this.program.getUniformLocation('u_offset_in'),
      this.velocityImage.uOffset,
      this.velocityImage.vOffset
    )
    gl.uniform1f(
      this.program.getUniformLocation('u_speed_factor'),
      this.speedCurve.factor
    )
    gl.uniform1f(
      this.program.getUniformLocation('u_speed_exponent'),
      this.speedCurve.exponent
    )

    // Select a range of particle indices to eliminate and replace by newly
    // generated positions.
    gl.uniform1f(this.program.getUniformLocation('u_max_age'), this.maxAge)
  }

  private swapBuffers(): void {
    const temp = this.inputBuffers
    this.inputBuffers = this.outputBuffers
    this.outputBuffers = temp
  }

  private generateInitialParticleData(): Float32Array {
    const data = new Float32Array(this.numParticles * 4)
    for (let i = 0; i < this.numParticles; i++) {
      const [x, y] = ParticlePropagator.randomClipCoords()
      const index = 4 * i
      data[index] = x
      data[index + 1] = y
      // Initialise velocity at almost, but not quite zero. If we initialise at
      // exactly 0, the shader logic will interpret this as "undefined speed".
      data[index + 2] = 1e-6
      data[index + 3] = 1e-6
    }
    return data
  }

  private generateInitialParticleAges(): Float32Array {
    const ages = new Float32Array(this.numParticles)
    for (let i = 0; i < this.numParticles; i++) {
      // Generate random ages such that not all particles die at the same time.
      ages[i] = Math.random() * this.maxAge
    }
    return ages
  }

  private static randomClipCoords(): [number, number] {
    const randomClipCoord = () => Math.random() * 2 - 1
    return [randomClipCoord(), randomClipCoord()]
  }
}
