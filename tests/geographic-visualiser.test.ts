import { expect, test } from 'vitest'
import {
  NORTH_POLE_Y,
  SOUTH_POLE_Y,
  mercatorBoundsOf,
  createDomainMeshData
} from '@/geographic/domain-mesh'
import { countCopiesOnScreen, visibleWorldCopies } from '@/geographic/layer'
import type {
  GeographicPrograms,
  ProjectionShaderData,
  ProjectionUniformData
} from '@/geographic/programs'
import {
  RegularVelocityChunk,
  type RegularGrid
} from '@/geographic/regular-velocity-chunk'
import {
  GeographicStreamlineVisualiser,
  type GeographicView,
  type SpawnTable
} from '@/geographic/visualiser'
import { StreamlineStyle } from '@/render'
import type { ParticleBuffers } from '@/render/propagator'
import { Colormap } from '@/utils/colormap'
import type { StreamlineVisualiserOptions } from '@/visualiser'

const EARTH_RADIUS = 6371008.8
const WIDTH = 256
const HEIGHT = 256

// MapLibre's Mercator prelude, as `CustomRenderMethodInput.shaderData` gives it.
const mercatorShaderData: ProjectionShaderData = {
  variantName: 'mercator',
  vertexShaderPrelude: `const float PI = 3.141592653589793;
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) {vec4 result=u_projection_matrix*vec4(p,0.0,1.0);return result;}
vec4 projectTile(vec2 p,vec2 rawPos) {vec4 result=u_projection_matrix*vec4(p,0.0,1.0);if (rawPos.y <-32767.5 || rawPos.y > 32766.5) {result.z=-10000000.0;}return result;}`,
  define: '#define PROJECTION_MERCATOR'
}

// The whole Mercator world fills the viewport: x 0..1 → clip -1..1, and y 0..1
// (north to south) → clip 1..-1. Column-major.
const worldMatrix = [2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]
const worldProjection: ProjectionUniformData = {
  mainMatrix: worldMatrix,
  fallbackMatrix: worldMatrix,
  tileMercatorCoords: [0, 0, 1, 1],
  clippingPlane: [0, 0, 0, 0],
  projectionTransition: 0
}

interface VisualiserInternals {
  outputBuffers: ParticleBuffers
  programs: { get(data: ProjectionShaderData): GeographicPrograms | null }
  propagate(programs: GeographicPrograms, dt: number): void
}

function createContext(): WebGL2RenderingContext {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false })
  if (!gl) throw new Error('Failed to create WebGL2 context.')
  return gl
}

function createOptions(
  overrides: Partial<StreamlineVisualiserOptions> = {}
): StreamlineVisualiserOptions {
  return {
    style: StreamlineStyle.LightParticlesOnMagnitude,
    particleSize: 2,
    speedFactor: 0.1,
    fadeAmountPerSecond: 3,
    maxDisplacement: 1,
    maxAge: 2,
    speedExponent: 1,
    ...overrides
  }
}

function createColormap(end = 20): Colormap {
  return new Colormap(
    [0, end],
    [
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 0, b: 0 }
    ]
  )
}

/** A global 1° grid with velocities from a function of lon and lat in degrees. */
function globalField(
  f: (lon: number, lat: number) => [number, number],
  spacing = 1
): RegularVelocityChunk {
  const nx = Math.round(360 / spacing)
  const ny = Math.round(180 / spacing) + 1
  const grid: RegularGrid = {
    crs: 'EPSG:4326',
    nx,
    ny,
    x0: -180 + spacing / 2,
    y0: 90,
    dx: spacing,
    dy: -spacing
  }
  const u = new Float32Array(nx * ny)
  const v = new Float32Array(nx * ny)
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const [ui, vi] = f(grid.x0 + column * spacing, grid.y0 - row * spacing)
      u[row * nx + column] = ui
      v[row * nx + column] = vi
    }
  }
  return RegularVelocityChunk.fromComponents(grid, u, v)
}

