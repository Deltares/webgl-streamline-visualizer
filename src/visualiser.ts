import particleVertexShaderSource from './shaders/particle.vert.glsl'
import renderVertexShaderSource from './shaders/render.vert.glsl'
import textureVertexShaderSource from './shaders/texture.vert.glsl'
import finalVertexShaderSource from './shaders/final.vert.glsl'

import placeholderFragmentShaderSource from './shaders/placeholder.frag.glsl'
import renderFragmentShaderSource from './shaders/render.frag.glsl'
import textureFragmentShaderSource from './shaders/texture.frag.glsl'
import finalFragmentShaderSource from './shaders/final.frag.glsl'

import { ShaderProgram } from './utils/shader-program'
import { SpeedCurve } from './utils/speedcurve'
import { createTexture } from './utils/textures'
import {
  StreamlineStyle,
  FinalRenderer,
  ParticlePropagator,
  ParticleRenderer,
  TextureRenderer
} from './render'
import { VelocityImage } from './utils/wms'
import { Colormap } from './utils/colormap'
import type { BoundingBoxScaling } from './render/final'
import { FragmentShader, VertexShader } from './utils/shader'

export interface StreamlineVisualiserOptions {
  style: StreamlineStyle
  numEliminatePerSecond: number
  particleSize: number
  speedFactor: number
  fadeAmountPerSecond: number
  maxDisplacement: number
  speedExponent?: number
  particleColor?: string
}

export class StreamlineVisualiser {
  private readonly MAX_NUM_SUBSTEPS = 32

