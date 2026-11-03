import { expect, test } from 'vitest'
import {
  RegularVelocityChunk,
  type RegularGrid
} from '@/geographic/regular-velocity-chunk'
import { FragmentShader, VertexShader } from '@/utils/shader'
import { ShaderProgram } from '@/utils/shader-program'
import { VelocityImage } from '@/utils/velocity-image'
import isMissingVelocity from '../src/shaders/is_missing_velocity.glsl?raw'
import sampleVelocity from '../src/shaders/sample_velocity.glsl?raw'
import { createWebGl2Context } from './utils'

type Sample = [number, number] | null

// A small deterministic random number generator, so failures reproduce.
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function buildField(
  grid: RegularGrid,
  f: (column: number, row: number) => [number, number] | null
): { u: Float32Array; v: Float32Array } {
  const u = new Float32Array(grid.nx * grid.ny)
  const v = new Float32Array(grid.nx * grid.ny)
  for (let row = 0; row < grid.ny; row++) {
    for (let column = 0; column < grid.nx; column++) {
      const value = f(column, row)
      u[row * grid.nx + column] = value?.[0] ?? NaN
      v[row * grid.nx + column] = value?.[1] ?? NaN
    }
  }
  return { u, v }
}

/** Samples a chunk on the GPU at positions in degrees. */
async function sampleOnGpu(
  chunk: RegularVelocityChunk,
  positions: [number, number][]
): Promise<Sample[]> {
  const gl = createWebGl2Context()
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float is required for this test.')
  }
  const count = positions.length

  const vertex = new VertexShader(
    gl,
    `#version 300 es
    void main() {
      vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
      gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
    }`
  )
  const fragment = new FragmentShader(
    gl,
    `#version 300 es
    precision highp float;
    precision highp int;
    uniform sampler2D u_positions;
    uniform sampler2D u_values;
    uniform VelocityGrid u_grid;
    out vec4 color;
    void main() {
      vec2 lonlat = radians(texelFetch(u_positions, ivec2(gl_FragCoord.x, 0), 0).xy);
      vec2 velocity;
      bool valid = sample_velocity(u_values, u_grid, lonlat, velocity);
      color = vec4(velocity, valid ? 1.0 : 0.0, 1.0);
    }`
      // Struct and function declarations must precede their use.
      .replace(
        'uniform sampler2D u_positions;',
        `${isMissingVelocity}\n${sampleVelocity}\nuniform sampler2D u_positions;`
      )
  )
  const program = new ShaderProgram(gl, vertex, fragment)
  await program.link()
  program.use()

  // Positions as an RG32F texture of count × 1.
  const positionTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, positionTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, count, 1)
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    count,
    1,
    gl.RG,
    gl.FLOAT,
    Float32Array.from(positions.flat())
  )

  const valueTexture = chunk.createTexture(gl)

  // RGBA32F render target of count × 1.
  const target = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, target)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, count, 1)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
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
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, valueTexture)
  gl.uniform1i(program.getUniformLocation('u_values'), 1)
  chunk.setUniforms(program, 'u_grid')

  gl.viewport(0, 0, count, 1)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  const pixels = new Float32Array(4 * count)
  gl.readPixels(0, 0, count, 1, gl.RGBA, gl.FLOAT, pixels)
  expect(gl.getError()).toBe(gl.NO_ERROR)

  program.destruct()
  gl.deleteTexture(positionTexture)
  gl.deleteTexture(valueTexture)
  gl.deleteTexture(target)
  gl.deleteFramebuffer(framebuffer)

  return positions.map((_, i) =>
    pixels[4 * i + 2] === 1
      ? [pixels[4 * i] as number, pixels[4 * i + 1] as number]
      : null
  )
}

function expectSamplesClose(
  actual: Sample[],
  expected: Sample[],
  tolerance: number
): void {
  expect(actual.length).toBe(expected.length)
  actual.forEach((sample, i) => {
    const reference = expected[i]
    if (reference === null || reference === undefined) {
      expect(sample, `sample ${i} should be missing`).toBeNull()
      return
    }
    expect(sample, `sample ${i} should be valid`).not.toBeNull()
    expect(Math.abs(sample![0] - reference[0]), `u of sample ${i}`).toBeLessThan(
      tolerance
    )
    expect(Math.abs(sample![1] - reference[1]), `v of sample ${i}`).toBeLessThan(
      tolerance
    )
  })
}

// Tempo's IFS Europe grid: 0.25°, rows from north to south.
const europe: RegularGrid = {
  crs: 'EPSG:4326',
  nx: 281,
  ny: 169,
  x0: -25,
  y0: 72,
  dx: 0.25,
  dy: -0.25
}

// Bilinear interpolation reproduces a field that is linear in lon and lat.
const linear = (lon: number, lat: number): [number, number] => [
  2 + 0.1 * lon - 0.05 * lat,
  -1 + 0.03 * lon + 0.2 * lat
]