/**
 * The spawn table for a view of Mercator x from `west` to `east` and the whole
 * y range, such as {@link worldProjection}.
 */
function worldSpawnTable(size = 16, west = 0, east = 1): SpawnTable {
  const data = new Float32Array(4 * size * size)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = west + ((east - west) * (column + 0.5)) / size
      const y = (row + 0.5) / size
      const lon = (x - 0.5) * 2 * Math.PI
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y)))
      data.set(
        [
          Math.cos(lat) * Math.cos(lon),
          Math.cos(lat) * Math.sin(lon),
          Math.sin(lat),
          1
        ],
        4 * (row * size + column)
      )
    }
  }
  return { width: size, height: size, data }
}

function worldView(metresPerPixel: number, cameraChanged = false): GeographicView {
  return {
    shaderData: mercatorShaderData,
    projectionData: worldProjection,
    metresPerPixel,
    spawnTable: worldSpawnTable(),
    worldCopies: [0, 0],
    cameraChanged
  }
}

async function createVisualiser(
  gl: WebGL2RenderingContext,
  numParticles: number,
  options: StreamlineVisualiserOptions,
  colormap: Colormap
): Promise<GeographicStreamlineVisualiser> {
  const visualiser = new GeographicStreamlineVisualiser(
    gl,
    WIDTH,
    HEIGHT,
    numParticles,
    options
  )
  await visualiser.initialise(colormap)
  await visualiser.prepare(mercatorShaderData)
  return visualiser
}

function readParticles(
  gl: WebGL2RenderingContext,
  visualiser: GeographicStreamlineVisualiser,
  numParticles: number
): { data: Float32Array; ages: Float32Array } {
  const buffers = (visualiser as unknown as VisualiserInternals).outputBuffers
  const data = new Float32Array(4 * numParticles)
  const ages = new Float32Array(numParticles)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.data)
  gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.age)
  gl.getBufferSubData(gl.ARRAY_BUFFER, 0, ages)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  return { data, ages }
}

function writeParticles(
  visualiser: GeographicStreamlineVisualiser,
  data: Float32Array,
  ages: Float32Array
): void {
  const buffers = (visualiser as unknown as VisualiserInternals).outputBuffers
  buffers.initialise(data, ages)
}

/**
 * Runs propagation steps directly, so that particles are neither drawn nor
 * resampled from the spawn table.
 */
function propagate(
  visualiser: GeographicStreamlineVisualiser,
  dt: number,
  numSteps: number
): void {
  const internals = visualiser as unknown as VisualiserInternals
  const programs = internals.programs.get(mercatorShaderData)
  if (!programs) throw new Error('Programs are not ready.')
  for (let i = 0; i < numSteps; i++) internals.propagate(programs, dt)
}

// With speedExponent 1, a speed s moves s · speedFactor clip units per second,
// and one clip unit is HEIGHT / 2 pixels. This scale makes that s m/s.
const physicalMetresPerPixel = (speedFactor: number) =>
  2 / (HEIGHT * speedFactor)

function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))
}

