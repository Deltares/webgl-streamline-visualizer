import { expect, test, vi } from 'vitest'
import { writeArrayBuffer } from 'geotiff'

test('the GeoTIFF worker pool is created on first use with two workers', async () => {
  // geotiff creates each worker from a blob URL; it captures the Worker
  // constructor when it is imported, so count the blob URLs instead.
  const workerSpy = vi.spyOn(URL, 'createObjectURL')

  const { fetchGeoTiffVelocityField } = await import('@/utils/wms')
  expect(workerSpy).not.toHaveBeenCalled()

  const buffer = writeArrayBuffer(new Uint8Array([255, 10, 0, 255]), {
    width: 1,
    height: 1,
    SamplesPerPixel: 4,
    PhotometricInterpretation: 2,
    ExtraSamples: [2],
    ModelTiepoint: [-1.63, -1.62, 0, 0, 0, 0],
    ModelPixelScale: [0.008, 0.012, 0],
    GeographicTypeGeoKey: undefined
  })
  const url = new URL('https://example.test/velocity.tiff')
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  fetchSpy.mockImplementation(async () => new Response(buffer.slice(0)))

  await fetchGeoTiffVelocityField(url)
  await fetchGeoTiffVelocityField(url)
  expect(workerSpy).toHaveBeenCalledTimes(2)
})
