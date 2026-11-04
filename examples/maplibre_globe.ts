import './maplibre_globe.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import { Map, setWorkerUrl } from 'maplibre-gl'
// MapLibre 6 loads its worker from a URL that bundlers cannot see; emit the
// worker module as an asset and point MapLibre to it.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import {
  Colormap,
  GeographicStreamlineLayer,
  RegularVelocityChunk,
  StreamlineStyle,
  type RegularGrid
} from '@/index'

// A synthetic global wind field: zonal jets and a few vortices, on a 0.5° grid
// that wraps around the earth.
function createSyntheticWind(): RegularVelocityChunk {
  const spacing = 0.5
  const grid: RegularGrid = {
    crs: 'EPSG:4326',
    nx: 360 / spacing,
    ny: 180 / spacing + 1,
    x0: -180 + spacing / 2,
    y0: 90,
    dx: spacing,
    dy: -spacing
  }

  // Centre longitude and latitude in degrees, peak speed in m/s (positive is
  // anticlockwise) and radius of the peak in km.
  const vortices = [
    { lon: -40, lat: 55, speed: 30, radius: 600 },
    { lon: 140, lat: 20, speed: -35, radius: 300 },
    { lon: 170, lat: -45, speed: -25, radius: 800 },
    { lon: 60, lat: -15, speed: -30, radius: 250 },
    { lon: -100, lat: 25, speed: 20, radius: 400 }
  ]
  const kmPerDegree = 111.2

  const u = new Float32Array(grid.nx * grid.ny)
  const v = new Float32Array(grid.nx * grid.ny)
  for (let row = 0; row < grid.ny; row++) {
    const lat = grid.y0 + row * grid.dy
    // Westerly jets at mid-latitudes, easterly trade winds in the tropics.
    const zonal =
      25 * Math.exp(-(((lat - 45) / 10) ** 2)) +
      20 * Math.exp(-(((lat + 50) / 10) ** 2)) -
      8 * Math.exp(-((lat / 12) ** 2))
    for (let column = 0; column < grid.nx; column++) {
      const lon = grid.x0 + column * grid.dx
      let ui = zonal
      let vi = 0
      for (const vortex of vortices) {
        const dLon = ((lon - vortex.lon + 540) % 360) - 180
        const dx = dLon * Math.cos((vortex.lat * Math.PI) / 180) * kmPerDegree
        const dy = (lat - vortex.lat) * kmPerDegree
        const r = Math.hypot(dx, dy) / vortex.radius
        if (r === 0) continue
        // Tangential speed that peaks at the radius and decays outside it.
        const speed = vortex.speed * r * Math.exp(0.5 * (1 - r * r))
        ui += (-dy / Math.hypot(dx, dy)) * speed
        vi += (dx / Math.hypot(dx, dy)) * speed
      }
      u[row * grid.nx + column] = ui
      v[row * grid.nx + column] = vi
    }
  }
  return RegularVelocityChunk.fromComponents(grid, u, v)
}

function createColormap(): Colormap {
  return new Colormap(
    [0, 7.5, 15, 22.5, 30],
    [
      { r: 68, g: 1, b: 84 },
      { r: 59, g: 82, b: 139 },
      { r: 33, g: 145, b: 140 },
      { r: 94, g: 201, b: 98 },
      { r: 253, g: 231, b: 37 }
    ]
  )
}

setWorkerUrl(maplibreWorkerUrl)

const map = new Map({
  container: 'container',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [10, 30],
  zoom: 1.5
})
await map.once('load')
map.setProjection({ type: 'globe' })

const layer = new GeographicStreamlineLayer('wind', {
  numParticles: 12000,
  colormap: createColormap(),
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

// Draw the wind below the labels.
const firstSymbolLayer = map
  .getStyle()
  .layers.find(styleLayer => styleLayer.type === 'symbol')
map.addLayer(layer, firstSymbolLayer?.id)
layer.setVelocityField(createSyntheticWind())

const projectionButton = document.getElementById(
  'projection'
) as HTMLButtonElement
projectionButton.addEventListener('click', () => {
  const isGlobe = map.getProjection()?.type === 'globe'
  map.setProjection({ type: isGlobe ? 'mercator' : 'globe' })
  projectionButton.textContent = isGlobe ? 'Switch to globe' : 'Switch to Mercator'
})

const styleSelect = document.getElementById('style') as HTMLSelectElement
styleSelect.addEventListener('change', () => {
  const style = Number(styleSelect.value) as StreamlineStyle
  void layer.setVisualiserOptions({
    style,
    particleColor: style === StreamlineStyle.ParticlesOnly ? '#1d3557' : 'black'
  })
})

// For debugging from the console.
Object.assign(globalThis, { map, layer })
