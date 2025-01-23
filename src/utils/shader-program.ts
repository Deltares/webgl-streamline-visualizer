import type { FragmentShader, VertexShader } from './shader'

/**
 * A WebGL2 shader program.
 *
 * This also contains the locations of all its active attributes and uniforms.
 */
export class ShaderProgram {
  readonly gl: WebGL2RenderingContext
  readonly program: WebGLProgram

  private vertexShader: VertexShader
  private fragmentShader: FragmentShader
  private isLinked: boolean
  private attributes: Map<string, number>
  private uniforms: Map<string, WebGLUniformLocation>

  constructor(
    gl: WebGL2RenderingContext,
    vertexShader: VertexShader,
    fragmentShader: FragmentShader,
    transformFeedbackVaryings?: string[]
  ) {
    // Create WebGL shader program and attach shaders.
    const program = gl.createProgram()
    if (program === null) {
      throw new Error('Failed to create shader program.')
    }
    gl.attachShader(program, vertexShader.shader)
    gl.attachShader(program, fragmentShader.shader)

    // Optionally bind transform feedback varyings.
    if (transformFeedbackVaryings) {
      gl.transformFeedbackVaryings(
        program,
        transformFeedbackVaryings,
        gl.SEPARATE_ATTRIBS
      )
    }

    this.gl = gl
    this.vertexShader = vertexShader
    this.fragmentShader = fragmentShader
    this.program = program
    this.isLinked = false
    this.attributes = new Map()
    this.uniforms = new Map()
  }

  destruct(): void {
    this.gl.deleteProgram(this.program)
  }

  async link(): Promise<void> {
    // Do not try to link more than once.
    if (this.isLinked) return

    // Make sure our shaders are compiled.
    this.vertexShader.compile()
    this.fragmentShader.compile()

    // Request program to link in a background thread, then wait for it to
    // complete asynchronously.
    this.gl.linkProgram(this.program)
    await this.waitForLinking()

    this.checkLinkStatus()

    this.updateActiveAttributes()
    this.updateActiveUniforms()

    this.isLinked = true
  }

  use(): void {
    if (!this.isLinked) {
      throw new Error('Link shader program before using it.')
    }
    this.gl.useProgram(this.program)
  }

  getAttributeLocation(name: string): number {
    if (!this.isLinked) {
      throw new Error('Link shader program before getting attribute locations.')
    }
    const location = this.attributes.get(name)
    if (location === undefined)
      throw new Error(`No attribute "${name}" exists.`)
    return location
  }

  getUniformLocation(name: string): WebGLUniformLocation {
    if (!this.isLinked) {
      throw new Error('Link shader program before getting uniform locations.')
    }
    const location = this.uniforms.get(name)
    if (location === undefined) throw new Error(`No uniform "${name}" exists.`)
    return location
  }

  private async waitForLinking(): Promise<void> {
    // If available, use the KHR_parallel_shader_compile extension to have a
    // non-blocking call for checking the link status.
    const ext = this.gl.getExtension('KHR_parallel_shader_compile')

    // If not available, just wait for linking synchronously by checking the
    // link status.
    if (!ext) {
      // Getting the link status will block until linking has been completed.
      this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)
      return
    }

    // Poll linking status every so often, allow the main thread to continue in
    // the mean time.
    const pollInterval = 20
    return new Promise(resolve => {
      const isComplete = () => {
        const isLinked = this.gl.getProgramParameter(
          this.program,
          ext.COMPLETION_STATUS_KHR
        ) as boolean
        if (isLinked) {
          resolve()
        } else {
          setTimeout(isComplete, pollInterval)
        }
      }
      isComplete()
    })
  }

  private checkLinkStatus(): void {
    const gl = this.gl
    // Always check link status, even when not in debug mode.
    const isSuccess = this.gl.getProgramParameter(
      this.program,
      gl.LINK_STATUS
    ) as boolean
    if (!isSuccess) {
      // Check whether the shaders have been successfully compiled. We do not
      // check for errors when compiling shaders, because we want to avoid
      // blocking the main thread.
      const checkShaderStatus = (
        shader: VertexShader | FragmentShader,
        name: string
      ) => {
        const inner = shader.shader
        const isSuccess = gl.getShaderParameter(
          inner,
          gl.COMPILE_STATUS
        ) as boolean
        if (!isSuccess) {
          const message = gl.getShaderInfoLog(inner)
          throw new Error(`Failed to compile ${name} shader: ${message}`)
        }
      }
      checkShaderStatus(this.vertexShader, 'vertex')
      checkShaderStatus(this.fragmentShader, 'fragment')

      const linkMessage = gl.getProgramInfoLog(this.program)
      throw new Error(`Failed to link program: ${linkMessage}`)
    }
  }

  private updateActiveAttributes(): void {
    const gl = this.gl
    const program = this.program

    // Add all active attributes for this program to a map.
    const numAttributes = gl.getProgramParameter(
      program,
      gl.ACTIVE_ATTRIBUTES
    ) as number
    for (let i = 0; i < numAttributes; i++) {
      const attribute = gl.getActiveAttrib(program, i)
      if (attribute === null) continue

      const location = gl.getAttribLocation(program, attribute.name)
      this.attributes.set(attribute.name, location)
    }
  }

  private updateActiveUniforms(): void {
    const gl = this.gl
    const program = this.program

    // Add all active uniforms for this program to a map.
    const numUniforms = gl.getProgramParameter(
      program,
      gl.ACTIVE_UNIFORMS
    ) as number
    for (let i = 0; i < numUniforms; i++) {
      const uniform = gl.getActiveUniform(program, i)
      if (uniform === null) continue

      const uniformLocation = gl.getUniformLocation(program, uniform.name)
      if (uniformLocation === null) continue
      this.uniforms.set(uniform.name, uniformLocation)
    }
  }
}

/**
 * Creates and fills a WebGL2 buffer.
 *
 * @param gl WebGL2 rendering context.
 * @param data values to fill the buffer with.
 * @returns filled WebGL2 buffer.
 */
export function createAndFillStaticBuffer(
  gl: WebGL2RenderingContext,
  data: ArrayBuffer
): WebGLBuffer {
  const buffer = gl.createBuffer()
  if (buffer === null) {
    throw new Error('Failed to create buffer.')
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)

  return buffer
}

/**
 * Binds an N-dimensional (floating-point) buffer to an attribute.
 *
 * @param gl WebGL2 rendering context.
 * @param buffer buffer to bind to the attribute.
 * @param attribute index of the attribute to bind.
 * @param numComponents number of components of the attribute (e.g. 2 for a vec2)
 */
export function bindAttribute(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
  attribute: number,
  numComponents: number
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(attribute)
  const type = gl.FLOAT
  const doNormalise = false
  // Use the default stride, i.e. assume that data of each component follow each other directly,
  // without any padding.
  const stride = 0
  const offset = 0
  gl.vertexAttribPointer(
    attribute,
    numComponents,
    type,
    doNormalise,
    stride,
    offset
  )
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
}

/**
 * Binds a texture to a texture unit and uniform.
 *
 * @param program Shader program.
 * @param uniform Name of the uniform to bind to.
 * @param unit Texture unit to use.
 * @param texture Texture to bind.
 */
export function bindTexture(
  program: ShaderProgram,
  uniform: string,
  unit: number,
  texture: WebGLTexture
): void {
  const gl = program.gl
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.uniform1i(program.getUniformLocation(uniform), unit)
}
