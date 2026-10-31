import { expect, test } from 'vitest'
import { StreamlineStyle } from '@/render'
import { Colormap } from '@/utils/colormap'
import { VelocityImage } from '@/utils/velocity-image'
import { StreamlineVisualiser } from '@/visualiser'
import { createWebGl2Context, readTexture } from './utils'

interface VisualiserInternals {
  trailTexture: WebGLTexture
  velocityTexture: WebGLTexture
  fadeRenderer: {
    framebuffer: WebGLFramebuffer
    render(fadeAmount: number): void
  }
  particlePropagator: { velocityTexture: WebGLTexture }
  finalRenderer: { velocityTexture: WebGLTexture; colormapTexture: WebGLTexture }
}

function createColormap(): Colormap {
  return new Colormap(
    [0, 1],
    [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 }
    ]
  )
}

function createVelocityImage(width: number, height: number): VelocityImage {
  const data = new Uint8Array(width * height * 4).fill(128)
  return new VelocityImage(data, width, height, -1, -1, 2, 2)
}

async function createVisualiser(
  gl: WebGL2RenderingContext
): Promise<[StreamlineVisualiser, VisualiserInternals]> {
  const visualiser = new StreamlineVisualiser(gl, 16, 16, 64, {
    style: StreamlineStyle.LightParticlesOnMagnitude,
    particleSize: 2,
    speedFactor: 0.1,
    fadeAmountPerSecond: 1,
    maxDisplacement: 1,
    maxAge: 2
  })
  await visualiser.initialise(createColormap())
  visualiser.setVelocityImage(createVelocityImage(16, 16), true)
  return [visualiser, visualiser as unknown as VisualiserInternals]
}

function attachedTexture(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer
): WebGLTexture | null {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  const texture = gl.getFramebufferAttachmentParameter(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME
  ) as WebGLTexture | null
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return texture
}

function fillTrailTexture(
  gl: WebGL2RenderingContext,
  internals: VisualiserInternals,
  color: [number, number, number, number]
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, internals.fadeRenderer.framebuffer)
  gl.clearColor(...color)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
}

test('setDimensions attaches the new trail texture to the framebuffer', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const oldTexture = internals.trailTexture

  visualiser.setDimensions(32, 24)
  visualiser.setVelocityImage(createVelocityImage(32, 24), false)

  expect(attachedTexture(gl, internals.fadeRenderer.framebuffer)).toBe(
    internals.trailTexture
  )
  expect(gl.isTexture(oldTexture)).toBe(false)

  visualiser.start()
  visualiser.renderFrame(0.1)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('replaced velocity and colormap textures are deleted', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const oldTextures = [
    internals.velocityTexture,
    internals.finalRenderer.colormapTexture
  ]

  visualiser.setVelocityImage(createVelocityImage(16, 16), true)
  visualiser.setColorMap(createColormap())

  for (const texture of oldTextures) expect(gl.isTexture(texture)).toBe(false)
  expect(gl.isTexture(internals.velocityTexture)).toBe(true)
  expect(gl.isTexture(internals.finalRenderer.colormapTexture)).toBe(true)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('the trail texture starts cleared', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  visualiser.setDimensions(32, 24)

  expect(readTexture(gl, internals.trailTexture, 32, 24)).toEqual(
    new Uint8Array(32 * 24 * 4)
  )
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('resetting particles clears the trail texture in place', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const texture = internals.trailTexture
  fillTrailTexture(gl, internals, [1, 1, 1, 1])

  visualiser.setVelocityImage(createVelocityImage(16, 16), true)

  expect(internals.trailTexture).toBe(texture)
  expect(readTexture(gl, texture, 16, 16)).toEqual(new Uint8Array(16 * 16 * 4))
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('fading decreases trail alpha in place and keeps its colour', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  fillTrailTexture(gl, internals, [1, 0.5, 0, 200 / 255])

  internals.fadeRenderer.render(50 / 255)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  let pixels = readTexture(gl, internals.trailTexture, 16, 16)
  expect(Array.from(pixels.subarray(0, 4))).toEqual([255, 128, 0, 150])
  expect(new Set(pixels).size).toBe(4)

  // Alpha is clamped to zero.
  internals.fadeRenderer.render(1)
  pixels = readTexture(gl, internals.trailTexture, 16, 16)
  expect(Array.from(pixels.subarray(0, 4))).toEqual([255, 128, 0, 0])
  expect(gl.isEnabled(gl.BLEND)).toBe(false)
  expect(gl.getParameter(gl.BLEND_EQUATION_RGB)).toBe(gl.FUNC_ADD)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('renderFrame renders without errors with substeps', async () => {
  const gl = createWebGl2Context()
  const [visualiser] = await createVisualiser(gl)
  visualiser.start()
  // The minimum time step is 1.25 s for this velocity field and size, so this
  // results in 8 substeps.
  visualiser.renderFrame(10)
  visualiser.renderCopy()
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('the velocity texture is uploaded once and shared', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)

  expect(internals.particlePropagator.velocityTexture).toBe(
    internals.velocityTexture
  )
  expect(internals.finalRenderer.velocityTexture).toBe(
    internals.velocityTexture
  )
  visualiser.destruct()
})

test('destruct deletes all textures and framebuffers', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const textures = [
    internals.velocityTexture,
    internals.finalRenderer.colormapTexture,
    internals.trailTexture
  ]
  const framebuffer = internals.fadeRenderer.framebuffer

  visualiser.destruct()

  for (const texture of textures) expect(gl.isTexture(texture)).toBe(false)
  expect(gl.isFramebuffer(framebuffer)).toBe(false)
})
