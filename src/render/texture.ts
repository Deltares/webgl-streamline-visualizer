import { createRectangleVertexArray } from '../utils/geometry'
import { ShaderProgram, bindTexture } from '../utils/shader-program'

export class TextureRenderer {
  private program: ShaderProgram
  private positionBuffer: WebGLBuffer | null
  private texCoordBuffer: WebGLBuffer | null
  private vertexArray: WebGLVertexArrayObject | null
  private previousFramebuffer: WebGLFramebuffer
  private currentFramebuffer: WebGLFramebuffer

  constructor(program: ShaderProgram) {
    this.program = program

    this.positionBuffer = null
    this.texCoordBuffer = null
    this.vertexArray = null
    this.previousFramebuffer = this.program.gl.createFramebuffer()
    this.currentFramebuffer = this.program.gl.createFramebuffer()
  }

  initialise(): void {
    const [positionBuffer, texCoordBuffer, vertexArray] =
      createRectangleVertexArray(
        this.program,
        -1.0,
        1.0,
        -1.0,
        1.0,
        'a_position',
        'a_tex_coord'
      )
    this.positionBuffer = positionBuffer
    this.texCoordBuffer = texCoordBuffer
    this.vertexArray = vertexArray
  }

  destruct(): void {
    const gl = this.program.gl
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteBuffer(this.texCoordBuffer)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteFramebuffer(this.currentFramebuffer)
    this.program.destruct()
  }

  resetParticleTextures(
    previousParticleTexture: WebGLTexture,
    currentParticleTexture: WebGLTexture
  ): void {
    this.setupFramebuffer(this.previousFramebuffer, previousParticleTexture)
    this.setupFramebuffer(this.currentFramebuffer, currentParticleTexture)
  }

  render(
    inputTexture: WebGLTexture,
    fadeAmount: number,
    outputTexture: WebGLTexture | null
  ): void {
    const gl = this.program.gl
    this.program.use()

    gl.bindVertexArray(this.vertexArray)
    bindTexture(this.program, 'u_texture', 0, inputTexture)
    gl.uniform1f(this.program.getUniformLocation('u_fade_amount'), fadeAmount)
    // Flip y-axis if we are rendering to texture, as it is otherwise flipped
    // compared to rendering to canvas.
    gl.uniform1f(
      this.program.getUniformLocation('u_flip'),
      outputTexture ? -1.0 : 1.0
    )

    if (outputTexture) {
      this.enableRenderToTexture()
    } else {
      this.disableRenderToTexture()
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.bindVertexArray(null)
  }

  swapBuffers(): void {
    const temp = this.previousFramebuffer
    this.previousFramebuffer = this.currentFramebuffer
    this.currentFramebuffer = temp
  }

  private enableRenderToTexture(): void {
    const gl = this.program.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.currentFramebuffer)
  }

  private disableRenderToTexture(): void {
    const gl = this.program.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private setupFramebuffer(
    framebuffer: WebGLFramebuffer,
    texture: WebGLTexture
  ): void {
    const gl = this.program.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    )
    gl.clearColor(0.0, 0.0, 0.0, 0.0)
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}
