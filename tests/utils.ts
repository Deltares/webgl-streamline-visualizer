export function createWebGl2Context(): WebGL2RenderingContext {
  const canvas = new OffscreenCanvas(100, 100)
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    throw new Error('Failed to create WebGL2 context.')
  }
  return gl
}
