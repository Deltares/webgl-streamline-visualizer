import { createTexture } from './textures'

export enum TrailParticleShape {
  Circle = 'circle',
  Rectangle = 'rectangle'
}

export interface TrailParticleOptions {
  shape: TrailParticleShape
  aspectRatio?: number
  doRotate?: boolean
}

/** The options that determine how particles look. */
export interface ParticleAppearanceOptions {
  particleSize: number
  particleColor?: string
  spriteUrl?: URL
  trailParticleOptions?: TrailParticleOptions
}

export function determineDoRotateParticles(
  options: Partial<ParticleAppearanceOptions>
): boolean {
  const configuredDoRotate = options.trailParticleOptions?.doRotate
  if (configuredDoRotate !== undefined) {
    return configuredDoRotate
  }
  const shape = options.trailParticleOptions?.shape ?? TrailParticleShape.Circle
  return shape !== TrailParticleShape.Circle
}

/**
 * Returns the size of particle textures in pixels.
 *
 * The final particle size in pixels depends on the display scaling, so this
 * takes it into account.
 */
export function particleTextureSize(options: ParticleAppearanceOptions): number {
  const scalingFactor = globalThis.devicePixelRatio ?? 1
  return Math.ceil(2 * scalingFactor * options.particleSize)
}

/** Converts a CSS colour to RGB components in 0..1. */
export function parseCssColor(color: string): [number, number, number] {
  const canvas = new OffscreenCanvas(1, 1)
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Could not initialise 2D offscreen canvas.')
  }
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return [(r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255]
}

/** Draws the trail particle shape into a new texture. */
export function createParticleTexture(
  gl: WebGL2RenderingContext,
  options: ParticleAppearanceOptions
): WebGLTexture {
  const size = particleTextureSize(options)
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Could not initialise 2D offscreen canvas.')
  }

  const shape = options.trailParticleOptions?.shape ?? TrailParticleShape.Circle
  const aspectRatio = options.trailParticleOptions?.aspectRatio ?? 1
  const particleColor = options.particleColor ?? 'black'
  if (shape === TrailParticleShape.Circle) {
    if (aspectRatio !== 1) {
      console.warn(
        'Specifying an aspect ratio is not supported circle-shaped trail particles.'
      )
    }

    const radius = 0.5 * size
    context.beginPath()
    context.arc(radius, radius, radius, 0, 2 * Math.PI, false)
    context.fillStyle = particleColor
    context.fill()
  } else {
    const relativeWidth = aspectRatio >= 1 ? 1 : aspectRatio //NOSONAR(S7766) - Keep similarity to line below
    const relativeHeight = aspectRatio <= 1 ? 1 : 1 / aspectRatio
    const width = relativeWidth * size
    const height = relativeHeight * size

    // Put the particle in the centre of the texture.
    const x = 0.5 * (size - width)
    const y = 0.5 * (size - height)

    context.fillStyle = particleColor
    context.fillRect(x, y, width, height)
  }

  const data = context.getImageData(0, 0, size, size).data
  return createTexture(gl, gl.LINEAR, data, size, size)
}

/** Loads the sprite image into a new texture. */
export async function createSpriteTexture(
  gl: WebGL2RenderingContext,
  options: ParticleAppearanceOptions
): Promise<WebGLTexture> {
  if (!options.spriteUrl) {
    throw new Error(
      'Cannot create sprite texture if no sprite URL has been specified.'
    )
  }

  const sprite = new Image()
  sprite.src = options.spriteUrl.toString()
  await sprite.decode()

  const size = particleTextureSize(options)

  // Note: sprite images will always be squeezed into a square.
  const bitmap = await createImageBitmap(sprite, {
    resizeWidth: size,
    resizeHeight: size,
    resizeQuality: 'high'
  })

  return createTexture(gl, gl.LINEAR, bitmap, size, size)
}
