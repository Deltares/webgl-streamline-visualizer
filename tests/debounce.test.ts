import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { debounce } from '@/utils/debounce'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('calls the function once with the latest arguments after the wait', () => {
  const func = vi.fn()
  const debounced = debounce(func, 100)
  debounced(1)
  vi.advanceTimersByTime(50)
  debounced(2)
  vi.advanceTimersByTime(99)
  expect(func).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(func).toHaveBeenCalledExactlyOnceWith(2)
})

test('cancel drops the pending call', () => {
  const func = vi.fn()
  const debounced = debounce(func, 100)
  debounced()
  debounced.cancel()
  vi.advanceTimersByTime(200)
  expect(func).not.toHaveBeenCalled()
  debounced()
  vi.advanceTimersByTime(100)
  expect(func).toHaveBeenCalledOnce()
})
