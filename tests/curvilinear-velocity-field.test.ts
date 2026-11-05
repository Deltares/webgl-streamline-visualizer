import { expect, test } from 'vitest'
import { CurvilinearLookupBuilder } from '@/geographic/curvilinear-lookup'
import {
  CurvilinearGrid,
  CurvilinearVelocityField
} from '@/geographic/curvilinear-velocity-field'
import { mercatorBoundsOf } from '@/geographic/domain-mesh'
import { RegularVelocityChunk } from '@/geographic/regular-velocity-chunk'
import {
  NestedVelocityField,
  VelocityFieldTextures
} from '@/geographic/velocity-field'
import { sampleOnGpu } from './sample-field'
import { createWebGl2Context } from './utils'

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** A grid of 0.01° turned 30° about (3° E, 52° N), as in Tempo's tests. */
function turnedPoint(column: number, row: number): [number, number] {
  const angle = (30 * Math.PI) / 180
  const x = column * 0.01
  const y = -row * 0.01
  return [
    3 + x * Math.cos(angle) - y * Math.sin(angle),
    52 + x * Math.sin(angle) + y * Math.cos(angle)
  ]
}

function buildGrid(
  nx: number,
  ny: number,
  point: (column: number, row: number) => [number, number] | null,
  lookupSize = 512
): CurvilinearGrid {
  const lon = new Float32Array(nx * ny)
  const lat = new Float32Array(nx * ny)
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const p = point(column, row)
      lon[row * nx + column] = p?.[0] ?? NaN
      lat[row * nx + column] = p?.[1] ?? NaN
    }
  }
  return new CurvilinearGrid(nx, ny, lon, lat, { lookupSize })
}

/**
 * A field of u = column and v = row: bilinear interpolation reproduces them,
 * so a sample says exactly where on the grid it was taken.
 */
function positionField(grid: CurvilinearGrid): CurvilinearVelocityField {
  const u = new Float32Array(grid.nx * grid.ny)
  const v = new Float32Array(grid.nx * grid.ny)
  for (let i = 0; i < u.length; i++) {
    u[i] = i % grid.nx
    v[i] = Math.floor(i / grid.nx)
  }
  return new CurvilinearVelocityField(grid, u, v)
}

/**
 * A grid like a coastal model's: cells shrink by a factor of about 80 towards
 * one side, the grid lines curve, and part of it has no coordinates.
 */
function coastalGrid(lookupSize = 1024): CurvilinearGrid {
  const nx = 300
  const ny = 200
  const position = (i: number, n: number) =>
    (Math.exp((4.4 * i) / (n - 1)) - 1) / (Math.exp(4.4) - 1)
  return buildGrid(
    nx,
    ny,
    (column, row) => {
      if (column > 200 && row > 60 && row < 110) return null
      const s = position(column, nx)
      const t = position(row, ny)
      const bend = 0.4 * Math.sin(2.5 * s)
      return [3 + 2.5 * s + 0.3 * t, 52 + 1.5 * t + bend]
    },
    lookupSize
  )
}

function randomPositions(
  grid: CurvilinearGrid,
  count: number,
  seed: number
): [number, number][] {
  const random = createRandom(seed)
  return Array.from({ length: count }, () => [
    grid.west + random() * (grid.east - grid.west),
    grid.south + random() * (grid.north - grid.south)
  ])
}

test('locates points in a turned grid', () => {
  const grid = buildGrid(40, 30, turnedPoint)
  for (const [column, row] of [
    [0, 0],
    [12.25, 7.5],
    [38.9, 28.1],
    [39, 29]
  ] as const) {
    const location = grid.locate(...turnedPoint(column, row))
    expect(location).not.toBeNull()
    expect(location!.column + location!.fx).toBeCloseTo(column, 2)
    expect(location!.row + location!.fy).toBeCloseTo(row, 2)
  }
  expect(grid.locate(...turnedPoint(-0.5, 3))).toBeNull()
  expect(grid.locate(...turnedPoint(10, 29.5))).toBeNull()
})

