import { debounce } from 'lodash-es'
import {
  type CustomLayerInterface,
  LngLat,
  LngLatBounds,
  type Map,
  MercatorCoordinate
} from 'maplibre-gl'
import {
  type BoundingBoxScaling,
  type StreamlineVisualiserOptions,
  type TrailParticleOptions,
  StreamlineStyle,
  StreamlineVisualiser,
  fetchWMSAvailableTimesAndElevations,
  fetchWMSColormap,
  fetchWMSVelocityField
} from '.'
import type { TransformRequestFunction } from '@/utils/wms'

export interface WMSStreamlineLayerOptions {
  baseUrl: string
  layer: string
  style?: string
  useDisplayUnits?: boolean
  useLastValue?: boolean
  streamlineStyle: StreamlineStyle
  numParticles: number
  particleSize: number
  speedFactor: number
  fadeAmountPerSecond: number
  downsampleFactorWMS?: number
  maxAge?: number
  growthRate?: number
  speedExponent?: number
  particleColor?: string
  spriteUrl?: URL
  trailParticleOptions?: TrailParticleOptions
  transformRequest?: TransformRequestFunction
}

function convertMapBoundsToEpsg3857BoundingBox(
  bounds: LngLatBounds
): [number, number, number, number] {
  // Converts weird normalised EPSG:3857 to actual EPSG:3857.
  const toMercator = (coords: LngLat): [number, number] => {
    // TODO: get magic number from Maplibre somehow; mercator
    const mercatorWidth = 2 * 20037508.34
    const mercNorm = MercatorCoordinate.fromLngLat(coords)
    const x = (mercNorm.x - 0.5) * mercatorWidth
    const y = (0.5 - mercNorm.y) * mercatorWidth
    return [x, y]
  }
  const [xSW, ySW] = toMercator(bounds.getSouthWest())
  const [xNE, yNE] = toMercator(bounds.getNorthEast())

  return [xSW, ySW, xNE, yNE]
}

export class WMSStreamlineLayer implements CustomLayerInterface {
  private static readonly MAX_PARTICLE_DISPLACEMENT = 1

  public readonly renderingMode = '2d'
  public readonly type = 'custom'

  private _id: string

  private map: Map | null
  private gl: WebGL2RenderingContext | null

  private options: WMSStreamlineLayerOptions
  private _visualiser: StreamlineVisualiser | null
  private previousFrameTime: DOMHighResTimeStamp | null

  private boundingBoxWMS: [number, number, number, number] | null

  private times: string[]
  private elevationBounds: [number, number] | null

  private timeIndex: number
  private elevation: number | null
  private colorScaleRange: [number, number] | null

  private isInitialised: boolean
  private abortController: AbortController

  private onLayerAdd: (() => void) | null
  private onStartLoading: (() => void) | null
  private onEndLoading: (() => void) | null
  // Pause rendering during map resizes; rendering will be continued by the
  // newly fetched velocity field.
  private onResizeStart = () => this._visualiser?.stop()
  // Map moveend events are fired during resize animations, so we debounce the
  // callback to prevent too many velocity field updates from happening.
  private debouncedOnMapMoveEnd = debounce(() => this.onMapMoveEnd(), 100)

  constructor(id: string, options: WMSStreamlineLayerOptions) {
    this._id = id

    this.map = null
    this.gl = null

    this.options = options
    this._visualiser = null
    this.previousFrameTime = null

    this.boundingBoxWMS = null

    this.times = []
    this.elevationBounds = null

    this.timeIndex = 0
    this.elevation = null
    this.colorScaleRange = null

    this.isInitialised = false
    this.abortController = new AbortController()

    this.onLayerAdd = null
    this.onStartLoading = null
    this.onEndLoading = null
  }

  get id(): string {
    return this._id
  }

  get visualiser(): StreamlineVisualiser | null {
    return this._visualiser
  }

  private get signal(): AbortSignal {
    return this.abortController.signal
  }

  private get time(): string {
    if (this.times.length === 0) {
      throw new Error('No available times.')
    }
    const time = this.times[this.timeIndex]
    if (!time) {
      throw new Error(
        `Requested time index ${this.timeIndex} out of range; only ${this.times.length} times available.`
      )
    }
    return time
  }