test('advects solid-body rotation exactly along latitude circles', async () => {
  const gl = createContext()
  const speed = 100 // m/s at the equator
  const options = createOptions({ maxAge: 1e9, speedFactor: 0.1 })
  // Never let the visibility test reject a particle.
  const field = globalField(
    (_, lat) => [speed * Math.cos((lat * Math.PI) / 180), 0],
    0.25
  )
  const colormap = createColormap()
  const latitudes = [0, 0.5, -1.0, 1.3, -1.4]
  const visualiser = await createVisualiser(gl, latitudes.length, options, colormap)
  visualiser.setVelocityField(field, true)
  visualiser.setView(worldView(physicalMetresPerPixel(options.speedFactor)))

  const startLongitude = 2.5 // radians, so particles cross the antimeridian
  const data = new Float32Array(4 * latitudes.length)
  latitudes.forEach((lat, i) => {
    const clipSpeed = speed * Math.cos(lat) * options.speedFactor
    data.set([startLongitude, lat, clipSpeed, 0], 4 * i)
  })
  writeParticles(visualiser, data, new Float32Array(latitudes.length))

  // 1000 steps of 60 s: 1.5 rad of longitude at the equator, more than the
  // displacement of a particle's lifetime on screen.
  const dt = 60
  const numSteps = 1000
  propagate(visualiser, dt, numSteps)
  const { data: result } = readParticles(gl, visualiser, latitudes.length)
  expect(gl.getError()).toBe(gl.NO_ERROR)

  // Solid-body rotation: every latitude turns by the same angle.
  const expectedAngle = (speed * dt * numSteps) / EARTH_RADIUS
  latitudes.forEach((lat, i) => {
    const lon = result[4 * i] as number
    const newLat = result[4 * i + 1] as number
    expect(Math.abs(newLat - lat), `latitude of particle ${i}`).toBeLessThan(1e-5)
    const turned = wrapAngle(lon - startLongitude)
    expect(
      Math.abs(turned - wrapAngle(expectedAngle)) / expectedAngle,
      `longitude of particle ${i}`
    ).toBeLessThan(1e-3)
  })
  visualiser.destruct()
})

