import { expect, test } from 'vitest'
import { createWebGl2Context } from './utils'
import { FragmentShader, VertexShader } from '@/utils/shader'
import { ShaderProgram } from '@/utils/shader-program'

import exampleVertexShaderSource from './assets/example.vert.glsl?raw'
import exampleFragmentShaderSource from './assets/example.frag.glsl?raw'

test('creates and links a new shader program', async () => {
  const gl = createWebGl2Context()

  const vertexShader = new VertexShader(gl, 'void main() {}')
  const fragmentShader = new FragmentShader(gl, 'void main() {}')

  const program = new ShaderProgram(gl, vertexShader, fragmentShader)
  expect(program).toBeDefined()

  await program.link()
})

test('creates and links a new shader program with vertex shader error', async () => {
  const gl = createWebGl2Context()

  // Syntax error in vertex shader.
  const vertexShader = new VertexShader(gl, 'void main) {}')
  const fragmentShader = new FragmentShader(gl, 'void main() {}')

  const program = new ShaderProgram(gl, vertexShader, fragmentShader)

  await expect(async () => await program.link()).rejects.toThrow()
})

test('creates and links a new shader program with fragment shader error', async () => {
  const gl = createWebGl2Context()

  const vertexShader = new VertexShader(gl, 'void main) {}')
  // Syntax error in fragment shader.
  const fragmentShader = new FragmentShader(gl, 'void main) {}')

  const program = new ShaderProgram(gl, vertexShader, fragmentShader)

  await expect(async () => await program.link()).rejects.toThrow()
})

test('gets attribute locations', async () => {
  const gl = createWebGl2Context()

  const vertexShader = new VertexShader(gl, exampleVertexShaderSource)
  const fragmentShader = new FragmentShader(gl, exampleFragmentShaderSource)

  const program = new ShaderProgram(gl, vertexShader, fragmentShader)
  await program.link()

  const position = program.getAttributeLocation('a_position')
  const textureCoord = program.getAttributeLocation('a_tex_coord')

  expect(position).toBeDefined()
  expect(textureCoord).toBeDefined()

  expect(() => program.getAttributeLocation('non_existent')).toThrow()
})

test('gets uniform locations', async () => {
  const gl = createWebGl2Context()

  const vertexShader = new VertexShader(gl, exampleVertexShaderSource)
  const fragmentShader = new FragmentShader(gl, exampleFragmentShaderSource)

  const program = new ShaderProgram(gl, vertexShader, fragmentShader)
  await program.link()

  // Vertex shader uniform.
  const factor = program.getUniformLocation('u_factor')
  // Fragment shader uniforms.
  const texture = program.getUniformLocation('u_texture')
  const fadeAmount = program.getUniformLocation('u_fade_amount')

  expect(factor).toBeDefined()
  expect(texture).toBeDefined()
  expect(fadeAmount).toBeDefined()

  expect(() => program.getUniformLocation('non_existent')).toThrow()
})

test('uses a shader program', async () => {
  const gl = createWebGl2Context()

  const vertexShader = new VertexShader(gl, 'void main() {}')
  const fragmentShader = new FragmentShader(gl, 'void main() {}')

  const program = new ShaderProgram(gl, vertexShader, fragmentShader)

  // Trying to use an unlinked programn should throw.
  expect(() => program.use()).toThrow()

  await program.link()

  // It has been linked now, so this should not throw.
  program.use()
})
