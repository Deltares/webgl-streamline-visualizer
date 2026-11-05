import { CurvilinearVelocityField } from './curvilinear-velocity-field'
import type { RegularVelocityChunk } from './regular-velocity-chunk'
import { NestedVelocityField, type VelocityField } from './velocity-field'

/** A rectangle in Web Mercator 0..1, with y running from north to south. */
export interface MercatorBounds {
  west: number
  east: number
  north: number
  south: number
}

const MERCATOR_RADIUS = 6378137
const MAX_MERCATOR_LATITUDE = 85.05112878
// About one quad per this many degrees, so the mesh follows the sphere.
const DEGREES_PER_QUAD = 2
const MAX_QUADS_PER_AXIS = 128

function latitudeToMercatorY(lat: number): number {
  const clamped = Math.min(
    Math.max(lat, -MAX_MERCATOR_LATITUDE),
    MAX_MERCATOR_LATITUDE
  )
  const phi = (clamped * Math.PI) / 180
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)
}

function mercatorYToLatitude(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
}

/**
 * Returns the area a field covers in Web Mercator 0..1: the outer cell edges of
 * a regular grid, the outermost cell centres of a curvilinear one, and the
 * union of these for nested fields.
 */
export function mercatorBoundsOf(field: VelocityField): MercatorBounds {
  if (field instanceof NestedVelocityField) {
    return field.fields.map(mercatorBoundsOf).reduce(unionOfBounds)
  }
  if (field instanceof CurvilinearVelocityField) {
    const { west, east, south, north } = field.grid
    return {
      west: west / 360 + 0.5,
      east: east / 360 + 0.5,
      north: latitudeToMercatorY(north),
      south: latitudeToMercatorY(south)
    }
  }
  return mercatorBoundsOfChunk(field)
}

function unionOfBounds(a: MercatorBounds, b: MercatorBounds): MercatorBounds {
  // Longitudes may differ by whole turns; bring b to a's side of the earth.
  const shift = Math.round(0.5 * (a.west + a.east - b.west - b.east))
  const west = Math.min(a.west, b.west + shift)
  const east = Math.max(a.east, b.east + shift)
  return {
    west,
    east: Math.min(east, west + 1),
    north: Math.min(a.north, b.north),
    south: Math.max(a.south, b.south)
  }
}

function mercatorBoundsOfChunk(chunk: RegularVelocityChunk): MercatorBounds {
  const { crs, nx, ny, x0, y0, dx, dy } = chunk.grid
  const westEdge = x0 - 0.5 * dx
  const eastEdge = x0 + (nx - 0.5) * dx
  const yEdgeA = y0 - 0.5 * dy
  const yEdgeB = y0 + (ny - 0.5) * dy
  const northEdge = Math.max(yEdgeA, yEdgeB)
  const southEdge = Math.min(yEdgeA, yEdgeB)

  let west: number
  let east: number
  let north: number
  let south: number
  if (crs === 'EPSG:3857') {
    const worldSize = 2 * Math.PI * MERCATOR_RADIUS
    west = westEdge / worldSize + 0.5
    east = eastEdge / worldSize + 0.5
    north = Math.max(0.5 - northEdge / worldSize, 0)
    south = Math.min(0.5 - southEdge / worldSize, 1)
  } else {
    west = westEdge / 360 + 0.5
    east = eastEdge / 360 + 0.5
    north = latitudeToMercatorY(northEdge)
    south = latitudeToMercatorY(southEdge)
  }
  if (chunk.wraps) east = west + 1
  return { west, east, north, south }
}

/** Mesh vertex y that marks the north pole (see geo_final.vert.glsl). */
export const NORTH_POLE_Y = -1
/** Mesh vertex y that marks the south pole (see geo_final.vert.glsl). */
export const SOUTH_POLE_Y = 2
// Bounds within this distance of Mercator's edge reach the edge.
const EDGE_TOLERANCE = 1e-6

/**
 * Creates a grid mesh over the bounds, as Web Mercator vertices and triangle
 * indices.
 *
 * If the bounds reach Web Mercator's latitude limit, the mesh is extended to
 * that pole with a row of pole vertices, as MapLibre does for its own tiles,
 * so the globe has no hole there.
 */
export function createDomainMeshData(bounds: MercatorBounds): {
  vertices: Float32Array
  indices: Uint16Array
} {
  const { west, east, north, south } = bounds
  const spanLongitude = (east - west) * 360
  const spanLatitude = mercatorYToLatitude(north) - mercatorYToLatitude(south)
  const quads = (span: number) =>
    Math.min(
      Math.max(Math.ceil(span / DEGREES_PER_QUAD), 1),
      MAX_QUADS_PER_AXIS
    )
  const numX = quads(spanLongitude)
  const numY = quads(spanLatitude)
  const hasNorthPole = north <= EDGE_TOLERANCE
  const hasSouthPole = south >= 1 - EDGE_TOLERANCE

  // Rows, from north to south, as Mercator y. Rows are evenly spaced in
  // latitude rather than in Mercator y, so that quads near the poles are not
  // much larger on the globe than elsewhere, and latitude interpolates
  // linearly across them.
  const latNorth = mercatorYToLatitude(north)
  const latSouth = mercatorYToLatitude(south)
  const rows: number[] = []
  if (hasNorthPole) rows.push(NORTH_POLE_Y)
  for (let j = 0; j <= numY; j++) {
    rows.push(latitudeToMercatorY(latNorth + ((latSouth - latNorth) * j) / numY))
  }
  if (hasSouthPole) rows.push(SOUTH_POLE_Y)

  const numColumns = numX + 1
  const vertices = new Float32Array(2 * numColumns * rows.length)
  rows.forEach((y, j) => {
    for (let i = 0; i < numColumns; i++) {
      const index = 2 * (j * numColumns + i)
      vertices[index] = west + ((east - west) * i) / numX
      vertices[index + 1] = y
    }
  })

  const numQuadRows = rows.length - 1
  const indices = new Uint16Array(6 * numX * numQuadRows)
  let k = 0
  for (let j = 0; j < numQuadRows; j++) {
    for (let i = 0; i < numX; i++) {
      const a = j * numColumns + i
      const b = a + 1
      const c = a + numColumns
      const d = c + 1
      indices.set([a, c, b, b, c, d], k)
      k += 6
    }
  }
  return { vertices, indices }
}
