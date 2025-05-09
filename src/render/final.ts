import { Colormap } from '../utils/colormap'
import { createRectangleVertexArray } from '../utils/geometry'
import { ShaderProgram, bindTexture } from '../utils/shader-program'
import { VelocityImage } from '../utils/wms'

export interface BoundingBoxScaling {
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
}

export enum StreamlineStyle {
  LightParticlesOnMagnitude = 0,
  DarkParticlesOnMagnitude = 1,
  MagnitudeColoredParticles = 2,
  ColoredParticles = 3
}

export class FinalRenderer {
  private static readonly NUM_SEGMENTS_COLORMAP = 64

  public style: StreamlineStyle

  private program: ShaderProgram
  private positionBuffer: WebGLBuffer | null
  private texCoordBuffer: WebGLBuffer | null
  private vertexArray: WebGLVertexArrayObject | null
  private velocityImage: VelocityImage | null
  private colormap: Colormap
  private colormapTexture: WebGLTexture | null
  private velocityTexture: WebGLTexture | null

  constructor(
    program: ShaderProgram,
    style: StreamlineStyle,
    colormap: Colormap
  ) {
    this.program = program
    this.style = style
    this.positionBuffer = null
    this.texCoordBuffer = null
    this.vertexArray = null
    this.velocityImage = null
    this.colormap = colormap
    this.colormapTexture = null
    this.velocityTexture = null
  }

  initialise(): void {
    const gl = this.program.gl
    // In the final renderer, we need both a flipped and an unflipped vertical
    // texture coordinate. We need the flipped coordinate to obtain the velocity
    // field (which is loaded as an image), and the unflipped to coordinate to
    // render the particle texture (which is unflipped because it was rendered
    // in a framebuffer).
    const doFlipV = false
    const [positionBuffer, texCoordBuffer, vertexArray] =
      createRectangleVertexArray(
        this.program,
        -1.0,
        1.0,
        -1.0,
        1.0,
        doFlipV,
        'a_position',
        'a_tex_coord'
      )
    this.positionBuffer = positionBuffer
    this.texCoordBuffer = texCoordBuffer
    this.vertexArray = vertexArray

    this.colormapTexture = this.colormap.toTexture(
      gl,
      FinalRenderer.NUM_SEGMENTS_COLORMAP
    )
  }

  destruct(): void {
    const gl = this.program.gl
    gl.deleteBuffer(this.positionBuffer)
    gl.deleteBuffer(this.texCoordBuffer)
    gl.deleteVertexArray(this.vertexArray)
    gl.deleteTexture(this.colormapTexture)
    gl.deleteTexture(this.velocityTexture)
    this.program.destruct()
  }

  render(particleTexture: WebGLTexture, scaling: BoundingBoxScaling): void {
    const gl = this.program.gl
    this.program.use()

    gl.bindVertexArray(this.vertexArray)

    this.bindUniforms(scaling)
    this.bindTextures(particleTexture)

    // Make sure no framebuffer is bound so we render to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // Make sure that we blend with any previous renders on the frame buffer
    // appropriately.
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  setVelocityImage(velocityImage: VelocityImage) {
    this.velocityImage = velocityImage
    this.velocityTexture = velocityImage.toTexture(this.program.gl, false)
  }

  setColorMap(colormap: Colormap) {
    this.colormap = colormap
    this.colormapTexture = this.colormap.toTexture(
      this.program.gl,
      FinalRenderer.NUM_SEGMENTS_COLORMAP
    )
  }

  private bindUniforms(scaling: BoundingBoxScaling): void {
    if (!this.velocityImage) {
      throw new Error(
        'Velocity image is not defined, no velocity image was set?'
      )
    }
    const gl = this.program.gl

    // Scaling parameters for the bounding box.
    gl.uniform2f(
      this.program.getUniformLocation('u_bbox_scale'),
      scaling.scaleX,
      scaling.scaleY
    )
    gl.uniform2f(
      this.program.getUniformLocation('u_bbox_offset'),
      scaling.offsetX,
      scaling.offsetY
    )

    // Uniform to set the render style, its values correspond to the values
    // of the StreamlineStyle enum.
    gl.uniform1i(this.program.getUniformLocation('u_style'), this.style)

    // Uniforms for the start and end of the colormap.
    gl.uniform1f(
      this.program.getUniformLocation('u_colormap_start'),
      this.colormap.start
    )
    gl.uniform1f(
      this.program.getUniformLocation('u_colormap_end'),
      this.colormap.end
    )

    // Uniforms for correctly scaling the velocity.
    gl.uniform2f(
      this.program.getUniformLocation('u_scale'),
      this.velocityImage.uScale,
      this.velocityImage.vScale
    )
    gl.uniform2f(
      this.program.getUniformLocation('u_offset'),
      this.velocityImage.uOffset,
      this.velocityImage.vOffset
    )
  }

  private bindTextures(particleTexture: WebGLTexture): void {
    if (this.colormapTexture === null || this.velocityTexture === null) {
      throw new Error('Textures have not been initialised.')
    }
    bindTexture(this.program, 'u_particle_texture', 0, particleTexture)
    bindTexture(this.program, 'u_colormap_texture', 1, this.colormapTexture)
    bindTexture(this.program, 'u_velocity_texture', 2, this.velocityTexture)
  }
}
