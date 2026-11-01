import {
  ShaderProgram,
  bindAttribute,
  createAndFillStaticBuffer
} from '../utils/shader-program'

/**
 * Fades the particle trail texture in place.
 *
 * The trail texture is attached to this renderer's framebuffer. Fading draws a
 * full-screen quad that subtracts the fade amount from the alpha channel
 * through blending, so the trail texture does not need to be read in a shader
 * and no second texture is required.
 */
export class FadeRenderer {
  private readonly program: ShaderProgram
  private positionBuffer: WebGLBuffer | null
  private vertexArray: WebGLVertexArrayObject | null
  private readonly framebuffer: WebGLFramebuffer

  constructor(program: ShaderProgram) {
    this.program = program

    this.positionBuffer = null
    this.vertexArray = null
    this.framebuffer = this.program.gl.createFramebuffer()
  }

  initialise(): void {
    const gl = this.program.gl
    const vertexArray = gl.createVertexArray()
    if (vertexArray === null) {
      throw new Error('Failed to create vertex array.')
    }
    gl.bindVertexArray(vertexArray)

    // Full-screen quad, drawn as a triangle strip.
    const positions = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1])
    const positionBuffer = createAndFillStaticBuffer(gl, positions)
    bindAttribute(
      gl,
      positionBuffer,
      this.program.getAttributeLocation('a_position'),
      2
    )

    gl.bindVertexArray(null)

    this.positionBuffer = positionBuffer
    this.vertexArray = vertexArray
  }

  destruct(): void {
    const gl = this.program.gl
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteFramebuffer(this.framebuffer)
    this.program.destruct()
  }

  setTrailTexture(trailTexture: WebGLTexture): void {
    const gl = this.program.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      trailTexture,
      0
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // The texture's storage is uninitialised, so clear it.
    this.clear()
  }

  clear(): void {
    const gl = this.program.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.clearColor(0.0, 0.0, 0.0, 0.0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Fades the trail texture by the specified alpha amount.
   *
   * This leaves the trail texture's framebuffer bound, so particles can be
   * rendered into it afterwards.
   */
  render(fadeAmount: number): void {
    const gl = this.program.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    if (fadeAmount <= 0) return

    this.program.use()
    gl.bindVertexArray(this.vertexArray)
    gl.uniform1f(this.program.getUniformLocation('u_fade_amount'), fadeAmount)

    // Compute destination - source: colour is unchanged since the source
    // colour is zero, alpha is decreased by the fade amount and clamped to 0.
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT)
    gl.blendFunc(gl.ONE, gl.ONE)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.blendEquation(gl.FUNC_ADD)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }
}
