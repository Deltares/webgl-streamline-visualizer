type ShaderType =
  | WebGL2RenderingContext['VERTEX_SHADER']
  | WebGL2RenderingContext['FRAGMENT_SHADER']

class Shader {
  readonly gl: WebGL2RenderingContext
  readonly shader: WebGLShader

  private hasCompileAttempt: boolean

  constructor(gl: WebGL2RenderingContext, type: ShaderType, source: string) {
    const shader = gl.createShader(type)
    if (!shader) {
      throw new Error('Failed to create WebGL shader.')
    }
    gl.shaderSource(shader, source)

    this.gl = gl
    this.shader = shader
    this.hasCompileAttempt = false
  }

  destruct(): void {
    this.gl.deleteShader(this.shader)
  }

  compile(): void {
    // Do not try to compile more than once.
    if (this.hasCompileAttempt) return

    this.gl.compileShader(this.shader)
    this.hasCompileAttempt = true
    // Do not check errors here, as checking the compile status blocks the main
    // thread until compilation is complete. Instead, the compile status (and
    // any possible errors) will be checked when this shader is linked into a
    // shader program.
  }
}

export class VertexShader extends Shader {
  constructor(gl: WebGL2RenderingContext, source: string) {
    super(gl, gl.VERTEX_SHADER, source)
  }
}

export class FragmentShader extends Shader {
  constructor(gl: WebGL2RenderingContext, source: string) {
    super(gl, gl.FRAGMENT_SHADER, source)
  }
}
