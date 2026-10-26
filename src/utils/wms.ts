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
  ModelTiepoint?: [number, number, number, number, number, number]
  ModelPixelScale?: [number, number, number]
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

/**
 * Loads FEWS convertVectortoRG TIFFs, not arbitrary georeferenced rasters.
 * ModelTiepoint stores velocity offsets and ModelPixelScale stores per-byte
 * velocity increments; their remaining entries must be zero.
 */
export async function fetchGeoTiffVelocityField(
  url: URL,
  signal?: AbortSignal,
  transformRequest?: TransformRequestFunction
): Promise<VelocityImage> {
  const request = new Request(url)
  const transformedRequest = (await transformRequest?.(request)) ?? request
  const response = await fetch(new Request(transformedRequest, { signal }))
  if (!response.ok) {
    throw new Error(
      `Fetching velocity GeoTIFF failed: ${response.status} ${response.statusText}`
    )
  }
  const arrayBuffer = await response.arrayBuffer()

  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer, signal)
  const image = await tiff.getImage()

  const bitsPerSample = image.fileDirectory.getValue('BitsPerSample')
  const imageWidth = image.fileDirectory.getValue('ImageWidth')
  const imageLength = image.fileDirectory.getValue('ImageLength')
  const [modelTiepoint, modelPixelScale, extraSamples, geoKeyDirectory, noDataTag] =
    await Promise.all([
      image.fileDirectory.loadValue('ModelTiepoint'),
      image.fileDirectory.loadValue('ModelPixelScale'),
      image.fileDirectory.loadValue('ExtraSamples'),
      image.fileDirectory.loadValue('GeoKeyDirectory'),
      image.fileDirectory.loadValue('GDAL_NODATA')
    ])
  const samplesPerPixel = image.fileDirectory.getValue('SamplesPerPixel')
  const sampleFormat = image.fileDirectory.getValue('SampleFormat')
  const photometricInterpretation =
    image.fileDirectory.getValue('PhotometricInterpretation')

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

  if (
    (samplesPerPixel !== 3 && samplesPerPixel !== 4) ||
    bitsPerSample.length !== samplesPerPixel ||
    photometricInterpretation !== 2 ||
    (sampleFormat !== undefined &&
      (sampleFormat.length !== samplesPerPixel ||
        !sampleFormat.every(format => format === 1))) ||
    (samplesPerPixel === 3 && (extraSamples?.length ?? 0) !== 0) ||
    (samplesPerPixel === 4 &&
      (extraSamples?.length !== 1 || extraSamples[0] !== 2))
  ) {
    throw new Error(
      'Expected FEWS unsigned 8-bit RGB velocity bands (R=U, G=V), optionally with unassociated alpha.'
    )
  }

  if (
    !Number.isInteger(imageWidth) ||
    !Number.isInteger(imageLength) ||
    imageWidth <= 0 ||
    imageLength <= 0 ||
    modelTiepoint?.length !== 6 ||
    modelPixelScale?.length !== 3 ||
    !modelTiepoint.every(Number.isFinite) ||
    !modelPixelScale.every(Number.isFinite) ||
    !modelTiepoint.slice(2).every(value => value === 0) ||
    modelPixelScale[2] !== 0 ||
    !Number.isFinite(modelPixelScaleX * 255 + modelTiepointX) ||
    !Number.isFinite(modelPixelScaleY * 255 + modelTiepointY) ||
    image.fileDirectory.hasTag('ModelTransformation') ||
    (geoKeyDirectory !== undefined && geoKeyDirectory[3] !== 0)
  ) {
    throw new Error(
      'Expected FEWS velocity offsets/scales, not spatial GeoTIFF georeferencing.'
    )
  }

  const noData = noDataTag === undefined ? null : image.getGDALNoData()
  if (
    noDataTag !== undefined &&
    (noData === null ||
      !Number.isInteger(noData) ||
      noData < 0 ||
      noData > 255)
  ) {
    throw new Error('FEWS velocity NoData must be an unsigned 8-bit value.')
  }

  let data: Uint8Array
  try {
    const rasters = await image.readRasters({
      interleave: true,
      pool,
      signal
    })
    if (
      !(rasters instanceof Uint8Array) ||
      rasters.length !== imageWidth * imageLength * samplesPerPixel
    ) {
      throw new Error('Decoded FEWS velocity raster has an invalid type or size.')
    }
    data = rasters
  } catch (error) {
    console.error('[GeoTIFF] readRasters failed', {
      error,
      width: image.getWidth(),
      height: image.getHeight(),
      fileDirectory: image.getFileDirectory().toObject()
    })
    throw error
  }

  for (let i = 0; i < data.length; i += samplesPerPixel) {
    const masked = samplesPerPixel === 4 && data[i + 3] === 0
    const missing =
      noData !== null && (data[i] === noData || data[i + 1] === noData)
    if (masked || missing) {
      data[i] = 255
      data[i + 1] = 255
    }
  }

  return new VelocityImage(
    data,
    imageWidth,
    imageLength,
    modelTiepointX,
    modelTiepointY,
    modelPixelScaleX * 255,
    modelPixelScaleY * 255
  )
}
