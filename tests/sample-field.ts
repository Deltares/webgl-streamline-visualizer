import { expect } from 'vitest'
import { CurvilinearLookupBuilder } from '@/geographic/curvilinear-lookup'
import {
  VelocityFieldTextures,
  type VelocityField
} from '@/geographic/velocity-field'
import { FragmentShader, VertexShader } from '@/utils/shader'
import { ShaderProgram } from '@/utils/shader-program'
import isMissingVelocity from '../src/shaders/is_missing_velocity.glsl?raw'
import sampleCurvilinear from '../src/shaders/sample_curvilinear.glsl?raw'
import sampleField from '../src/shaders/sample_field.glsl?raw'
import sampleVelocity from '../src/shaders/sample_velocity.glsl?raw'
import { createWebGl2Context } from './utils'

export type Sample = [number, number] | null

/**
 * Samples a field on the GPU at positions in degrees, with `sample_field` or,
 * if `isCoarse`, with `sample_field_coarse`.
 */
export async function sampleOnGpu(
  field: VelocityField,
  positions: [number, number][],
  isCoarse = false
): Promise<Sample[]> {
  const gl = createWebGl2Context()
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float is required for this test.')
  }
  const count = positions.length
  const width = Math.min(count, 2048)
  const height = Math.ceil(count / width)

  const textures = new VelocityFieldTextures(
    gl,
    await CurvilinearLookupBuilder.create(gl)
  )
  textures.setField(field)
  textures.prepare()

  const program = new ShaderProgram(
    gl,
    new VertexShader(
      gl,
      `#version 300 es
      void main() {
        vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
        gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
      }`
    ),
    new FragmentShader(
      gl,
      `#version 300 es
      precision highp float;
      precision highp int;
      precision highp sampler2D;
      ${isMissingVelocity}
      ${sampleVelocity}
      ${sampleCurvilinear}
      ${sampleField}
      uniform sampler2D u_positions;
      out vec4 color;
      void main() {
        vec2 lonlat = radians(texelFetch(u_positions, ivec2(gl_FragCoord.xy), 0).xy);
        vec2 velocity;
        bool valid = ${isCoarse ? 'sample_field_coarse' : 'sample_field'}(lonlat, velocity);
        color = vec4(velocity, valid ? 1.0 : 0.0, 1.0);
      }`
    )
  )
  await program.link()
  program.use()

  const data = new Float32Array(2 * width * height)
  data.set(positions.flat())
  const positionTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, positionTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, width, height)
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RG, gl.FLOAT, data)

  const target = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, target)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height)
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer())
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    target,
    0
  )
  expect(gl.checkFramebufferStatus(gl.FRAMEBUFFER)).toBe(
    gl.FRAMEBUFFER_COMPLETE
  )

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, positionTexture)
  gl.uniform1i(program.getUniformLocation('u_positions'), 0)
  textures.bind(program, 1)

  gl.viewport(0, 0, width, height)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  const pixels = new Float32Array(4 * width * height)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels)
  expect(gl.getError()).toBe(gl.NO_ERROR)

  return positions.map((_, i) =>
    pixels[4 * i + 2]! > 0.5 ? [pixels[4 * i]!, pixels[4 * i + 1]!] : null
  )
}