test('crosses the antimeridian and high latitudes without drifting', async () => {
  const gl = createContext()
  const speed = 100
  const options = createOptions({ maxAge: 1e9, speedFactor: 0.1 })
  // Rotation about an axis at 180° E, 30° N, so paths cross the antimeridian
  // and reach high latitudes. Particles stay within Mercator's latitudes, so
  // they never reach the poles.
  const tilt = (60 * Math.PI) / 180
  const axis = [-Math.sin(tilt), 0, Math.cos(tilt)] as const
  const velocityAt = (lonRad: number, latRad: number): [number, number] => {
    const x = [
      Math.cos(latRad) * Math.cos(lonRad),
      Math.cos(latRad) * Math.sin(lonRad),
      Math.sin(latRad)
    ]
    const v = [
      speed * (axis[1] * x[2]! - axis[2] * x[1]!),
      speed * (axis[2] * x[0]! - axis[0] * x[2]!),
      speed * (axis[0] * x[1]! - axis[1] * x[0]!)
    ]
    const east = [-Math.sin(lonRad), Math.cos(lonRad), 0]
    const north = [
      -Math.sin(latRad) * Math.cos(lonRad),
      -Math.sin(latRad) * Math.sin(lonRad),
      Math.cos(latRad)
    ]
    const dot = (a: number[], b: number[]) =>
      a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
    return [dot(v, east), dot(v, north)]
  }
  const field = globalField(
    (lon, lat) => velocityAt((lon * Math.PI) / 180, (lat * Math.PI) / 180),
    0.25
  )
  // Start points at 50° and 40° from the axis; the first circle reaches 80° N.
  const starts: [number, number][] = [
    [Math.PI, (-20 * Math.PI) / 180],
    [Math.PI, (-10 * Math.PI) / 180]
  ]
  const visualiser = await createVisualiser(
    gl,
    starts.length,
    options,
    createColormap()
  )
  visualiser.setVelocityField(field, true)
  visualiser.setView(worldView(physicalMetresPerPixel(options.speedFactor)))

  const data = new Float32Array(4 * starts.length)
  starts.forEach(([lon, lat], i) => {
    const [ve, vn] = velocityAt(lon, lat)
    data.set([lon, lat, ve * options.speedFactor, vn * options.speedFactor], 4 * i)
  })
  writeParticles(visualiser, data, new Float32Array(starts.length))

  const toUnit = ([lon, lat]: [number, number]) => [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat)
  ]
  const dotAxis = (x: number[]) =>
    x[0]! * axis[0] + x[1]! * axis[1] + x[2]! * axis[2]

  // Follow the particles in chunks and check that they stay on their circles
  // around the axis, and turn at the right rate.
  const dt = 60
  const stepsPerCheck = 500
  const numChecks = 6
  const expectedAngle = (speed * dt * stepsPerCheck * numChecks) / EARTH_RADIUS
  let maxDrift = 0
  let crossedAntimeridian = false
  const previous = starts.map(([lon]) => lon)
  for (let check = 0; check < numChecks; check++) {
    propagate(visualiser, dt, stepsPerCheck)
    const { data: result } = readParticles(gl, visualiser, starts.length)
    starts.forEach((start, i) => {
      const position: [number, number] = [result[4 * i]!, result[4 * i + 1]!]
      maxDrift = Math.max(
        maxDrift,
        Math.abs(dotAxis(toUnit(position)) - dotAxis(toUnit(start)))
      )
      if (Math.abs(position[0] - previous[i]!) > Math.PI) crossedAntimeridian = true
      previous[i] = position[0]
    })
  }
  expect(crossedAntimeridian).toBe(true)
  // After 2.8 rad (about 18 000 km, far beyond a particle's lifetime) the
  // particles are within 1e-4 (about 600 m) of their circles: float32
  // rounding and the bilinear interpolation of the 0.25° field.
  expect(maxDrift).toBeLessThan(1e-4)

  // Total angle turned about the axis.
  const { data: result } = readParticles(gl, visualiser, starts.length)
  starts.forEach((start, i) => {
    const project = (x: number[]) => {
      const d = dotAxis(x)
      return [x[0]! - d * axis[0], x[1]! - d * axis[1], x[2]! - d * axis[2]]
    }
    const a = project(toUnit(start))
    const b = project(toUnit([result[4 * i]!, result[4 * i + 1]!]))
    const cross = [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!
    ]
    const sin = cross[0]! * axis[0] + cross[1]! * axis[1] + cross[2]! * axis[2]
    const cos = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
    const turned = Math.atan2(sin, cos)
    expect(Math.abs(turned - wrapAngle(expectedAngle)) / expectedAngle).toBeLessThan(1e-3)
  })
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('spawns particles on screen and moves them at the screen speed of screen mode', async () => {
  const gl = createContext()
  const numParticles = 2000
  const options = createOptions({ maxAge: 5, speedFactor: 0.1 })
  // Uniform 10 m/s eastward wind.
  const field = globalField(() => [10, 0])
  const visualiser = await createVisualiser(gl, numParticles, options, createColormap())
  visualiser.setVelocityField(field, true)
  const metresPerPixel = 5000
  visualiser.setView(worldView(metresPerPixel))
  visualiser.start()

  // The first frame spawns everything.
  visualiser.renderFrame(1 / 60)
  const before = readParticles(gl, visualiser, numParticles)
  const live = Array.from({ length: numParticles }, (_, i) => i).filter(
    i => before.data[4 * i + 2] !== 0
  )
  expect(live.length).toBeGreaterThan(0.95 * numParticles)

  // Every particle is in Mercator's latitudes and has an eastward velocity.
  for (const i of live) {
    expect(Math.abs(before.data[4 * i + 1]!)).toBeLessThanOrEqual(1.4844223)
    expect(before.data[4 * i + 2]).toBeCloseTo(10 * options.speedFactor, 4)
    expect(Math.abs(before.data[4 * i + 3]!)).toBeLessThan(1e-4)
  }

  // Screen mode moves 10 m/s × speedFactor = 1 clip unit per second, i.e.
  // HEIGHT / 2 pixels per second. Here that is HEIGHT / 2 × metresPerPixel
  // metres per second along the ground.
  const dt = 1 / 30
  visualiser.renderFrame(dt)
  const after = readParticles(gl, visualiser, numParticles)
  const expectedMetres = ((10 * options.speedFactor * HEIGHT) / 2) * metresPerPixel * dt
  let numChecked = 0
  for (const i of live) {
    // Skip particles that were respawned in between.
    if (Math.abs(after.ages[i]! - before.ages[i]! - dt) > 1e-6) continue
    const lat = before.data[4 * i + 1]!
    const dLon = wrapAngle(after.data[4 * i]! - before.data[4 * i]!)
    const metres = dLon * EARTH_RADIUS * Math.cos(lat)
    expect(Math.abs(metres - expectedMetres) / expectedMetres).toBeLessThan(0.01)
    numChecked++
  }
  expect(numChecked).toBeGreaterThan(0.9 * live.length)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('keeps particles out of areas without data and draws the composite there', async () => {
  const gl = createContext()
  const numParticles = 2000
  // Data only in the eastern hemisphere.
  const field = globalField(lon => (lon > 0 ? [5, 5] : [NaN, NaN]))
  const visualiser = await createVisualiser(
    gl,
    numParticles,
    createOptions(),
    createColormap()
  )
  visualiser.setVelocityField(field, true)
  // Spawn table marks the western half invalid, as GeographicStreamlineLayer
  // does from the field's coverage.
  const table = worldSpawnTable()
  for (let row = 0; row < table.height; row++) {
    for (let column = 0; column < table.width / 2; column++) {
      table.data[4 * (row * table.width + column) + 3] = 0
    }
  }
  visualiser.setView({ ...worldView(5000), spawnTable: table })
  visualiser.start()

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  for (let frame = 0; frame < 10; frame++) visualiser.renderFrame(1 / 60)

  const { data } = readParticles(gl, visualiser, numParticles)
  for (let i = 0; i < numParticles; i++) {
    if (data[4 * i + 2] === 0 && data[4 * i + 3] === 0) continue
    // Live particles are in the eastern hemisphere (allowing for the edge
    // cell, interpolated to just across 0°).
    expect(data[4 * i]!).toBeGreaterThan(-0.02)
  }

  // The composite covers the eastern half of the canvas only.
  const pixels = new Uint8Array(4 * WIDTH * HEIGHT)
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  const alphaAt = (x: number, y: number) => pixels[4 * (y * WIDTH + x) + 3]!
  expect(alphaAt(WIDTH / 4, HEIGHT / 2)).toBe(0)
  expect(alphaAt((3 * WIDTH) / 4, HEIGHT / 2)).toBeGreaterThan(0)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('respawns particles that leave the screen', async () => {
  const gl = createContext()
  const numParticles = 500
  const options = createOptions({ maxAge: 1e9 })
  const field = globalField(() => [10, 0])
  const visualiser = await createVisualiser(gl, numParticles, options, createColormap())
  visualiser.setVelocityField(field, true)
  // Only the middle of the world is on screen: x 0.25..0.75 fills clip space.
  const zoomed = [4, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -2, 1, 0, 1]
  visualiser.setView({
    ...worldView(5000),
    projectionData: { ...worldProjection, mainMatrix: zoomed, fallbackMatrix: zoomed },
    spawnTable: worldSpawnTable(16, 0.25, 0.75)
  })
  // A particle far east, off screen, and one on screen.
  writeParticles(
    visualiser,
    new Float32Array([2.5, 0, 1, 0, 0, 0, 1, 0]),
    new Float32Array([1, 1])
  )
  propagate(visualiser, 1 / 60, 1)
  const { data, ages } = readParticles(gl, visualiser, 2)
  // Off screen: respawned somewhere on screen (|lon| < π/2), with age 0.
  expect(ages[0]).toBe(0)
  expect(Math.abs(data[0]!)).toBeLessThan(Math.PI / 2)
  // On screen: moved on.
  expect(ages[1]).toBeCloseTo(1 + 1 / 60, 5)
  visualiser.destruct()
})

test('finds the visible world copies from the Mercator matrix', () => {
  expect(visibleWorldCopies(worldMatrix)).toEqual([0, 0])
  // Zoomed out: x -1..2 fills clip space.
  const wide = [2 / 3, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -1 / 3, 1, 0, 1]
  expect(visibleWorldCopies(wide)).toEqual([-1, 1])
  // Panned east by half a world: x 0.5..1.5.
  const panned = [2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -2, 1, 0, 1]
  expect(visibleWorldCopies(panned)).toEqual([0, 1])

  // Three whole worlds: every location shows three times.
  expect(countCopiesOnScreen(wide, 170, 0, [-1, 1])).toBe(3)
  // x 0.25..1.75: 0° E (x 0.5) shows twice, 170° E (x 0.97) once.
  const oneAndAHalf = [4 / 3, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -4 / 3, 1, 0, 1]
  expect(visibleWorldCopies(oneAndAHalf)).toEqual([0, 1])
  expect(countCopiesOnScreen(oneAndAHalf, 0, 0, [0, 1])).toBe(2)
  expect(countCopiesOnScreen(oneAndAHalf, 170, 0, [0, 1])).toBe(1)
  expect(countCopiesOnScreen(worldMatrix, 0, 0, [0, 0])).toBe(1)
})

test('spawns evenly over the screen, also near its edges', async () => {
  const gl = createContext()
  const numParticles = 20000
  const field = globalField(() => [1, 0])
  const visualiser = await createVisualiser(
    gl,
    numParticles,
    createOptions({ maxAge: 1e9 }),
    createColormap()
  )
  visualiser.setVelocityField(field, true)
  visualiser.setView(worldView(1))
  visualiser.start()
  // One step spawns all particles.
  propagate(visualiser, 1e-6, 1)
  const { data } = readParticles(gl, visualiser, numParticles)

  // Histogram of screen x (Mercator x for this view) in 32 bins.
  const bins = new Array(32).fill(0)
  for (let i = 0; i < numParticles; i++) {
    const x = data[4 * i]! / (2 * Math.PI) + 0.5
    bins[Math.min(Math.floor(x * 32), 31)]++
  }
  const expected = numParticles / 32
  for (const count of bins) {
    // Clamping at the edges used to pile particles onto the outer cell
    // centres and leave the outer half-cells empty.
    expect(Math.abs(count - expected) / expected).toBeLessThan(0.2)
  }
  visualiser.destruct()
})

test('builds the domain mesh over the outer cell edges', () => {
  const grid: RegularGrid = { crs: 'EPSG:4326', nx: 281, ny: 169, x0: -25, y0: 72, dx: 0.25, dy: -0.25 }
  const chunk = RegularVelocityChunk.fromComponents(
    grid,
    new Float32Array(281 * 169),
    new Float32Array(281 * 169)
  )
  const bounds = mercatorBoundsOf(chunk)
  expect(bounds.west).toBeCloseTo(-25.125 / 360 + 0.5, 10)
  expect(bounds.east).toBeCloseTo(45.125 / 360 + 0.5, 10)
  expect(bounds.north).toBeLessThan(bounds.south)

  const { vertices, indices } = createDomainMeshData(bounds)
  // About one quad per 2°: 70.25° → 36 quads, 42.25° → 22 quads.
  expect(vertices.length).toBe(2 * 37 * 23)
  expect(indices.length).toBe(6 * 36 * 22)
  expect(Math.max(...indices)).toBe(37 * 23 - 1)
  expect(vertices[0]).toBeCloseTo(bounds.west, 6)
  expect(vertices[1]).toBeCloseTo(bounds.north, 6)
  expect(vertices[vertices.length - 2]).toBeCloseTo(bounds.east, 6)
  expect(vertices[vertices.length - 1]).toBeCloseTo(bounds.south, 6)

  // A global grid wraps: the mesh spans the whole world, and is extended to
  // both poles.
  const global = globalField(() => [0, 0])
  const globalBounds = mercatorBoundsOf(global)
  expect(globalBounds.east - globalBounds.west).toBeCloseTo(1, 10)
  const globalMesh = createDomainMeshData(globalBounds)
  const ys = globalMesh.vertices.filter((_, i) => i % 2 === 1)
  expect(ys[0]).toBe(NORTH_POLE_Y)
  expect(ys[ys.length - 1]).toBe(SOUTH_POLE_Y)
  // The regional grid above does not reach the poles.
  expect(Math.min(...vertices.filter((_, i) => i % 2 === 1))).toBeGreaterThan(0)
})
