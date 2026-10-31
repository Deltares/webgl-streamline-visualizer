import { expect, test } from 'vitest'
import { StreamlineStyle } from '@/render'
import { Colormap } from '@/utils/colormap'
import { VelocityImage } from '@/utils/velocity-image'
import { StreamlineVisualiser } from '@/visualiser'
import { createWebGl2Context } from './utils'

interface VisualiserInternals {
  previousParticleTexture: WebGLTexture
  currentParticleTexture: WebGLTexture
  textureRenderer: {
    previousFramebuffer: WebGLFramebuffer
    currentFramebuffer: WebGLFramebuffer
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

test('setDimensions attaches the new trail textures to the framebuffers', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const oldTextures = [
    internals.previousParticleTexture,
    internals.currentParticleTexture
  ]

  visualiser.setDimensions(32, 24)
  visualiser.setVelocityImage(createVelocityImage(32, 24), false)

  expect(
    attachedTexture(gl, internals.textureRenderer.previousFramebuffer)
  ).toBe(internals.previousParticleTexture)
  expect(attachedTexture(gl, internals.textureRenderer.currentFramebuffer)).toBe(
    internals.currentParticleTexture
  )
  for (const texture of oldTextures) expect(gl.isTexture(texture)).toBe(false)

  visualiser.start()
  visualiser.renderFrame(0.1)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('replaced velocity, colormap and trail textures are deleted', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const oldTextures = [
    internals.particlePropagator.velocityTexture,
    internals.finalRenderer.velocityTexture,
    internals.finalRenderer.colormapTexture,
    internals.previousParticleTexture,
    internals.currentParticleTexture
  ]

  visualiser.setVelocityImage(createVelocityImage(16, 16), true)
  visualiser.setColorMap(createColormap())

  for (const texture of oldTextures) expect(gl.isTexture(texture)).toBe(false)
  expect(gl.isTexture(internals.particlePropagator.velocityTexture)).toBe(true)
  expect(gl.isTexture(internals.finalRenderer.velocityTexture)).toBe(true)
  expect(gl.isTexture(internals.finalRenderer.colormapTexture)).toBe(true)
  expect(gl.getError()).toBe(gl.NO_ERROR)
  visualiser.destruct()
})

test('destruct deletes all textures and framebuffers', async () => {
  const gl = createWebGl2Context()
  const [visualiser, internals] = await createVisualiser(gl)
  const textures = [
    internals.particlePropagator.velocityTexture,
    internals.finalRenderer.velocityTexture,
    internals.finalRenderer.colormapTexture,
    internals.previousParticleTexture,
    internals.currentParticleTexture
  ]
  const framebuffers = [
    internals.textureRenderer.previousFramebuffer,
    internals.textureRenderer.currentFramebuffer
  ]

  visualiser.destruct()

  for (const texture of textures) expect(gl.isTexture(texture)).toBe(false)
  for (const fb of framebuffers) expect(gl.isFramebuffer(fb)).toBe(false)
})