test('interpolates bilinearly within a quad', () => {
  const field = positionField(buildGrid(20, 10, turnedPoint))
  const sample = field.sample(...turnedPoint(4.25, 6.5))
  expect(sample![0]).toBeCloseTo(4.25, 2)
  expect(sample![1]).toBeCloseTo(6.5, 2)
})

test('cells without coordinates drop their quads', () => {
  const grid = buildGrid(10, 10, (column, row) =>
    column === 5 && row === 5 ? null : turnedPoint(column, row)
  )
  expect(grid.locate(...turnedPoint(4.5, 4.5))).toBeNull()
  expect(grid.locate(...turnedPoint(2.5, 2.5))).not.toBeNull()
})

test('rejects unusable grids and values', () => {
  expect(
    () => new CurvilinearGrid(3, 2, new Array(6).fill(0), new Array(5).fill(0))
  ).toThrow()
  expect(
    () =>
      new CurvilinearGrid(2, 2, new Array(4).fill(NaN), new Array(4).fill(NaN))
  ).toThrow('complete quad')
  expect(
    () =>
      new CurvilinearGrid(3, 2, [0, 100, 200, 0, 100, 200], [0, 0, 0, 1, 1, 1])
  ).toThrow('180°')
  expect(
    () => new CurvilinearVelocityField(buildGrid(3, 3, turnedPoint), [0], [0])
  ).toThrow()
  const field = positionField(buildGrid(3, 3, turnedPoint))
  expect(() => new NestedVelocityField([field, field, field])).toThrow()
  expect(() => new NestedVelocityField([])).toThrow()
})

test('a grid may cross the antimeridian', async () => {
  const grid = buildGrid(21, 11, (column, row) => {
    const lon = 175 + column * 0.5
    return [lon > 180 ? lon - 360 : lon, 10 + row * 0.5]
  })
  expect(grid.west).toBe(175)
  expect(grid.east).toBe(185)

  const field = positionField(grid)
  const expected: [number, number] = [14.5, 3.25]
  for (const lon of [-177.75, 182.25]) {
    const sample = field.sample(lon, 11.625)
    expect(sample![0]).toBeCloseTo(expected[0], 3)
    expect(sample![1]).toBeCloseTo(expected[1], 3)
  }

  const [gpu] = await sampleOnGpu(field, [[-177.75, 11.625]])
  expect(gpu![0]).toBeCloseTo(expected[0], 2)
  expect(gpu![1]).toBeCloseTo(expected[1], 2)
})

test('GPU sampling matches the CPU on a turned grid with a hole', async () => {
  const grid = buildGrid(60, 40, (column, row) =>
    column >= 20 && column < 30 && row >= 10 && row < 15
      ? null
      : turnedPoint(column, row)
  )
  const field = positionField(grid)
  const positions = randomPositions(grid, 4000, 1)
  const gpu = await sampleOnGpu(field, positions)

  let numInside = 0
  positions.forEach(([lon, lat], i) => {
    const cpu = field.sample(lon, lat)
    expect(gpu[i] === null, `presence of sample ${i}`).toBe(cpu === null)
    if (cpu === null) return
    numInside++
    expect(Math.abs(gpu[i]![0] - cpu[0])).toBeLessThan(1e-2)
    expect(Math.abs(gpu[i]![1] - cpu[1])).toBeLessThan(1e-2)
  })
  expect(numInside).toBeGreaterThan(1000)
})

