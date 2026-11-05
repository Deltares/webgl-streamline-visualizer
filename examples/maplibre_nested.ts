import './maplibre_globe.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import { Map, setWorkerUrl } from 'maplibre-gl'
// MapLibre 6 loads its worker from a URL that bundlers cannot see; emit the
// worker module as an asset and point MapLibre to it.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import {
  Colormap,
  CurvilinearGrid,
  CurvilinearVelocityField,
  GeographicStreamlineLayer,
  NestedVelocityField,
  RegularVelocityChunk,
  StreamlineStyle,
  type VelocityField
} from '@/index'

// A synthetic model along a curved coast: rows run out to sea, cells shrink
// towards the shore, and the land has no coordinates. The flow follows the
// grid's columns, so it visibly differs from the regular field around it.
function createCurvilinearField(): CurvilinearVelocityField {
  const nx = 400
  const ny = 160
  const lon = new Float32Array(nx * ny)
  const lat = new Float32Array(nx * ny)
  const u = new Float32Array(nx * ny)
  const v = new Float32Array(nx * ny)
  const position = (column: number, row: number): [number, number] => {
    const s = column / (nx - 1)
    // Rows are about 30 times closer together at the shore.
    const t = (Math.exp((3.4 * row) / (ny - 1)) - 1) / (Math.exp(3.4) - 1)
    const angle = -0.5 + 1.1 * s
    const radius = 3 + 1.6 * t
    return [
      4.2 + 1.7 * radius * Math.sin(angle),
      49.6 + radius * Math.cos(angle)
    ]
  }
  for (let row = 0; row < ny; row++) {
    for (let column = 0; column < nx; column++) {
      const i = row * nx + column
      // Estuaries: gaps in the grid, starting from the shore.
      const isLand =
        (row < 12 && Math.abs(column - 130) < 5) ||
        (row < 8 && Math.abs(column - 270) < 8)
      const [x, y] = position(column, row)
      lon[i] = isLand ? NaN : x
      lat[i] = isLand ? NaN : y
      const [xNext, yNext] = position(column + 1, row)
      const dx = (xNext - x) * Math.cos((y * Math.PI) / 180)
      const dy = yNext - y
      const length = Math.hypot(dx, dy)
      const speed =
        6 + 16 * Math.exp(-((row / 30) ** 2)) * (1 + Math.sin(column / 25))
      u[i] = (speed * dx) / length
      v[i] = (speed * dy) / length
    }
  }
  return new CurvilinearVelocityField(
    new CurvilinearGrid(nx, ny, lon, lat),
    u,
    v
  )
}

// A regular model around it: a slow, uniform drift to the north-west.
function createRegularField(): RegularVelocityChunk {
  const nx = 80
  const ny = 60
  const size = nx * ny
  const u = new Float32Array(size)
  const v = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const row = Math.floor(i / nx)
    const column = i % nx
    u[i] = -6 + 3 * Math.sin(row / 8)
    v[i] = 5 + 2 * Math.cos(column / 10)
  }
  return RegularVelocityChunk.fromComponents(
    {
      crs: 'EPSG:4326',
      nx,
      ny,
      x0: -6,
      y0: 47,
      dx: 0.25,
      dy: 0.25
    },
    u,
    v
  )
}

setWorkerUrl(maplibreWorkerUrl)

const map = new Map({
  container: 'container',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [4.5, 52.5],
  zoom: 5.5
})
await map.once('load')
map.setProjection({ type: 'globe' })

const layer = new GeographicStreamlineLayer('flow', {
  numParticles: 10000,
  colormap: new Colormap(
    [0, 10, 20, 30],
    [
      { r: 68, g: 1, b: 84 },
      { r: 49, g: 104, b: 142 },
      { r: 53, g: 183, b: 121 },
      { r: 253, g: 231, b: 37 }
    ]
  ),
  visualiserOptions: {
    style: StreamlineStyle.LightParticlesOnMagnitude,
    particleSize: 3,
    speedFactor: 0.015,
    fadeAmountPerSecond: 3,
    maxDisplacement: 1,
    maxAge: 2,
    speedExponent: 0.7,
    particleOverlayOpacity: 0.8
  }
})

// Draw the flow below the labels.
const firstSymbolLayer = map
  .getStyle()
  .layers.find(styleLayer => styleLayer.type === 'symbol')
map.addLayer(layer, firstSymbolLayer?.id)

const inner = createCurvilinearField()
const outer = createRegularField()
const nested = new NestedVelocityField([inner, outer])
const fields: Record<string, VelocityField> = { nested, inner, outer }
layer.setVelocityField(nested)

const fieldSelect = document.getElementById('field') as HTMLSelectElement
fieldSelect.addEventListener('change', () => {
  layer.setVelocityField(fields[fieldSelect.value] as VelocityField, true)
})

const projectionButton = document.getElementById(
  'projection'
) as HTMLButtonElement
projectionButton.addEventListener('click', () => {
  const isGlobe = map.getProjection()?.type === 'globe'
  map.setProjection({ type: isGlobe ? 'mercator' : 'globe' })
  projectionButton.textContent = isGlobe
    ? 'Switch to globe'
    : 'Switch to Mercator'
})

// For debugging from the console.
Object.assign(globalThis, { map, layer })
