import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map
} from 'maplibre-gl'

import type { Colormap } from '../utils/colormap'
import type { StreamlineVisualiserOptions } from '../visualiser'
import type { VelocityField } from './velocity-field'
import { GeographicStreamlineVisualiser, type SpawnTable } from './visualiser'

export interface GeographicStreamlineLayerOptions {
  numParticles: number
  colormap: Colormap
  visualiserOptions: StreamlineVisualiserOptions
  /** Cells per side of the spawn table; 32 by default. */
  spawnTableSize?: number
}

const MAX_MERCATOR_LATITUDE = 85.05112878
const DEFAULT_SPAWN_TABLE_SIZE = 32
// World copies that are considered at most, on either side of the primary one.
const MAX_WORLD_COPY = 3

/**
 * A MapLibre custom layer that animates particles in geographic mode.
 *
 * It works in every projection MapLibre supports, including the globe and the
 * transition between globe and Mercator. Unlike `WMSStreamlineLayer`, it does
 * not fetch anything: give it a field with {@link setVelocityField}. The field
 * covers its own domain, so panning and zooming need no new data, and
 * particles keep moving while the map moves.
 *
 * @example
 * ```ts
 * const layer = new GeographicStreamlineLayer('wind', {
 *   numParticles: 10000,
 *   colormap,
 *   visualiserOptions: { style: StreamlineStyle.LightParticlesOnMagnitude, ... }
 * })
 * map.addLayer(layer, firstSymbolLayerId)
 * layer.setVelocityField(RegularVelocityChunk.fromComponents(grid, u, v))
 * ```
 */
export class GeographicStreamlineLayer implements CustomLayerInterface {
  readonly type = 'custom'
  readonly renderingMode = '2d'

  private map: Map | null = null
  private _visualiser: GeographicStreamlineVisualiser | null = null
  private initialisation: Promise<void> | null = null
  private field: VelocityField | null = null

  private previousMatrix: Float64Array | null = null
  private previousTransition = Number.NaN
  private isViewStale = true
  private isSpawnTableStale = true
  private wasSpawnTableRebuilt = false
  private spawnTable: SpawnTable | null = null
  private metresPerPixel = 1
  private worldCopies: [number, number] = [0, 0]
  private previousFrameTime: DOMHighResTimeStamp | null = null

  constructor(
    readonly id: string,
    private readonly options: GeographicStreamlineLayerOptions
  ) {}

  get visualiser(): GeographicStreamlineVisualiser | null {
    return this._visualiser
  }

  onAdd(map: Map, gl: WebGL2RenderingContext): void {
    this.map = map
    const { numParticles, colormap, visualiserOptions } = this.options
    const visualiser = new GeographicStreamlineVisualiser(
      gl,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      numParticles,
      visualiserOptions,
      () => map.triggerRepaint()
    )
    this._visualiser = visualiser
    this.isViewStale = true

    this.initialisation = visualiser.initialise(colormap).then(() => {
      // The layer may have been removed in the meantime.
      if (this._visualiser !== visualiser) return
      if (this.field) visualiser.setVelocityField(this.field, true)
      visualiser.start()
      map.triggerRepaint()
    })
    this.initialisation.catch(error =>
      console.error('Failed to initialise the streamline visualiser:', error)
    )
  }

  onRemove(): void {
    this._visualiser?.destruct()
    this._visualiser = null
    this.map = null
    this.previousMatrix = null
    this.previousFrameTime = null
  }

  /** Resolves when the layer has been added and its visualiser is ready. */
  async waitForInitialisation(): Promise<void> {
    await this.initialisation
  }

  /**
   * Sets the velocity field.
   *
   * @param field the new field; its values are uploaded once.
   * @param doResetParticles whether to restart all particles; when false
   *   (the default), particles move on in the new field, e.g. for a new time.
   */
  setVelocityField(
    field: VelocityField,
    doResetParticles: boolean = false
  ): void {
    this.field = field
    this.isSpawnTableStale = true
    const visualiser = this._visualiser
    if (visualiser?.isInitialised) {
      visualiser.setVelocityField(field, doResetParticles)
      this.map?.triggerRepaint()
    }
  }