  private get size(): [number, number] {
    if (!this.gl) throw new Error('Not initialised.')
    const width = this.gl.drawingBufferWidth
    const height = this.gl.drawingBufferHeight
    return [width, height]
  }

  onAdd(map: Map, gl: WebGL2RenderingContext) {
    this.map = map
    this.gl = gl

    this._visualiser = this.createVisualiser(gl, this.options)

    this.times = []
    this.elevationBounds = null

    this.timeIndex = 0
    this.elevation = null
    this.colorScaleRange = null

    if (this.onLayerAdd) {
      this.onLayerAdd()
      this.onLayerAdd = null
    }
  }

  onRemove(): void {
    // Abort any ongoing updates to the layer. This prevents map event listeners
    // from being set after the layer has been removed from the map.
    this.abortController.abort()
    this.map
      ?.off('resize', this.onResizeStart)
      .off('moveend', this.debouncedOnMapMoveEnd)
    this._visualiser?.destruct()
    this._visualiser = null
    this.previousFrameTime = null
  }

  render(): void {
    if (!this.map || !this.boundingBoxWMS || !this._visualiser) {
      return
    }

    const [xSWCur, ySWCur, xNECur, yNECur] =
      convertMapBoundsToEpsg3857BoundingBox(this.map.getBounds())
    const [xSWWMS, ySWWMS, xNEWMS, yNEWMS] = this.boundingBoxWMS

    // Compute offset and scale of the new bounding box compared to the old one.
    // This is used to determine where to render the streamline visualisation in
    // clip coordinates.
    const widthWMS = xNEWMS - xSWWMS
    const widthCur = xNECur - xSWCur
    const heightWMS = yNEWMS - ySWWMS
    const heightCur = yNECur - ySWCur

    // Compute the offset based on the centre of the bounding box.
    const xCentreCur = 0.5 * (xSWCur + xNECur)
    const yCentreCur = 0.5 * (ySWCur + yNECur)
    const xCentreWMS = 0.5 * (xSWWMS + xNEWMS)
    const yCentreWMS = 0.5 * (ySWWMS + yNEWMS)

    const scaling: BoundingBoxScaling = {
      scaleX: widthWMS / widthCur,
      scaleY: heightWMS / heightCur,
      offsetX: (-2 * (xCentreCur - xCentreWMS)) / widthCur,
      offsetY: (-2 * (yCentreCur - yCentreWMS)) / heightCur
    }
    this._visualiser?.setScaling(scaling)

    // Determine time elapsed between this frame and the previous frame.
    const now = performance.now()
    const dt = this.previousFrameTime
      ? (now - this.previousFrameTime) / 1000
      : 1 / 60
    this.previousFrameTime = now

    // Render the streamline visualisation.
    this._visualiser?.renderFrame(dt)

    // Request a new frame from Maplibre, apparently (surprising API...).
    this.map.triggerRepaint()
  }

  once(_: 'add', callback: () => void): void {
    this.onLayerAdd = callback
  }

  on(event: 'start-loading' | 'end-loading', callback: () => void): void {
    if (event === 'start-loading') {
      this.onStartLoading = callback
    } else if (event === 'end-loading') {
      this.onEndLoading = callback
    }
  }

