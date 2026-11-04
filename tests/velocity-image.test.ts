import { expect, test } from 'vitest'
import { VelocityImage } from '@/utils/velocity-image'

test('fromComponents round-trips within half a quantisation step', () => {
  const u = [-12.5, -3, 0, 7.25, 20]
  const v = [4, -8, 1.5, 0, -2]
  const image = VelocityImage.fromComponents(u, v, 5, 1)
  const uStep = (20 - -12.5) / 254
  const vStep = (4 - -8) / 254
  for (let i = 0; i < 5; i++) {
    const velocity = image.velocityAt(i, 0)
    expect(velocity).not.toBeNull()
    expect(Math.abs(velocity![0] - u[i]!)).toBeLessThanOrEqual(uStep / 2 + 1e-9)
    expect(Math.abs(velocity![1] - v[i]!)).toBeLessThanOrEqual(vStep / 2 + 1e-9)
  }
})

test('fromComponents decodes the extremes exactly', () => {
  const image = VelocityImage.fromComponents([-3, 5], [10, 2], 2, 1)
  expect(image.velocityAt(0, 0)![0]).toBeCloseTo(-3, 10)
  expect(image.velocityAt(1, 0)![0]).toBeCloseTo(5, 10)
  expect(image.velocityAt(0, 0)![1]).toBeCloseTo(10, 10)
  expect(image.velocityAt(1, 0)![1]).toBeCloseTo(2, 10)
})

test('fromComponents never confuses maxima with the missing sentinel', () => {
  // Both components at their maximum in the same pixel.
  const image = VelocityImage.fromComponents([0, 1], [0, 1], 2, 1)
  expect(image.velocityAt(1, 0)).not.toBeNull()
})

test('fromComponents marks non-finite components as missing', () => {
  const image = VelocityImage.fromComponents(
    [1, NaN, 3, 4],
    [1, 2, Infinity, 4],
    2,
    2
  )
  expect(image.velocityAt(0, 0)).not.toBeNull()
  expect(image.velocityAt(1, 0)).toBeNull()
  expect(image.velocityAt(0, 1)).toBeNull()
  expect(image.velocityAt(1, 1)).not.toBeNull()
})

test('fromComponents handles constant and all-missing fields', () => {
  const constant = VelocityImage.fromComponents([2, 2], [-1, -1], 2, 1)
  expect(constant.velocityAt(1, 0)).toEqual([2, -1])
  const missing = VelocityImage.fromComponents([NaN], [NaN], 1, 1)
  expect(missing.velocityAt(0, 0)).toBeNull()
})

test('fromComponents rejects mismatched sizes', () => {
  expect(() => VelocityImage.fromComponents([1, 2], [1, 2], 3, 1)).toThrow()
})