test('finds the same quad as the CPU where cells are much smaller than a lookup texel', async () => {
  const grid = coastalGrid()
  const field = positionField(grid)

  // Half of the points in the area of the smallest cells.
  const random = createRandom(2)
  const positions = randomPositions(grid, 10000, 3)
  const fine: [number, number][] = []
  while (fine.length < 10000) {
    const column = 1 + random() * 80
    const row = 1 + random() * 197
    if (column > 200 && row > 60 && row < 110) continue
    const nx = grid.nx
    const c = Math.floor(column)
    const r = Math.floor(row)
    const f = column - c
    const g = row - r
    const at = (dc: number, dr: number) => (r + dr) * nx + c + dc
    const mix = (a: Float64Array) =>
      (1 - f) * (1 - g) * a[at(0, 0)]! +
      f * (1 - g) * a[at(1, 0)]! +
      (1 - f) * g * a[at(0, 1)]! +
      f * g * a[at(1, 1)]!
    fine.push([mix(grid.lon), mix(grid.lat)])
  }
  positions.push(...fine)

  const gpu = await sampleOnGpu(field, positions)
  let numInside = 0
  let numSameCell = 0
  let numMissed = 0
  positions.forEach(([lon, lat], i) => {
    const cpu = field.sample(lon, lat)
    if (cpu === null) return
    numInside++
    const sample = gpu[i]
    if (!sample) {
      numMissed++
      return
    }
    // Within a hundredth of a cell of the CPU's position on the grid. This
    // tolerance also allows for the two sides of a shared quad edge.
    if (
      Math.abs(sample[0] - cpu[0]) < 0.02 &&
      Math.abs(sample[1] - cpu[1]) < 0.02
    ) {
      numSameCell++
    }
  })
  expect(numInside).toBeGreaterThan(10000)
  expect(numSameCell / numInside).toBeGreaterThanOrEqual(0.999)
  expect(numMissed / numInside).toBeLessThan(0.001)
})

test('finds quads behind a speckled mask, far from their lookup seed', async () => {
  // Lookup texels of about 8 × 8 cells, and many small holes for a walk to hit.
  const random = createRandom(11)
  const holes = new Set<number>()
  for (let i = 0; i < 1500; i++) holes.add(Math.floor(random() * 200 * 200))
  const grid = buildGrid(
    200,
    200,
    (column, row) =>
      holes.has(row * 200 + column)
        ? null
        : [3 + column * 0.005 + row * 0.001, 52 + row * 0.005 - column * 0.001],
    128
  )
  const field = positionField(grid)
  const positions = randomPositions(grid, 20000, 12)
  const gpu = await sampleOnGpu(field, positions)

  let numInside = 0
  let numMissed = 0
  positions.forEach(([lon, lat], i) => {
    if (field.sample(lon, lat) === null) return
    numInside++
    if (gpu[i] === null) numMissed++
  })
  expect(numInside).toBeGreaterThan(5000)
  expect(numMissed / numInside).toBeLessThan(0.001)
})

test('a position is missing where its nearest corner is', async () => {
  const grid = buildGrid(4, 4, (column, row) => [column, 50 + row])
  const u = new Float32Array(16).fill(10)
  const v = new Float32Array(16).fill(-5)
  // Cell (1, 1) has coordinates, but no value.
  u[5] = NaN
  v[5] = NaN
  const field = new CurvilinearVelocityField(grid, u, v)

  const positions: [number, number][] = [
    [1.25, 51.25], // nearest corner is the missing cell
    [1.75, 51.75], // valid corners, renormalised
    [2.5, 52.5]
  ]
  const cpu = positions.map(([lon, lat]) => field.sample(lon, lat))
  expect(cpu[0]).toBeNull()
  expect(cpu[1]![0]).toBeCloseTo(10, 5)
  expect(cpu[2]![1]).toBeCloseTo(-5, 5)

  const gpu = await sampleOnGpu(field, positions)
  expect(gpu[0]).toBeNull()
  expect(gpu[1]![0]).toBeCloseTo(10, 3)
  expect(gpu[2]![1]).toBeCloseTo(-5, 3)
})

