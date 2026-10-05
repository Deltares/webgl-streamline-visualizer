import type { GetCapabilitiesResponse } from '@deltares/fews-wms-requests'
import * as GeoTIFF from 'geotiff'

import { Color, Colormap } from './colormap'
import { createTexture } from './textures'

export type TransformRequestFunction = (request: Request) => Promise<Request>

const pool = new GeoTIFF.Pool()

export class VelocityImage {
  constructor(
    private readonly data: Uint8Array | Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
    readonly uOffset: number,
    readonly vOffset: number,
    readonly uScale: number,
    readonly vScale: number
  ) {}

  maxVelocity(): [number, number] {
    const computeU = (r: number) => r * this.uScale + this.uOffset
    const computeV = (g: number) => g * this.vScale + this.vOffset

    return [
      Math.max(computeU(0), computeU(1)),
      Math.max(computeV(0), computeV(1))
    ]
  }

  toTexture(gl: WebGL2RenderingContext, interpolate: boolean): WebGLTexture {
    return createTexture(
      gl,
      interpolate ? gl.LINEAR : gl.NEAREST,
      this.data,
      this.width,
      this.height
    )
  }
}

/**
 * Fetches a colormap for a WMS layer from the FEWS web services.
 *
 * @param baseUrl base URL of the FEWS WMS service.
 * @param layer layer to obtain the legend for.
 * @returns Colormap fetched from the FEWS WMS service.
 */
