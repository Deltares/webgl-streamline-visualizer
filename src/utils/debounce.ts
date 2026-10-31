export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void
  cancel(): void
}

/**
 * Creates a function that delays calling `func` until `wait` milliseconds
 * have passed since it was last called. Pending calls can be cancelled.
 */
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  wait: number
): DebouncedFunction<Args> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timeout)
    timeout = undefined
  }
  const debounced = (...args: Args) => {
    cancel()
    timeout = setTimeout(() => {
      timeout = undefined
      func(...args)
    }, wait)
  }
  return Object.assign(debounced, { cancel })
}