test('nested fields use the inner field wherever it has a value', async () => {
  // The inner field covers 3..5° E and has a hole; the outer one everything.
  const grid = buildGrid(41, 21, (column, row) =>
    column >= 18 && column < 22 ? null : [3 + column * 0.05, 52 + row * 0.05]
  )
  const inner = new CurvilinearVelocityField(
    grid,
    new Float32Array(41 * 21).fill(1),
    new Float32Array(41 * 21).fill(0)
  )
  const nx = 40
  const ny = 20
  const outer = RegularVelocityChunk.fromComponents(
    { crs: 'EPSG:4326', nx, ny, x0: 0.125, y0: 50.125, dx: 0.25, dy: 0.25 },
    new Float32Array(nx * ny).fill(2),
    new Float32Array(nx * ny).fill(0)
  )
  const field = new NestedVelocityField([inner, outer])

  // A line from the open sea, through the inner field and its hole.
  const positions: [number, number][] = []
  for (let i = 0; i <= 2000; i++) positions.push([2.5 + (i / 2000) * 3, 52.5])

  const gpu = await sampleOnGpu(field, positions)
  const coarse = await sampleOnGpu(field, positions, true)
  positions.forEach(([lon, lat], i) => {
    const expected = inner.sample(lon, lat) !== null ? 1 : 2
    expect(field.sample(lon, lat)![0]).toBe(expected)
    // No gaps at the boundary: always one field or the other.
    expect(gpu[i], `sample at ${lon}`).not.toBeNull()
    // Within float32 precision of the inner field's edge, either field is right.
    const isOnEdge =
      (inner.sample(lon - 1e-4, lat) !== null) !==
      (inner.sample(lon + 1e-4, lat) !== null)
    if (!isOnEdge) expect(gpu[i]![0]).toBeCloseTo(expected, 5)
    expect(coarse[i], `coarse sample at ${lon}`).not.toBeNull()
  })
  expect(positions.some(([lon, lat]) => inner.sample(lon, lat) !== null)).toBe(
    true
  )
  expect(field.maxVelocity()).toEqual([2, 0])

  const bounds = mercatorBoundsOf(field)
  expect(bounds.west).toBeCloseTo(0.5, 10)
  expect(bounds.east).toBeCloseTo(10 / 360 + 0.5, 10)
})

test('coarse sampling cuts off the domain at the mesh and stays close inside it', async () => {
  const grid = coastalGrid()
  const field = positionField(grid)
  const positions = randomPositions(grid, 10000, 5)
  const coarse = await sampleOnGpu(field, positions, true)

  let numInside = 0
  let numShown = 0
  let numFalsePositive = 0
  let maxError = 0
  positions.forEach(([lon, lat], i) => {
    const cpu = field.sample(lon, lat)
    const sample = coarse[i]
    if (cpu) numInside++
    if (!sample) return
    numShown++
    if (!cpu) {
      numFalsePositive++
      return
    }
    maxError = Math.max(maxError, Math.abs(sample[0] - cpu[0]))
  })
  expect(numShown / numInside).toBeGreaterThan(0.98)
  expect(numFalsePositive / numShown).toBeLessThan(0.01)
  // Texels hold (column, row) with a triangle split; a few cells is fine for a
  // background colour.
  expect(maxError).toBeLessThan(8)
})

test('grid textures are kept for fields on the same grid', async () => {
  const gl = createWebGl2Context()
  gl.getExtension('EXT_color_buffer_float')
  const builder = await CurvilinearLookupBuilder.create(gl)
  let numBuilds = 0
  const build = builder.build.bind(builder)
  builder.build = grid => {
    numBuilds++
    return build(grid)
  }
  const textures = new VelocityFieldTextures(gl, builder)

  const grid = buildGrid(10, 10, turnedPoint, 64)
  textures.setField(positionField(grid))
  textures.prepare()
  textures.setField(positionField(grid))
  textures.prepare()
  expect(numBuilds).toBe(1)

  textures.setField(positionField(buildGrid(10, 10, turnedPoint, 64)))
  textures.prepare()
  expect(numBuilds).toBe(2)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  textures.destruct()
})