  setColorMap(colormap: Colormap): void {
    this.options.colormap = colormap
    if (this._visualiser?.isInitialised) this._visualiser.setColorMap(colormap)
  }

  setNumParticles(numParticles: number): void {
    this.options.numParticles = numParticles
    this._visualiser?.setNumParticles(numParticles)
  }

  async setVisualiserOptions(
    options: Partial<StreamlineVisualiserOptions>
  ): Promise<void> {
    this.options.visualiserOptions = {
      ...this.options.visualiserOptions,
      ...options
    }
    if (this._visualiser?.isInitialised) {
      await this._visualiser.updateOptions(options)
    }
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map
    const visualiser = this._visualiser
    const field = this.field
    if (!map || !visualiser?.isInitialised || !field) return

    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    visualiser.setDimensions(width, height)

    const projectionData = args.defaultProjectionData
    const cameraChanged = this.updateCamera(
      projectionData.mainMatrix,
      projectionData.projectionTransition
    )
    if (cameraChanged || this.isViewStale) {
      this.updateScale(map, args, width)
      this.isSpawnTableStale = true
      this.isViewStale = false
    }
    // Rebuilding the spawn table takes about 2 ms, so while the camera moves
    // it is rebuilt every other frame; particles that spawn off screen from a
    // table one frame old are respawned in the next step.
    if (
      this.isSpawnTableStale &&
      (!this.spawnTable || !cameraChanged || !this.wasSpawnTableRebuilt)
    ) {
      this.spawnTable = buildSpawnTable(
        map,
        field,
        map.getCanvas().clientWidth,
        map.getCanvas().clientHeight,
        this.options.spawnTableSize ?? DEFAULT_SPAWN_TABLE_SIZE,
        this.countCopies(args)
      )
      this.isSpawnTableStale = false
      this.wasSpawnTableRebuilt = true
    } else {
      this.wasSpawnTableRebuilt = false
    }

    visualiser.setView({
      shaderData: args.shaderData,
      projectionData,
      metresPerPixel: this.metresPerPixel,
      spawnTable: this.spawnTable as SpawnTable,
      worldCopies: this.worldCopies,
      cameraChanged
    })

    const now = performance.now()
    const dt = this.previousFrameTime
      ? (now - this.previousFrameTime) / 1000
      : 1 / 60
    this.previousFrameTime = now

    visualiser.renderFrame(dt)

    // Keep animating.
    map.triggerRepaint()
  }

  /** Returns whether the camera changed since the previous frame. */
  private updateCamera(
    matrix: ArrayLike<number>,
    transition: number
  ): boolean {
    const previous = this.previousMatrix
    let isSame =
      previous !== null &&
      previous.length === matrix.length &&
      transition === this.previousTransition
    for (let i = 0; isSame && i < matrix.length; i++) {
      isSame = previous![i] === matrix[i]
    }
    if (isSame) return false
    this.previousMatrix = Float64Array.from(matrix)
    this.previousTransition = transition
    return true
  }

  /** Updates the scale at the view centre and the visible world copies. */
  private updateScale(
    map: Map,
    args: CustomRenderMethodInput,
    width: number
  ): void {
    const canvas = map.getCanvas()
    const cssWidth = canvas.clientWidth
    const cssHeight = canvas.clientHeight
    const pixelRatio = cssWidth > 0 ? width / cssWidth : 1

    // Scale at the view centre, in a way that works in any projection.
    const cx = 0.5 * cssWidth
    const cy = 0.5 * cssHeight
    const left = map.unproject([cx - 0.5, cy])
    const right = map.unproject([cx + 0.5, cy])
    const metresPerCssPixel = left.distanceTo(right)
    if (metresPerCssPixel > 0) {
      this.metresPerPixel = metresPerCssPixel / pixelRatio
    }

    this.worldCopies =
      args.shaderData.variantName === 'mercator'
        ? visibleWorldCopies(args.defaultProjectionData.mainMatrix)
        : [0, 0]
  }

  /** Returns how many world copies show a location, for the spawn table. */
  private countCopies(
    args: CustomRenderMethodInput
  ): (lng: number, lat: number) => number {
    if (args.shaderData.variantName !== 'mercator') return () => 1
    const matrix = args.defaultProjectionData.mainMatrix
    const worldCopies = this.worldCopies
    return (lng, lat) => countCopiesOnScreen(matrix, lng, lat, worldCopies)
  }
}

