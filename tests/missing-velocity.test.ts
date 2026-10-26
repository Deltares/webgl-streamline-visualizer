import { expect, test } from 'vitest'
import { VertexShader, FragmentShader } from '@/utils/shader'
import { ShaderProgram } from '@/utils/shader-program'
import { createWebGl2Context } from './utils'
import isMissingVelocity from '../src/shaders/is_missing_velocity.glsl?raw'

test('recognizes FEWS sentinels and alpha masks without discarding valid extrema', async () => {
  const gl = createWebGl2Context()
  const vertex = new VertexShader(gl, `#version 300 es
    void main() {
      gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
      gl_PointSize = 1.0;
    }`)
  const fragment = new FragmentShader(gl, `#version 300 es
    precision highp float;
    uniform vec4 u_raw;
    out vec4 color;
    ${isMissingVelocity}
    void main() {
      color = vec4(is_missing_velocity(u_raw) ? 1.0 : 0.0, 0.0, 0.0, 1.0);
    }`)
  const program = new ShaderProgram(gl, vertex, fragment)
  await program.link()
  program.use()
  gl.viewport(0, 0, 1, 1)
  for (const [r, g, a, expected] of [
    [255, 255, 255, 255],
    [12, 34, 0, 255],
    [255, 34, 255, 0],
    [12, 255, 255, 0],
    [12, 34, 128, 0]
  ] as const) {
    gl.uniform4f(program.getUniformLocation('u_raw'), r / 255, g / 255, 0, a / 255)
    gl.drawArrays(gl.POINTS, 0, 1)
    const pixel = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    expect(pixel[0]).toBe(expected)
  }
  expect(gl.getError()).toBe(gl.NO_ERROR)
  program.destruct()
})
