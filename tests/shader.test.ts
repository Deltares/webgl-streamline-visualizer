import { expect, test } from 'vitest'

import { VertexShader, FragmentShader } from '@/utils/shader'

import { createWebGl2Context } from './utils'

test('tests shader constructor', () => {
  const gl = createWebGl2Context()

  const vertexShader = new VertexShader(gl, 'void main() {}')
  expect(vertexShader).toBeDefined()
  expect(vertexShader.shader).toBeDefined()

  const fragmentShader = new FragmentShader(gl, 'void main() {}')
  expect(fragmentShader).toBeDefined()
  expect(fragmentShader.shader).toBeDefined()

  // Compiling should run without errors (errors are checked at link time).
  vertexShader.compile()
  fragmentShader.compile()
})
