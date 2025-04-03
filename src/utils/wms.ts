import type { GetCapabilitiesResponse } from '@deltares/fews-wms-requests'
import * as GeoTIFF from 'geotiff'

import { Color, Colormap } from './colormap'
import { createTexture } from './textures'

export type TransformRequestFunction = (request: Request) => Promise<Request>

export class VelocityImage {
  constructor(
    private data: Uint8Array | Uint8ClampedArray,
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
  colorScaleRange?: [number, number],
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<Colormap> {
  const url = new URL(baseUrl)
  url.searchParams.append('request', 'GetLegendGraphic')
  url.searchParams.append('format', 'application/json')
  url.searchParams.append('version', '1.3')
  url.searchParams.append('layers', layer)
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
  const elevationBounds = (
    lowerElevation !== undefined && upperElevation !== undefined
      ? [+lowerElevation, +upperElevation]
      : null
  ) as [number, number] | null

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

export async function fetchWMSVelocityField(
  baseUrl: string,
  layer: string,
  time: string,
  boundingBox: [number, number, number, number],
  width: number,
  height: number,
  style?: string,
  useDisplayUnits?: boolean,
  elevation?: number,
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<VelocityImage> {
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
  if (useDisplayUnits !== undefined) {
    url.searchParams.append(
      'useDisplayUnits',
      useDisplayUnits ? 'true' : 'false'
    )
  }
  if (elevation) {
    url.searchParams.append('elevation', `${elevation}`)
  }

  const request = new Request(url)
  const transformedRequest = (await transformRequest?.(request)) ?? request
  const response = await fetch(new Request(transformedRequest, { signal }))
  const arrayBuffer = await response.arrayBuffer()

  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer, signal)
  const image = await tiff.getImage()
  const fileDirectory = image.getFileDirectory() as FewsGeoTiffMetadata

  const expectedProperties: (keyof FewsGeoTiffMetadata)[] = [
    'BitsPerSample',
    'ImageWidth',
    'ImageLength',
    'ModelTiepoint',
    'ModelPixelScale'
  ]
  const hasExpectedMetadata = expectedProperties.every(
    property => property in fileDirectory
  )
  if (!hasExpectedMetadata) {
    const propertiesString = expectedProperties
      .map(property => `"${property}"`)
      .join(', ')
    throw new Error(
      `GeoTIFF metadata does not contain all expected properties; need the following properties: ${propertiesString}`
    )
  }

  // Assume we have 8-bit data per channel.
  const isAllChannels8Bit = fileDirectory.BitsPerSample!.every(
    (numBits: number) => numBits === 8
  )
  if (!isAllChannels8Bit) {
    throw new Error(
      'Fetched GeoTIFF does not have the expected 8 bits bitdepth per channel.'
    )
  }

  // Get image data, it should always have unsigned 8-bit integers for each
  // channel. For some mysterious reason, the GeoTIFF types say that this
  // function produces a Int8Array, while in reality it produces a Uint8Array.
  const dataUntyped = (await image.readRasters({ interleave: true })) as unknown
  const data = dataUntyped as Uint8Array

  // Get offsets and scales for the image. We multiply the scales by 255, since
  // 255 of an unsigned 8-bit integer corresponds to a texture value of 1.0 in
  // WebGL.
  const receivedWidth = fileDirectory.ImageWidth!
  const receivedHeight = fileDirectory.ImageLength!
  const uOffset = fileDirectory.ModelTiepoint![0]
  const uScale = fileDirectory.ModelPixelScale![0] * 255
  // The y-offset and scale are negated, for some reason.
  const vOffset = -fileDirectory.ModelTiepoint![1]
  const vScale = -fileDirectory.ModelPixelScale![1] * 255

  return new VelocityImage(
    data,
    receivedWidth,
    receivedHeight,
    uOffset,
    vOffset,
    uScale,
    vScale
  )
}
