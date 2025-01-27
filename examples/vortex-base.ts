import { Colormap } from '@/utils/colormap'
import { VelocityImage } from '@/utils/wms'
import {
  StreamlineVisualiser,
  type StreamlineVisualiserOptions
} from '@/visualiser'

import './options'
import type { VisualiserOptionsControl } from './options'

function createColormap(): Colormap {
  const values = [0, 0.25, 0.5, 0.75, 1]
  const colors = [
    { r: 254, g: 235, b: 226 },
    { r: 251, g: 180, b: 185 },
    { r: 247, g: 104, b: 161 },
    { r: 197, g: 27, b: 138 },
    { r: 122, g: 1, b: 119 }
  ]
  return new Colormap(values, colors)
}

function createVelocityImage(width: number, height: number): VelocityImage {
  // Velocities are in the range [-1, 1], output should be in the range [0, 1].
  //
  // u = c * scale + offset
  // c = (u - offset) / scale
  //
  //  (-1 - offset) / scale = 0 => -1 - offset = 0 => offset = -1
  //  ( 1 - offset) / scale = 1 => 2 / scale = 1 => scale = 2
  const uScale = 2
  const vScale = 2
  const uOffset = -1
  const vOffset = -1

  const data: number[] = []
  for (let row = 0; row < height; row++) {
    // Images are always specified with flipped y-coordinate.
    const y = (1.0 - row / height) * Math.PI
    for (let col = 0; col < width; col++) {
      const x = (col / width) * Math.PI

      // (Undamped) Taylor-Green vortex, velocities in the range [-1, 1].
      const u = Math.sin(x) * Math.cos(y)
      const v = -Math.cos(x) * Math.sin(y)

      // Translate to the range [0, 255] and round; this is the inverse
      // operation from how we translate pixel values to velocities.
      const uScaled = ((u - uOffset) / uScale) * 255
      const vScaled = ((v - vOffset) / vScale) * 255

      // Set R and G channels and leave B channel zero, then append to the data
      // array. Strides from smallest to largest: RGB, columns, rows.
      data.push(uScaled, vScaled, 0)
    }
  }

  const dataBuffer = new Uint8ClampedArray(data)
  return new VelocityImage(
    dataBuffer,
    width,
    height,
    uOffset,
    vOffset,
    uScale,
    vScale
  )
}

export async function initialiseVisualiser(
  numParticles: number,
  options: StreamlineVisualiserOptions
): Promise<StreamlineVisualiser> {
  // Get the canvas and make sure its contents are rendered at the same
  // resolution as its size.
  const canvas = document.getElementById('canvas') as HTMLCanvasElement
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  canvas.width = width
  canvas.height = height

  // Initialise WebGL2 context.
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    throw new Error('Could not create WebGL2 rendering context.')
  }

  // Use same particle texture size as the initial particle size.
  const particleTextureSize = options.particleSize

  // Create visualiser.
  const visualiser = new StreamlineVisualiser(
    gl,
    width,
    height,
    numParticles,
    particleTextureSize,
    options
  )

  // Create and set demo colormap and velocity image.
  const colormap = createColormap()
  const velocityImage = createVelocityImage(width, height)

  await visualiser.initialise(colormap)
  visualiser.setVelocityImage(velocityImage, true)

  // Enable rendering mode in the visualiser.
  visualiser.start()

  // Render a new frame every frame, taking into account the time between
  // subsequent frames.
  let previousFrameTime: number | null = null
  const renderFrame = (now: number) => {
    const dt = previousFrameTime ? (now - previousFrameTime) / 1000 : 1 / 60
    previousFrameTime = now

    visualiser.renderFrame(dt)

    window.requestAnimationFrame(renderFrame)
  }
  window.requestAnimationFrame(renderFrame)

  return visualiser
}

export function initialiseControl(visualiser: StreamlineVisualiser): void {
  const control = document.getElementById(
    'options-control'
  ) as VisualiserOptionsControl

  control.attachVisualiser(visualiser)
}
