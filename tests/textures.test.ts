import { expect, test } from 'vitest'
import { createTexture } from '@/utils/textures'
import { createWebGl2Context, readTexture } from './utils'

test.each([1, 2, 3, 4, 5, 607])(
  'uploads tightly packed RGB rows at width %i and restores alignment',
  width => {
    const gl = createWebGl2Context()
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8)
    const bytes = Uint8Array.from(
      { length: width * 2 * 3 },
      (_, i) => i % 256
    )
    const texture = createTexture(gl, gl.NEAREST, bytes, width, 2)
    expect(gl.getParameter(gl.UNPACK_ALIGNMENT)).toBe(8)
    expect(gl.getError()).toBe(gl.NO_ERROR)
    const expected = new Uint8Array(width * 2 * 4)
    for (let pixel = 0; pixel < width * 2; pixel++) {
      expected.set(bytes.subarray(pixel * 3, pixel * 3 + 3), pixel * 4)
      expected[pixel * 4 + 3] = 255
    }
    expect(readTexture(gl, texture, width, 2)).toEqual(expected)
    gl.deleteTexture(texture)
  }
)

test('preserves RGBA bytes and the default unpack alignment', () => {
  const gl = createWebGl2Context()
  const bytes = new Uint8Array([12, 34, 56, 0, 78, 90, 123, 255])
  const texture = createTexture(gl, gl.NEAREST, bytes, 1, 2)
  expect(gl.getParameter(gl.UNPACK_ALIGNMENT)).toBe(4)
  expect(readTexture(gl, texture, 1, 2)).toEqual(bytes)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  gl.deleteTexture(texture)
})