function cellCentre(grid: RegularGrid, column: number, row: number) {
  return [grid.x0 + column * grid.dx, grid.y0 + row * grid.dy] as const
}

test('reproduces a linear field on a lon/lat grid, on the CPU and the GPU', async () => {
  const { u, v } = buildField(europe, (c, r) =>
    linear(...cellCentre(europe, c, r))
  )
  const chunk = RegularVelocityChunk.fromComponents(europe, u, v)

  const random = createRandom(1)
  const positions: [number, number][] = []
  for (let i = 0; i < 200; i++) {
    positions.push([-25 + random() * 70, 30 + random() * 42])
  }
  const expected = positions.map(([lon, lat]) => linear(lon, lat))

  expectSamplesClose(positions.map(p => chunk.sample(...p)), expected, 1e-4)
  expectSamplesClose(await sampleOnGpu(chunk, positions), expected, 1e-3)
})

test('rows run from north to south when dy is negative', () => {
  const { u, v } = buildField(europe, (_, r) => [r, 0])
  const chunk = RegularVelocityChunk.fromComponents(europe, u, v)
  expect(chunk.sample(0, 72)![0]).toBeCloseTo(0)
  expect(chunk.sample(0, 30)![0]).toBeCloseTo(168)
})

test('covers the domain up to the outer cell edges and no further', async () => {
  const { u, v } = buildField(europe, () => [1, 1])
  const chunk = RegularVelocityChunk.fromComponents(europe, u, v)
  // Outer edges: west -25.125, east 45.125, north 72.125, south 29.875.
  const positions: [number, number][] = [
    [-25.1, 50],
    [-25.15, 50],
    [45.1, 50],
    [45.15, 50],
    [0, 72.1],
    [0, 72.15],
    [0, 29.9],
    [0, 29.85],
    [170, 50]
  ]
  const expected: Sample[] = [[1, 1], null, [1, 1], null, [1, 1], null, [1, 1], null, null]
  expectSamplesClose(positions.map(p => chunk.sample(...p)), expected, 1e-6)
  expectSamplesClose(await sampleOnGpu(chunk, positions), expected, 1e-5)
})

test('leaves out missing neighbours and is missing where the nearest cell is', async () => {
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 3, ny: 3, x0: 0, y0: 2, dx: 1, dy: -1 }
  // Cell (1, 1), the centre, is missing.
  const { u, v } = buildField(grid, (c, r) =>
    c === 1 && r === 1 ? null : [c + 10 * r, -c]
  )
  const chunk = RegularVelocityChunk.fromComponents(grid, u, v)
  const positions: [number, number][] = [
    [1, 1], // centre of the missing cell
    [1.4, 1.4], // nearest cell is the missing one
    [0.4, 1.4], // nearest is (0, 1); neighbours (1, 0), (0, 0) valid, (1, 1) missing
    [0, 2] // centre of a valid cell
  ]
  // At (0.4, 1.4): column 0.4, row 0.6. Valid neighbours (0,0) w=0.6·0.4, (1,0) w=0.4·0.4, (0,1) w=0.6·0.6.
  const w00 = 0.6 * 0.4
  const w10 = 0.4 * 0.4
  const w01 = 0.6 * 0.6
  const sum = w00 + w10 + w01
  const expected: Sample[] = [
    null,
    null,
    [(w00 * 0 + w10 * 1 + w01 * 10) / sum, (w00 * 0 + w10 * -1 + w01 * 0) / sum],
    [0, 0]
  ]
  expectSamplesClose(positions.map(p => chunk.sample(...p)), expected, 1e-9)
  expectSamplesClose(await sampleOnGpu(chunk, positions), expected, 1e-5)
})

test('wraps a global grid across the antimeridian', async () => {
  // Global 1° grid from 0° E, as many models deliver it.
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 360, ny: 181, x0: 0, y0: 90, dx: 1, dy: -1 }
  const { u, v } = buildField(grid, c => [c, 0])
  const chunk = RegularVelocityChunk.fromComponents(grid, u, v)
  expect(chunk.wraps).toBe(true)
  // Halfway between column 359 (u = 359) and column 0 (u = 0).
  const positions: [number, number][] = [
    [-0.5, 10],
    [359.5, 10],
    [-180, 10],
    [180, 10]
  ]
  const expected: Sample[] = [[179.5, 0], [179.5, 0], [180, 0], [180, 0]]
  expectSamplesClose(positions.map(p => chunk.sample(...p)), expected, 1e-6)
  // u jumps by 359 between columns 359 and 0, which magnifies float32's
  // position error (about 1e-5 columns at 360° in radians).
  expectSamplesClose(await sampleOnGpu(chunk, positions), expected, 359 * 1e-4)
})