  async waitForInitialisation(signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const checkInitialisation = () => {
        if (this.isInitialised) return resolve(true)
        // The layer may have been removed; fetches have been aborted so we will
        // never be initialised.
        if (this.signal.aborted) return resolve(false)
        // If we have an abort signal, waiting for initialisation may have been
        // aborted.
        if (signal?.aborted) return resolve(false)

        // If the layer is not yet initialised or aborted, wait a bit and check
        // again.
        window.setTimeout(checkInitialisation, 50)
      }
      checkInitialisation()
    })
  }

  async initialise(
    time?: Date,
    elevation?: number,
    colorScaleRange?: [number, number]
  ): Promise<void> {
    if (!this._visualiser || !this.map) throw new Error('Not added to a map.')

    // Fetch colormap and use it to initialise the visualiser.
    const colormap = await fetchWMSColormap(
      this.options.baseUrl,
      this.options.layer,
      colorScaleRange,
      this.signal,
      this.options.transformRequest
    )

    // Fetch available WMS times and elevations.
    const response = await fetchWMSAvailableTimesAndElevations(
      this.options.baseUrl,
      this.options.layer,
      this.signal,
      this.options.transformRequest
    )

    this.times = response.times
    this.elevationBounds = response.elevationBounds

    this.timeIndex = time ? this.findTimeIndex(time) : 0
    this.elevation = elevation ?? null
    this.colorScaleRange = colorScaleRange ?? null

    // Initialise and fetch first velocity field; this will also enable
    // rendering.
    await this._visualiser.initialise(colormap)
    await this.updateVelocityField(true)

    // Register event listeners for map changes. This will also be called when
    // the map is resized. Make sure we do not add the listener if we have
    // already aborted any requests because the layer is being removed.
    if (this.signal.aborted) return
    this.map.on('resize', this.onResizeStart)
    this.map.on('moveend', this.debouncedOnMapMoveEnd)

    this.isInitialised = true

    // Request a repaint to ensure we see the velocity field.
    this.map.triggerRepaint()
  }

  async setWmsLayer(baseUrl: string, layer: string): Promise<void> {
    this.options.baseUrl = baseUrl
    this.options.layer = layer
    await this.initialise()
  }

  async setStyle(style: string): Promise<void> {
    this.options.style = style
    await this.updateVelocityField(false)
  }

  async setTime(time: Date): Promise<void> {
    await this.setTimeIndex(this.findTimeIndex(time))
  }

  async setTimeIndex(index: number): Promise<void> {
    // No change, do not update.
    if (index === this.timeIndex) return

    if (index < 0 || index > this.times.length - 1) {
      throw new Error('Invalid time index.')
    }
    this.timeIndex = index
    // The velocity field update is abortable.
    await this.updateVelocityField(true)
  }

  async setElevation(elevation: number | null): Promise<void> {
    // No change, do not update.
    if (elevation === this.elevation) return

    if (elevation === null) {
      this.elevation = null
    } else {
      if (
        this.elevationBounds === null ||
        elevation < this.elevationBounds[0] ||
        elevation > this.elevationBounds[1]
      ) {
        throw new Error('Invalid elevation.')
      }
      this.elevation = elevation
    }
    // The velocity field update is abortable.
    await this.updateVelocityField(true)
  }

  async setColorScaleRange(
    colorScaleRange: [number, number] | null
  ): Promise<void> {
    // No change, do not update.
    if (colorScaleRange === null && this.colorScaleRange === null) return
    if (
      colorScaleRange !== null &&
      this.colorScaleRange !== null &&
      colorScaleRange[0] === this.colorScaleRange[0] &&
      colorScaleRange[1] === this.colorScaleRange[1]
    ) {
      return
    }

    this.colorScaleRange = colorScaleRange

    // Update colormap and velocity field for new color scale range.
    const colormap = await fetchWMSColormap(
      this.options.baseUrl,
      this.options.layer,
      colorScaleRange ?? undefined,
      this.signal,
      this.options.transformRequest
    )
    this._visualiser?.setColorMap(colormap)

    // Note that we do not need a velocity update, since the TIFF response from
    // the WMS server does not depend on the color scale range.
  }

  setNumParticles(numParticles: number): void {
    this._visualiser?.setNumParticles(numParticles)
  }

  async setVisualiserOptions(
    options: Partial<StreamlineVisualiserOptions>
  ): Promise<void> {
    await this._visualiser?.updateOptions(options)
  }

  async setDisplayUnits(useDisplayUnits: boolean | undefined): Promise<void> {
    // No change, do not update.
    if (useDisplayUnits === this.options.useDisplayUnits) return

    this.options.useDisplayUnits = useDisplayUnits

    await this.updateVelocityField(false)
  }

  async setUseLastValue(useLastValue: boolean): Promise<void> {
    // No change, do not update.
    if (useLastValue === this.options.useLastValue) return

    this.options.useLastValue = useLastValue

    await this.updateVelocityField(false)
  }

  private createVisualiser(
    gl: WebGL2RenderingContext,
    options: WMSStreamlineLayerOptions
  ): StreamlineVisualiser {
    if (!this.map) throw new Error('Not initialised.')

    const visualiserOptions =
      WMSStreamlineLayer.getVisualiserOptionsFromLayerOptions(options)
    const [width, height] = this.size
    return new StreamlineVisualiser(
      gl,
      width,
      height,
      this.options.numParticles,
      visualiserOptions
    )
  }

  private onMapMoveEnd(): void {
    const doResetParticles = true
    this.updateVelocityField(doResetParticles).catch(() =>
      console.error('Failed to update velocity field.')
    )
  }

  private async updateVelocityField(doResetParticles: boolean): Promise<void> {
    if (!this.map) throw new Error('Not added to a map')

    if (this.onStartLoading) this.onStartLoading()

    // Update the canvas size and dimensions for the visualiser. This is no-op
    // if the size has not changed.
    const [width, height] = this.size
    this._visualiser?.setDimensions(width, height)
    // Restart animation after setting the dimensions, so we can still show
    // some animation after resizing the canvas, with the old velocity field.
    this._visualiser?.start()

    // Make sure to get the bounds before we start the long wait for the WMS
    // layer, since the user may have moved the map while this fetch is
    // happening; this would cause the newly fetched WMS image to be placed at
    // the wrong coordinates.
    // The FEWS Web Mapping Service cannot handle bounding boxes larger than a
    // single earth, so we restrict ourselves to just the one earth. We also
    // need to reduce the width of the requested image by the appropriate
    // amount, as this size is not respected by FEWS WMS if the aspect ratio is
    // not OK.
    let factorWidth = 1
    let bounds = this.map.getBounds()
    const range = bounds.getEast() - bounds.getWest()
    if (range > 360) {
      factorWidth = 360 / range
      bounds = new LngLatBounds(
        new LngLat(0, bounds.getSouth()),
        new LngLat(360, bounds.getNorth())
      )
    }
    const boundingBox = convertMapBoundsToEpsg3857BoundingBox(bounds)

    const downsampleDimension = (length: number) => {
      const divisor = this.options.downsampleFactorWMS ?? 1
      return Math.round(length / divisor)
    }
    const widthWMS = downsampleDimension(factorWidth * width)
    const heightWMS = downsampleDimension(height)

    try {
      const velocityImage = await fetchWMSVelocityField(
        this.options.baseUrl,
        this.options.layer,
        this.time,
        boundingBox,
        widthWMS,
        heightWMS,
        this.options.style,
        this.options.useDisplayUnits,
        this.options.useLastValue,
        this.elevation ?? undefined,
        this.signal,
        this.options.transformRequest
      )
      this._visualiser?.setVelocityImage(velocityImage, doResetParticles)
    } catch (error) {
      // No error message is necessary if the promise gets rejected due to an
      // abort.
      if (!this.signal.aborted) {
        const errorString = (error as Error).toString()
        console.error(
          `Failed to fetch WMS velocity field, or received empty image: ${errorString}.`
        )
      }
      this._visualiser?.stop()
      this.boundingBoxWMS = null
      return
    }

    this._visualiser?.start()
    this.boundingBoxWMS = boundingBox

    // Request a repaint from Maplibre so we (re)start the animation.
    this.map.triggerRepaint()

    if (this.onEndLoading) this.onEndLoading()
  }

  private findTimeIndex(time: Date): number {
    // Find the closest date to the requested date.
    const timestamps = this.times.map(cur => new Date(cur).getTime())
    const timestamp = time.getTime()
    const diffs = timestamps.map(cur => Math.abs(timestamp - cur))
    const minDiff = Math.min(...diffs)
    return diffs.findIndex(diff => diff == minDiff) ?? 0
  }

  private static getVisualiserOptionsFromLayerOptions(
    options: WMSStreamlineLayerOptions
  ): StreamlineVisualiserOptions {
    return {
      style: options.streamlineStyle,
      particleSize: options.particleSize,
      speedFactor: options.speedFactor,
      fadeAmountPerSecond: options.fadeAmountPerSecond,
      maxDisplacement: WMSStreamlineLayer.MAX_PARTICLE_DISPLACEMENT,
      maxAge: options.maxAge ?? 1.0,
      growthRate: options.growthRate,
      speedExponent: options.speedExponent,
      particleColor: options.particleColor,
      spriteUrl: options.spriteUrl,
      trailParticleOptions: options.trailParticleOptions
    }
  }
}