export async function fetchWMSColormap(
  baseUrl: string,
  layer: string,
  style?: string,
  colorScaleRange?: [number, number],
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<Colormap> {
  const url = new URL(baseUrl)
  url.searchParams.append('request', 'GetLegendGraphic')
  url.searchParams.append('format', 'application/json')
  url.searchParams.append('version', '1.3')
  url.searchParams.append('layers', layer)
  if (style) {
    url.searchParams.append('style', style)
  }
  if (colorScaleRange) {
    url.searchParams.append('colorScaleRange', `${colorScaleRange.join(',')}`)
  }

  const request = new Request(url)
  const transformedRequest = (await transformRequest?.(request)) ?? request
  const response = await fetch(new Request(transformedRequest, { signal }))
  const data = (await response.json()) as {
    legend: { lowerValue: number; color: string }[]
  }

  return new Colormap(
    data.legend.map(entry => entry.lowerValue),
    data.legend.map(entry => Color.fromHex(entry.color))
  )
}

export async function fetchWMSAvailableTimesAndElevations(
  baseUrl: string,
  layerName: string,
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<{ times: string[]; elevationBounds: [number, number] | null }> {
  const url = new URL(baseUrl)
  url.searchParams.append('request', 'GetCapabilities')
  url.searchParams.append('format', 'application/json')
  url.searchParams.append('version', '1.3')
  url.searchParams.append('layers', layerName)

  const request = new Request(url)
  const transformedRequest = (await transformRequest?.(request)) ?? request
  const response = await fetch(new Request(transformedRequest, { signal }))
  const capabilities = (await response.json()) as GetCapabilitiesResponse

  const layer = capabilities.layers?.[0]
  if (!layer) {
    throw new Error('WMS GetCapabilities response contains no layers.')
  }
  if (!layer.times) {
    throw new Error('WMS GetCapabilities response contains no times.')
  }

  const lowerElevation = layer.elevation?.lowerValue
  const upperElevation = layer.elevation?.upperValue
  const elevationBounds: [number, number] | null =
    lowerElevation !== undefined && upperElevation !== undefined
      ? [+lowerElevation, +upperElevation]
      : null

  return {
    times: layer.times,
    elevationBounds: elevationBounds
  }
}

export interface FewsGeoTiffMetadata {
  BitsPerSample?: number[]
  ImageWidth?: number
  ImageLength?: number
  ModelTiepoint?: [number, number]
  ModelPixelScale?: [number, number]
}

export interface WMSVelocityFieldOptions {
  time: string
  boundingBox: [number, number, number, number]
  width: number
  height: number
  style?: string
  useDisplayUnits?: boolean
  useLastValue?: boolean
  elevation?: number
}

export async function fetchWMSVelocityField(
  baseUrl: string,
  layer: string,
  options: WMSVelocityFieldOptions,
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<VelocityImage> {
  const {
    time,
    boundingBox,
    width,
    height,
    style,
    useDisplayUnits,
    useLastValue,
    elevation
  } = options
  const url = new URL(baseUrl)
  url.searchParams.append('request', 'GetMap')
  url.searchParams.append('version', '1.3')
  url.searchParams.append('layers', layer)
  url.searchParams.append('crs', 'EPSG:3857')
  url.searchParams.append('time', time)
  url.searchParams.append('width', width.toString())
  url.searchParams.append('height', height.toString())
  url.searchParams.append('bbox', `${boundingBox.join(',')}`)
  url.searchParams.append('format', 'image/tiff')
  url.searchParams.append('convertVectortoRG', 'true')
  if (style) {
    url.searchParams.append('styles', style)
  }
  if (useLastValue !== undefined) {
    url.searchParams.append('useLastValue', useLastValue ? 'true' : 'false')
  }
  if (useDisplayUnits !== undefined) {
    url.searchParams.append(
      'useDisplayUnits',
      useDisplayUnits ? 'true' : 'false'
    )
  }
  if (elevation) {
    url.searchParams.append('elevation', `${elevation}`)
  }

  return fetchGeoTiffVelocityField(url, signal, transformRequest)
}

export async function fetchGeoTiffVelocityField(
  url: URL,
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<VelocityImage> {
  const request = new Request(url)
  const transformedRequest = (await transformRequest?.(request)) ?? request
  const response = await fetch(new Request(transformedRequest, { signal }))
  const arrayBuffer = await response.arrayBuffer()

  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer, signal)
  const image = await tiff.getImage()

  const bitsPerSample = image.fileDirectory.getValue('BitsPerSample')
  const imageWidth = image.fileDirectory.getValue('ImageWidth')
  const imageLength = image.fileDirectory.getValue('ImageLength')
  const modelTiepoint = image.fileDirectory.getValue('ModelTiepoint')
  const modelPixelScale = image.fileDirectory.getValue('ModelPixelScale')

  const modelPixelScaleX = modelPixelScale?.[0]
  const modelPixelScaleY = modelPixelScale?.[1]
  const modelTiepointX = modelTiepoint?.[0]
  const modelTiepointY = modelTiepoint?.[1]

  if (
    bitsPerSample === undefined ||
    imageWidth === undefined ||
    imageLength === undefined ||
    modelPixelScaleX === undefined ||
    modelPixelScaleY === undefined ||
    modelTiepointX === undefined ||
    modelTiepointY === undefined
  ) {
    throw new Error(
      'GeoTIFF metadata does not contain the required velocity field properties.'
    )
  }

  const isAllChannels8Bit = bitsPerSample.every(
    (numBits: number) => numBits === 8
  )
  if (!isAllChannels8Bit) {
    throw new Error(
      'Fetched GeoTIFF does not have the expected 8 bits bitdepth per channel.'
    )
  }

  let data
  try {
    const dataUntyped = await image.readRasters({ interleave: true, pool })
    data = dataUntyped as Uint8Array
  } catch (error) {
    console.error('[GeoTIFF] readRasters failed', {
      error,
      width: image.getWidth(),
      height: image.getHeight(),
      fileDirectory: image.getFileDirectory().toObject()
    })
    throw error
  }

  return new VelocityImage(
    data,
    imageWidth,
    imageLength,
    modelTiepointX,
    modelTiepointX,
    modelPixelScaleX * 255,
    modelPixelScaleY * 255
  )
}