  private gl: WebGL2RenderingContext
  private width: number
  private height: number
  private isRendering: boolean
  private _numParticles: number
  private particleTextureSize: number
  private _options: StreamlineVisualiserOptions
  private textureRenderer: TextureRenderer | null
  private particlePropagator: ParticlePropagator | null
  private particleRenderer: ParticleRenderer | null
  private finalRenderer: FinalRenderer | null
  private scaling: BoundingBoxScaling
  private previousParticleTexture: WebGLTexture | null
  private currentParticleTexture: WebGLTexture | null
  private velocityImage: VelocityImage | null
  private colorMap: Colormap | null
  private dtMin: number

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    numParticles: number,
    particleTextureSize: number,
    options: StreamlineVisualiserOptions
  ) {
    this.gl = gl
    this.width = width
    this.height = height
    this.isRendering = false
    this._numParticles = numParticles
    this.particleTextureSize = particleTextureSize
    this._options = { ...options }
    this.textureRenderer = null
    this.particlePropagator = null
    this.particleRenderer = null
    this.finalRenderer = null
    this.scaling = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 }
    this.previousParticleTexture = null
    this.currentParticleTexture = null
    this.velocityImage = null
    this.colorMap = null
    this.dtMin = 0
  }

  // Compute optimal particle data texture width/height; there are limits to
  // the size of each dimensions of a texture, so to support an acceptable
  // number of particles, we need to store them in a 2D texture, instead of
  // a simple 1D texture.
  private get widthParticlePositionTexture(): number {
    return Math.ceil(Math.sqrt(this._numParticles))
  }
  private get heightParticlePositionTexture(): number {
    return this.widthParticlePositionTexture
  }

  private get numParticlesAllocate(): number {
    return (
      this.widthParticlePositionTexture * this.heightParticlePositionTexture
    )
  }

  get isInitialised(): boolean {
    return (
      this.particlePropagator !== null &&
      this.particleRenderer !== null &&
      this.finalRenderer !== null
    )
  }

  get options(): StreamlineVisualiserOptions {
    return { ...this._options }
  }

  get numParticles(): number {
    return this._numParticles
  }

  async initialise(colormap: Colormap): Promise<void> {
    this.colorMap = colormap

    const [
      programUpdateParticles,
      programRenderParticles,
      programRenderTexture,
      programRenderFinal
    ] = await this.compileShaderPrograms()

    // Create a texture to use as the particle sprite.
    const particleTexture = this.createParticleTexture()

    // Compute speed curve based on the colormap and options.
    const speedCurve = StreamlineVisualiser.computeSpeedCurve(
      colormap,
      this._options
    )

    // Create and the renderers for the different stages of the visualisation.
    this.textureRenderer = new TextureRenderer(programRenderTexture)
    this.particlePropagator = new ParticlePropagator(
      programUpdateParticles,
      this.width,
      this.height,
      this._numParticles,
      this.numParticlesAllocate,
      this._options.numEliminatePerSecond,
      speedCurve
    )
    this.particleRenderer = new ParticleRenderer(
      programRenderParticles,
      this.width,
      this.height,
      this._numParticles,
      this._options.particleSize,
      particleTexture,
      this.widthParticlePositionTexture,
      this.heightParticlePositionTexture
    )
    this.finalRenderer = new FinalRenderer(
      programRenderFinal,
      this._options.style,
      colormap
    )

    this.textureRenderer.initialise()
    this.particlePropagator.initialise()
    this.particleRenderer.initialise()
    this.finalRenderer.initialise()

    this.previousParticleTexture = this.createZeroTexture()
    this.currentParticleTexture = this.createZeroTexture()
    this.textureRenderer.resetParticleTextures(
      this.previousParticleTexture,
      this.currentParticleTexture
    )
  }

  start(): void {
    if (!this.isInitialised) {
      throw new Error('Cannot start rendering for uninitialised visualiser.')
    }
    this.isRendering = true
  }

  stop(): void {
    this.isRendering = false
  }

  destruct(): void {
    if (this.textureRenderer) this.textureRenderer.destruct()
    if (this.particlePropagator) this.particlePropagator.destruct()
    if (this.particleRenderer) this.particleRenderer.destruct()
    if (this.finalRenderer) this.finalRenderer.destruct()
    this.gl.deleteTexture(this.previousParticleTexture)
    this.gl.deleteTexture(this.currentParticleTexture)
  }

  setScaling(scaling: BoundingBoxScaling): void {
    this.scaling = scaling
  }

  setDimensions(width: number, height: number): void {
    if (!this.particlePropagator || !this.particleRenderer) {
      throw new Error('Cannot set dimensions for uninitialised visualiser.')
    }
    if (this.width === width && this.height === height) return

    this.width = width
    this.height = height

    this.previousParticleTexture = this.createZeroTexture()
    this.currentParticleTexture = this.createZeroTexture()

    this.particlePropagator?.setDimensions(width, height)
    this.particleRenderer?.setDimensions(width, height)

    if (this.velocityImage) {
      // We need to recompute the time step because our pixel size has changed.
      this.dtMin = this.computeMinimumTimeStep()
    }
  }

  setNumParticles(numParticles: number): void {
    if (!this.particlePropagator || !this.particleRenderer) {
      throw new Error(
        'Cannot set number of particles for uninitialised visualiser.'
      )
    }
    if (this._numParticles === numParticles) return

    this.resetParticleTexture()

    this._numParticles = numParticles

    this.particlePropagator?.setNumParticles(
      this._numParticles,
      this.numParticlesAllocate
    )
    this.particleRenderer?.setNumParticles(
      this._numParticles,
      this.widthParticlePositionTexture,
      this.heightParticlePositionTexture
    )
  }

  setColorMap(colorMap: Colormap): void {
    if (!this.finalRenderer || !this.particlePropagator) {
      throw new Error('Cannot set colormap for uninitialised visualiser.')
    }
    this.colorMap = colorMap
    this.finalRenderer.setColorMap(this.colorMap)

    // Update the speed curve from the new colormap.
    const curve = StreamlineVisualiser.computeSpeedCurve(
      colorMap,
      this._options
    )
    this.particlePropagator.setSpeedCurve(curve)
  }

  setVelocityImage(
    velocityImage: VelocityImage,
    doResetParticles: boolean
  ): void {
    if (doResetParticles) this.resetParticleTexture()
    this.updateVelocityImage(velocityImage)
  }

  updateOptions(options: Partial<StreamlineVisualiserOptions>) {
    if (
      !this.colorMap ||
      !this.particlePropagator ||
      !this.particleRenderer ||
      !this.finalRenderer
    ) {
      throw new Error('Cannot update options for an uninitialised visualiser.')
    }
    this._options = { ...this._options, ...options }

    if (this.velocityImage) {
      // Use the old minimum time step to compute the new one based on the change
      // in maximum displacement.
      this.dtMin = this.computeMinimumTimeStep()
    }

    this.particlePropagator.numEliminatePerSecond =
      this._options.numEliminatePerSecond

    const curve = StreamlineVisualiser.computeSpeedCurve(
      this.colorMap,
      this._options
    )
    this.particlePropagator.setSpeedCurve(curve)

    this.particleRenderer.particleSize = this._options.particleSize

    this.finalRenderer.style = this._options.style
  }

  renderFrame(dt: number) {
    // Return immediately if we are not rendering.
    if (!this.isRendering) return
    if (
      !this.textureRenderer ||
      !this.particlePropagator ||
      !this.particleRenderer ||
      !this.finalRenderer ||
      !this.previousParticleTexture ||
      !this.currentParticleTexture
    ) {
      throw new Error(
        'Visualiser was not initialised before attempting to render frame.'
      )
    }

    // Check whether we need to do any substepping.
    const needSubstepping = dt > this.dtMin
    // Never do more than a certain number of substeps.
    const numSubSteps = needSubstepping
      ? Math.min(Math.floor(dt / this.dtMin), this.MAX_NUM_SUBSTEPS)
      : 1
    const dtSub = needSubstepping ? dt / numSubSteps : dt
    for (let i = 0; i < numSubSteps; i++) {
      // Render the previous particle frame (i.e. a frame with only the
      // particles, not velocity magnitude colours) to a texture, fading it by
      // an amount proportional to the current time step.
      let fadeAmount = this._options.fadeAmountPerSecond * dtSub
      // We render the alpha channel with 8-bit precision, so we cannot
      // represent amounts below 1/255. If our fade amount is below this number,
      // randomly fade the texture by 1/255, with a probability proportional to
      // the desired fade amount.
      const fadeAmountMin = 1 / 255
      if (fadeAmount < fadeAmountMin) {
        const fadeProbability = fadeAmount / fadeAmountMin
        fadeAmount = Math.random() < fadeProbability ? fadeAmountMin : 0
      }
      this.textureRenderer.render(this.previousParticleTexture, fadeAmount)

      // Update the particle positions into an output buffer.
      this.particlePropagator.update(dtSub)

      // Use the updated particle position to render sprites at those locations.
      // These particles are rendered on top of the previous particle frame to
      // produce the fading "comet trails".
      this.particleRenderer.render(this.particlePropagator.buffer)

      // Do not swap at the last time step as we need the latest particle
      // texture for the final render.
      if (i < numSubSteps - 1) this.swapParticleTextures()
    }

    // Finally, render the velocity magnitude with the particles (and trails)
    // blended with it.
    this.finalRenderer.render(this.currentParticleTexture, this.scaling)

    // Swap previous and current particle texture.
    this.swapParticleTextures()
  }

  private async compileShaderPrograms(): Promise<
    [ShaderProgram, ShaderProgram, ShaderProgram, ShaderProgram]
  > {
    // Create vertex shaders.
    const particleVertexShader = new VertexShader(
      this.gl,
      particleVertexShaderSource
    )
    const renderVertexShader = new VertexShader(
      this.gl,
      renderVertexShaderSource
    )
    const textureVertexShader = new VertexShader(
      this.gl,
      textureVertexShaderSource
    )
    const finalVertexShader = new VertexShader(this.gl, finalVertexShaderSource)

    // Create fragment shaders.
    const placeholderFragmentShader = new FragmentShader(
      this.gl,
      placeholderFragmentShaderSource
    )
    const renderFragmentShader = new FragmentShader(
      this.gl,
      renderFragmentShaderSource
    )
    const textureFragmentShader = new FragmentShader(
      this.gl,
      textureFragmentShaderSource
    )
    const finalFragmentShader = new FragmentShader(
      this.gl,
      finalFragmentShaderSource
    )

    // Create shader programs.
    const programUpdateParticles = new ShaderProgram(
      this.gl,
      particleVertexShader,
      placeholderFragmentShader,
      ['v_position']
    )
    const programRenderParticles = new ShaderProgram(
      this.gl,
      renderVertexShader,
      renderFragmentShader
    )
    const programRenderTexture = new ShaderProgram(
      this.gl,
      textureVertexShader,
      textureFragmentShader
    )
    const programRenderFinal = new ShaderProgram(
      this.gl,
      finalVertexShader,
      finalFragmentShader
    )

    // Wait until all shader programs have been linked.
    await Promise.all(
      [
        programUpdateParticles,
        programRenderParticles,
        programRenderTexture,
        programRenderFinal
      ].map(program => program.link())
    )

    return [
      programUpdateParticles,
      programRenderParticles,
      programRenderTexture,
      programRenderFinal
    ]
  }

  private computeMinimumTimeStep(): number {
    if (!this.velocityImage) {
      throw new Error(
        'Cannot compute minimum time step if velocity image was not set.'
      )
    }
    // Convert maximum displacement from pixels to clip coordinates in x- and
    // y-direction. Note that clip coordinates run from -1 to 1, hence the
    // factor 2.
    const maxDisplacementX = (this._options.maxDisplacement / this.width) * 2
    const maxDisplacementY = (this._options.maxDisplacement / this.height) * 2

    // Convert the maximum velocity from physical units to clip coordinates,
    // similar to how it is done in the particle propagator shader.
    let [maxU, maxV] = this.velocityImage.maxVelocity()
    maxU *= (this.height / this.width) * this._options.speedFactor
    maxV *= this._options.speedFactor

    // Compute time step such that the maximum velocity results in the maximum
    // acceptable displacement.
    const dtMinU = maxDisplacementX / maxU
    const dtMinV = maxDisplacementY / maxV
    return Math.min(dtMinU, dtMinV)
  }

  private createParticleTexture(): WebGLTexture {
    const radius = 0.5 * this.particleTextureSize
    const width = this.particleTextureSize
    const height = this.particleTextureSize
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('Could not initialise 2D offscreen canvas.')
    }

    const x = radius
    const y = radius
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius)

    const particleColor = this._options.particleColor ?? 'black'
    gradient.addColorStop(0, particleColor)
    gradient.addColorStop(0.8, particleColor)
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')

    context.beginPath()
    context.arc(x, y, radius, 0, 2 * Math.PI, false)
    context.fillStyle = gradient
    context.fill()

    const data = context.getImageData(0, 0, width, height).data
    return createTexture(this.gl, this.gl.LINEAR, data, width, height)
  }

  private createZeroTexture(): WebGLTexture {
    // Create texture initialised to zeros.
    const zeros = new Uint8Array(this.width * this.height * 4)
    return createTexture(
      this.gl,
      this.gl.LINEAR,
      zeros,
      this.width,
      this.height
    )
  }

  private swapParticleTextures(): void {
    const temp = this.previousParticleTexture
    this.previousParticleTexture = this.currentParticleTexture
    this.currentParticleTexture = temp
    // Also swap frame buffers in the texture renderer, as those render into the
    // swapped textures.
    this.textureRenderer?.swapBuffers()
  }

  private resetParticleTexture(): void {
    this.previousParticleTexture = this.createZeroTexture()
    this.currentParticleTexture = this.createZeroTexture()
    this.textureRenderer?.resetParticleTextures(
      this.previousParticleTexture,
      this.currentParticleTexture
    )
  }

  private updateVelocityImage(velocityImage: VelocityImage): void {
    if (!this.particlePropagator || !this.finalRenderer) {
      throw new Error('Cannot set velocity image for uninitialised visualiser.')
    }
    this.velocityImage = velocityImage
    this.particlePropagator.setVelocityImage(velocityImage)
    this.finalRenderer.setVelocityImage(velocityImage)
    this.dtMin = this.computeMinimumTimeStep()
  }

  private static computeSpeedCurve(
    colormap: Colormap,
    options: StreamlineVisualiserOptions
  ): SpeedCurve {
    return SpeedCurve.fromExponentFactorAndSpeed(
      options.speedExponent ?? 1.0,
      options.speedFactor,
      colormap.end
    )
  }
}
