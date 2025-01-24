import { SpeedCurve } from '../utils/speedcurve'
import {
  ShaderProgram,
  bindAttribute,
  bindTexture
} from '../utils/shader-program'
import { VelocityImage } from '../utils/wms'

export class ParticlePropagator {
  public numEliminatePerSecond: number

  private program: ShaderProgram
  private width: number
  private height: number
  private numParticles: number
  private numParticlesAllocate: number
  private speedCurve: SpeedCurve
  private inputBuffer: WebGLBuffer | null
  private outputBuffer: WebGLBuffer | null
  private transformFeedback: WebGLTransformFeedback | null
  private velocityImage: VelocityImage | null
  private velocityTexture: WebGLTexture | null

  constructor(
    program: ShaderProgram,
    width: number,
    height: number,
    numParticles: number,
    numParticlesAllocate: number,
    numEliminatePerSecond: number,
    speedCurve: SpeedCurve
  ) {
    this.program = program
    this.width = width
    this.height = height

    this.numParticles = numParticles
    this.numParticlesAllocate = numParticlesAllocate
    this.numEliminatePerSecond = numEliminatePerSecond

    this.velocityImage = null
    this.velocityTexture = null
    this.speedCurve = speedCurve

    this.inputBuffer = null
    this.outputBuffer = null
    this.transformFeedback = null
  }

  get buffer(): WebGLBuffer {
    if (!this.outputBuffer) {
      throw new Error(
        'No output buffer defined, particle renderer was not initialised?'
      )
    }
    return this.outputBuffer
  }

  initialise(): void {
    const gl = this.program.gl

    this.resetBuffers()
    this.transformFeedback = gl.createTransformFeedback()

    // A bit hacky: start by swapping the input and output buffer, since the
    // buffer will be swapped again in the first call to the render function.
    this.swapBuffers()
  }

  destruct(): void {
    const gl = this.program.gl
    gl.deleteBuffer(this.inputBuffer)
    gl.deleteBuffer(this.outputBuffer)
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
    this.swapBuffers()
  }

  setSpeedCurve(speedCurve: SpeedCurve): void {
    this.speedCurve = speedCurve
  }

  update(dt: number): void {
    const gl = this.program.gl
    this.program.use()

    if (!this.inputBuffer || !this.outputBuffer) {
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
      this.inputBuffer,
      this.program.getAttributeLocation('a_position'),
      4
    )
    bindTexture(this.program, 'u_velocity_texture', 0, this.velocityTexture)
    this.bindUniforms(dt)

    // Bind transform feedback and buffer so we can write the updated positions
    // of the particles from the vertex shader to the output buffer.
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.transformFeedback)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.outputBuffer)

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
    const gl = this.program.gl
    if (this.inputBuffer) gl.deleteBuffer(this.inputBuffer)
    if (this.outputBuffer) gl.deleteBuffer(this.outputBuffer)

    this.inputBuffer = this.createParticleBuffer()
    this.outputBuffer = this.createParticleBuffer()

    // Initialise input buffer with random particle positions.
    this.initialiseInputBuffer()
  }

  private createParticleBuffer(): WebGLBuffer {
    const gl = this.program.gl
    // Create empty output buffer with buffer size of:
    //   4 (elements per vec4) * 4 (bytes per float) * numParticlesAllocate
    const numBytesBuffer = 4 * 4 * this.numParticlesAllocate
    const buffer = gl.createBuffer()
    if (buffer === null) {
      throw new Error('Failed to create particle buffer.')
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, numBytesBuffer, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    return buffer
  }

  private initialiseInputBuffer(): void {
    const gl = this.program.gl

    const initialCoords = this.createParticles()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inputBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, initialCoords)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private createParticles(): Float32Array {
    const coords = new Float32Array(this.numParticles * 4)
    for (let i = 0; i < this.numParticles; i++) {
      const [x, y] = ParticlePropagator.randomClipCoords()
      const index = 4 * i
      coords[index] = x
      coords[index + 1] = y
      // Initialise velocity at 0, this will be initialised on the first render.
      coords[index + 2] = 0
      coords[index + 3] = 0
    }
    return coords
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
    const indexEliminate = this.randomParticleIndex()
    const numEliminate = Math.floor(this.numEliminatePerSecond * dt)
    gl.uniform1i(
      this.program.getUniformLocation('u_index_eliminate_start'),
      indexEliminate
    )
    gl.uniform1i(
      this.program.getUniformLocation('u_index_eliminate_end'),
      indexEliminate + numEliminate
    )
  }

  private swapBuffers(): void {
    const temp = this.inputBuffer
    this.inputBuffer = this.outputBuffer
    this.outputBuffer = temp
  }

  private randomParticleIndex(): number {
    return Math.floor(Math.random() * this.numParticles)
  }

  private static randomClipCoords(): [number, number] {
    const randomClipCoord = () => Math.random() * 2 - 1
    return [randomClipCoord(), randomClipCoord()]
  }
}