test('accepts a domain across the antimeridian and longitudes in any range', () => {
  // 170° E to 170° W.
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 21, ny: 1, x0: 170, y0: 0, dx: 1, dy: -1 }
  const { u, v } = buildField(grid, c => [c, 0])
  const chunk = RegularVelocityChunk.fromComponents(grid, u, v)
  expect(chunk.wraps).toBe(false)
  expect(chunk.sample(-175, 0)![0]).toBeCloseTo(15)
  expect(chunk.sample(185, 0)![0]).toBeCloseTo(15)
  expect(chunk.sample(165, 0)).toBeNull()
})

test('samples EPSG:3857 grids, such as FEWS tiles', async () => {
  // Zoom 6 XYZ tile (33, 21) at 256 px, as FEWS would serve it.
  const worldSize = 2 * Math.PI * 6378137
  const tileSize = worldSize / 2 ** 6
  const pixel = tileSize / 256
  const west = -worldSize / 2 + 33 * tileSize
  const north = worldSize / 2 - 21 * tileSize
  const grid: RegularGrid = {
    crs: 'EPSG:3857',
    nx: 256,
    ny: 256,
    x0: west + pixel / 2,
    y0: north - pixel / 2,
    dx: pixel,
    dy: -pixel
  }
  // Linear in Mercator metres.
  const mercator = (x: number, y: number): [number, number] => [
    1 + (x - west) / tileSize,
    -2 + (north - y) / tileSize
  ]
  const { u, v } = buildField(grid, (c, r) =>
    mercator(grid.x0 + c * grid.dx, grid.y0 + r * grid.dy)
  )
  const chunk = RegularVelocityChunk.fromComponents(grid, u, v)

  const toLonLat = (x: number, y: number): [number, number] => [
    (x / 6378137) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI)
  ]
  const random = createRandom(2)
  const points: [number, number][] = []
  for (let i = 0; i < 100; i++) {
    points.push([west + (0.02 + 0.96 * random()) * tileSize, north - (0.02 + 0.96 * random()) * tileSize])
  }
  const positions = points.map(([x, y]) => toLonLat(x, y))
  const expected = points.map(([x, y]) => mercator(x, y))

  expectSamplesClose(positions.map(p => chunk.sample(...p)), expected, 1e-6)
  // Float32 Mercator metres resolve about 2 m; the tile pixel is 2.4 km.
  expectSamplesClose(await sampleOnGpu(chunk, positions), expected, 2e-3)
})

test('RG8 and float chunks agree within the quantisation step', async () => {
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 20, ny: 10, x0: 0, y0: 50, dx: 0.5, dy: -0.5 }
  const random = createRandom(3)
  const { u, v } = buildField(grid, () =>
    random() < 0.15 ? null : [-20 + 40 * random(), -5 + 10 * random()]
  )
  const floatChunk = RegularVelocityChunk.fromComponents(grid, u, v)
  const imageChunk = RegularVelocityChunk.fromImage(
    grid,
    VelocityImage.fromComponents(u, v, grid.nx, grid.ny)
  )

  // Stay away from the boundaries between nearest cells, where float32 and
  // float64 may disagree on which cell is nearest.
  const positions: [number, number][] = []
  for (let i = 0; i < 300; i++) {
    const column = Math.floor(random() * grid.nx)
    const row = Math.floor(random() * grid.ny)
    const offset = () => (random() < 0.5 ? -1 : 1) * (0.02 + 0.46 * random())
    positions.push([
      grid.x0 + (column + offset()) * grid.dx,
      grid.y0 + (row + offset()) * grid.dy
    ])
  }

  const reference = positions.map(p => floatChunk.sample(...p))
  const quantisationStep = 40 / 254
  expectSamplesClose(positions.map(p => imageChunk.sample(...p)), reference, quantisationStep)
  // Values change by up to 40 per cell; float32 positions are good to 1e-5 cells.
  expectSamplesClose(await sampleOnGpu(floatChunk, positions), reference, 40 * 1e-4)
  expectSamplesClose(await sampleOnGpu(imageChunk, positions), reference, quantisationStep)
})

test('rejects invalid grids and mismatched values', () => {
  const values = new Float32Array(4)
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 2, ny: 2, x0: 0, y0: 0, dx: 1, dy: -1 }
  expect(() => RegularVelocityChunk.fromComponents({ ...grid, dx: -1 }, values, values)).toThrow()
  expect(() => RegularVelocityChunk.fromComponents({ ...grid, dy: 0 }, values, values)).toThrow()
  expect(() => RegularVelocityChunk.fromComponents({ ...grid, nx: 1.5 }, values, values)).toThrow()
  expect(() => RegularVelocityChunk.fromComponents(grid, values, new Float32Array(3))).toThrow()
  expect(() =>
    RegularVelocityChunk.fromImage(grid, VelocityImage.fromComponents([1, 2, 3], [1, 2, 3], 3, 1))
  ).toThrow()
})

test('maxVelocity ignores missing cells', () => {
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 3, ny: 1, x0: 0, y0: 0, dx: 1, dy: -1 }
  const chunk = RegularVelocityChunk.fromComponents(grid, [-7, NaN, 3], [1, 100, -2])
  expect(chunk.maxVelocity()).toEqual([7, 2])
})