/**
 * Builds the table that maps the screen to the sphere. A cell is valid if the
 * location under its centre projects back onto it (which rejects sky and space
 * around the globe), lies within Web Mercator's latitudes, and has data.
 *
 * Particles are drawn in every world copy that shows them, so a location shown
 * n times would get n times the particles; its cells accept spawns with
 * probability 1 / n instead.
 */
export function buildSpawnTable(
  map: Map,
  field: VelocityField,
  cssWidth: number,
  cssHeight: number,
  size: number,
  countCopies: (lng: number, lat: number) => number = () => 1
): SpawnTable {
  const data = new Float32Array(4 * size * size)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = ((column + 0.5) / size) * cssWidth
      const y = ((row + 0.5) / size) * cssHeight
      const location = map.unproject([x, y])
      const back = map.project(location)
      if (Math.hypot(back.x - x, back.y - y) > 1) continue
      if (Math.abs(location.lat) > MAX_MERCATOR_LATITUDE) continue
      if (field.sample(location.lng, location.lat) === null) continue

      const lon = (location.lng * Math.PI) / 180
      const lat = (location.lat * Math.PI) / 180
      const numCopies = Math.max(countCopies(location.lng, location.lat), 1)
      data.set(
        [
          Math.cos(lat) * Math.cos(lon),
          Math.cos(lat) * Math.sin(lon),
          Math.sin(lat),
          1 / numCopies
        ],
        4 * (row * size + column)
      )
    }
  }
  return { width: size, height: size, data }
}

/** Applies the Mercator matrix to (x, y, 0, 1); returns clip x, y and w. */
function projectMercator(
  matrix: ArrayLike<number>,
  x: number,
  y: number
): [number, number, number] {
  // Column-major 4 × 4 matrix.
  const m = (row: number, column: number) => matrix[column * 4 + row] as number
  return [
    m(0, 0) * x + m(0, 1) * y + m(0, 3),
    m(1, 0) * x + m(1, 1) * y + m(1, 3),
    m(3, 0) * x + m(3, 1) * y + m(3, 3)
  ]
}

/** Counts the world copies in which a location is on screen (Mercator). */
export function countCopiesOnScreen(
  matrix: ArrayLike<number>,
  lng: number,
  lat: number,
  [min, max]: [number, number]
): number {
  const wrappedLng = lng - 360 * Math.floor((lng + 180) / 360)
  const x = wrappedLng / 360 + 0.5
  const phi = (lat * Math.PI) / 180
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)
  let count = 0
  for (let copy = min; copy <= max; copy++) {
    const [clipX, clipY, w] = projectMercator(matrix, x + copy, y)
    if (w > 0 && Math.abs(clipX) <= w && Math.abs(clipY) <= w) count++
  }
  return count
}

/**
 * Returns the range of world copies (offsets in Web Mercator x) that may be
 * visible, from the Mercator projection matrix, for which `projectTile` maps
 * Web Mercator 0..1 to clip space.
 */
export function visibleWorldCopies(
  matrix: ArrayLike<number>
): [number, number] {
  const project = (x: number, y: number) => projectMercator(matrix, x, y)

  let min = Infinity
  let max = -Infinity
  for (let copy = -MAX_WORLD_COPY; copy <= MAX_WORLD_COPY; copy++) {
    const corners = [
      project(copy, 0),
      project(copy + 1, 0),
      project(copy, 1),
      project(copy + 1, 1)
    ]
    // A corner behind the camera makes the screen extent unbounded; count
    // the copy as visible.
    let isVisible = corners.some(([, , w]) => w <= 0)
    if (!isVisible) {
      const xs = corners.map(([x, , w]) => x / w)
      const ys = corners.map(([, y, w]) => y / w)
      // Strict: a copy that only touches the edge of the screen is not drawn.
      isVisible =
        Math.min(...xs) < 1 &&
        Math.max(...xs) > -1 &&
        Math.min(...ys) < 1 &&
        Math.max(...ys) > -1
    }
    if (isVisible) {
      min = Math.min(min, copy)
      max = Math.max(max, copy)
    }
  }
  return min <= max ? [min, max] : [0, 0]
}
