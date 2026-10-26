import { afterEach, expect, test, vi } from 'vitest'
import { writeArrayBuffer } from 'geotiff'
import type { GeotiffWriterMetadata } from 'geotiff'
import { fetchGeoTiffVelocityField } from '@/utils/wms'
import { createWebGl2Context, readTexture } from './utils'

afterEach(() => vi.restoreAllMocks())

function mockTiff(
  data: Uint8Array,
  metadata: GeotiffWriterMetadata = {}
): void {
  const buffer = writeArrayBuffer(data, {
    width: 1,
    height: data.length / 4,
    SamplesPerPixel: 4,
    PhotometricInterpretation: 2,
    ExtraSamples: [2],
    ModelTiepoint: [-1.63, -1.62, 0, 0, 0, 0],
    ModelPixelScale: [0.008, 0.012, 0],
    GeographicTypeGeoKey: undefined,
    ...metadata
  })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buffer))
}

const url = new URL('https://example.test/velocity.tiff')

test('decodes the FEWS metadata layout and preserves valid RGBA bytes', async () => {
  const bytes = new Uint8Array([255, 10, 0, 255, 20, 255, 0, 128])
  mockTiff(bytes)
  const image = await fetchGeoTiffVelocityField(url)
  expect([image.width, image.height]).toEqual([1, 2])
  expect(image.uOffset).toBe(-1.63)
  expect(image.vOffset).toBe(-1.62)
  expect(image.uScale).toBeCloseTo(0.008 * 255)
  expect(image.vScale).toBeCloseTo(0.012 * 255)
  const gl = createWebGl2Context()
  const texture = image.toTexture(gl, false)
  expect(readTexture(gl, texture, 1, 2)).toEqual(bytes)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  gl.deleteTexture(texture)
})

test('normalizes transparent pixels and explicit NoData in either component', async () => {
  mockTiff(
    new Uint8Array([
      12, 34, 0, 0,
      254, 34, 0, 255,
      12, 254, 0, 255,
      255, 255, 0, 255,
      12, 34, 0, 255
    ]),
    { GDAL_NODATA: '254' }
  )
  const image = await fetchGeoTiffVelocityField(url)
  const gl = createWebGl2Context()
  const texture = image.toTexture(gl, false)
  expect(readTexture(gl, texture, 1, 5)).toEqual(
    new Uint8Array([
      255, 255, 0, 0,
      255, 255, 0, 255,
      255, 255, 0, 255,
      255, 255, 0, 255,
      12, 34, 0, 255
    ])
  )
  gl.deleteTexture(texture)
})

test('supports RGB with an odd width and NoData in the V band', async () => {
  mockTiff(new Uint8Array([10, 254, 0, 20, 30, 0]), {
    height: 2,
    SamplesPerPixel: 3,
    ExtraSamples: [],
    GDAL_NODATA: '254'
  })
  const image = await fetchGeoTiffVelocityField(url)
  const gl = createWebGl2Context()
  const texture = image.toTexture(gl, false)
  expect(readTexture(gl, texture, 1, 2)).toEqual(
    new Uint8Array([255, 255, 0, 255, 20, 30, 0, 255])
  )
  expect(gl.getError()).toBe(gl.NO_ERROR)
  gl.deleteTexture(texture)
})

test.each([0, 255])('honors an explicit NoData byte of %i', async noData => {
  mockTiff(new Uint8Array([12, noData, 0, 255]), {
    GDAL_NODATA: String(noData)
  })
  const image = await fetchGeoTiffVelocityField(url)
  const gl = createWebGl2Context()
  const texture = image.toTexture(gl, false)
  expect(readTexture(gl, texture, 1, 1)).toEqual(
    new Uint8Array([255, 255, 0, 255])
  )
  gl.deleteTexture(texture)
})

test.each([
  { ModelTiepoint: [0, 0, 0, 120000, 450000, 0] },
  { ModelTiepoint: [0, 0] },
  { ModelTiepoint: [NaN, 0, 0, 0, 0, 0] },
  { ModelPixelScale: [0.008, Infinity, 0] },
  { ModelPixelScale: [0.008, 0.012, 1] },
  { GeoKeyDirectory: [1, 1, 0, 1, 1024, 0, 1, 1] },
  { ModelTransformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
])('rejects non-FEWS or invalid velocity metadata: %o', async metadata => {
  mockTiff(new Uint8Array([10, 20, 0, 255]), metadata)
  await expect(fetchGeoTiffVelocityField(url)).rejects.toThrow('FEWS velocity')
})

test.each([
  { PhotometricInterpretation: 1 },
  { ExtraSamples: [1] },
  { ExtraSamples: [0] },
  { SampleFormat: [2, 2, 2, 2] },
  { SampleFormat: [3, 3, 3, 3] },
  { BitsPerSample: [16, 16, 16, 16] },
  { SamplesPerPixel: 2, BitsPerSample: [8, 8], ExtraSamples: [] }
])('rejects unsupported velocity band layouts: %o', async metadata => {
  mockTiff(new Uint8Array([10, 20, 0, 255]), metadata)
  await expect(fetchGeoTiffVelocityField(url)).rejects.toThrow()
})

test.each(['nan', '-1', '256', '1.5'])('rejects invalid NoData %s', async value => {
  mockTiff(new Uint8Array([10, 20, 0, 255]), { GDAL_NODATA: value })
  await expect(fetchGeoTiffVelocityField(url)).rejects.toThrow('NoData')
})

test('reports HTTP failures before attempting TIFF decoding', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('Unavailable', { status: 503 })
  )
  await expect(fetchGeoTiffVelocityField(url)).rejects.toThrow('503')
})
