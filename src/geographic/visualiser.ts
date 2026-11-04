import fadeVertexShaderSource from '../shaders/fade.vert.glsl'
import fadeFragmentShaderSource from '../shaders/fade.frag.glsl'

import { FadeRenderer } from '../render'
import { ParticleBuffers } from '../render/propagator'
import type { Colormap } from '../utils/colormap'
import {
  createParticleTexture,
  createSpriteTexture,
  determineDoRotateParticles,
  parseCssColor
} from '../utils/particle-texture'
import { FragmentShader, VertexShader } from '../utils/shader'
import {
  ShaderProgram,
  bindTexture,
  createAndFillStaticBuffer
} from '../utils/shader-program'
import { SpeedCurve } from '../utils/speedcurve'
import { createTexture } from '../utils/textures'
import type { StreamlineVisualiserOptions } from '../visualiser'
import { createDomainMeshData, mercatorBoundsOf } from './domain-mesh'
import {
  ATTRIBUTE_LOCATIONS,
  GeographicProgramCache,
  type GeographicPrograms,
  type ProjectionShaderData,
  type ProjectionUniformData,
  setProjectionUniforms
} from './programs'
import type { RegularVelocityChunk } from './regular-velocity-chunk'

/**
 * Maps the screen to the sphere, for spawning particles.
 *
 * A grid of `width` × `height` cells over the viewport, row-major, four floats
 * per cell: the unit vector (x, y, z) of the location under the cell centre,
 * and the probability of accepting a spawn there: 0 where no particle may
 * spawn, and 1 / n where the location shows on screen in n world copies, so
 * that particles are spread evenly over the screen.
 */
export interface SpawnTable {
  width: number
  height: number
  data: Float32Array
}

/** Per-frame input of the geographic visualiser. */
export interface GeographicView {
  shaderData: ProjectionShaderData
  projectionData: ProjectionUniformData
  /** Metres per drawing-buffer pixel at the view centre. */
  metresPerPixel: number
  /** Replace the object (not its data) when the table changes. */
  spawnTable: SpawnTable
  /** Range of world copies to draw, as offsets in Web Mercator x. */
  worldCopies: [min: number, max: number]
  /** Whether the camera changed since the previous frame. */
  cameraChanged: boolean
}

/**
 * Animates particles on the sphere, projected by MapLibre.
 *
 * The counterpart of `StreamlineVisualiser` for geographic mode: particles are
 * stored as longitude and latitude, the velocity field covers its own domain
 * instead of the viewport, and every projection MapLibre supports (Mercator,
 * globe, and the transition between them) works through its `projectTile`.
 *
 * Drive it from a MapLibre custom layer, as `GeographicStreamlineLayer` does:
 * call {@link setView} and then {@link renderFrame} in every `render`.
 */
export class GeographicStreamlineVisualiser {
  private readonly MAX_NUM_SUBSTEPS = 32
  private readonly DEFAULT_GROWTH_RATE = 5
  private readonly NUM_SEGMENTS_COLORMAP = 64

  private readonly gl: WebGL2RenderingContext
  private width: number
  private height: number
  private _numParticles: number
  private _options: StreamlineVisualiserOptions
  private isRendering = false

  private readonly programs: GeographicProgramCache
  private fadeRenderer: FadeRenderer | null = null

  private inputBuffers: ParticleBuffers | null = null
  private outputBuffers: ParticleBuffers | null = null
  private transformFeedback: WebGLTransformFeedback | null = null
  private particleDataTexture: WebGLTexture | null = null
  private particleAgeTexture: WebGLTexture | null = null

  private quadBuffers: WebGLBuffer[] = []
  private quadVertexArray: WebGLVertexArrayObject | null = null
  private meshBuffers: WebGLBuffer[] = []
  private meshVertexArray: WebGLVertexArrayObject | null = null
  private meshIndexCount = 0

  private trailTexture: WebGLTexture | null = null
  private particleTexture: WebGLTexture | null = null
  private spriteTexture: WebGLTexture | null = null
  private colormap: Colormap | null = null
  private particleColor: [number, number, number] = [0, 0, 0]
  private colormapTexture: WebGLTexture | null = null
  private speedCurve: SpeedCurve | null = null

  private field: RegularVelocityChunk | null = null
  private velocityTexture: WebGLTexture | null = null
  private dtMin = Infinity

  private view: GeographicView | null = null
  private spawnTable: SpawnTable | null = null
  private spawnTableTexture: WebGLTexture | null = null

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    numParticles: number,
    options: StreamlineVisualiserOptions,
    onProgramsReady?: () => void
  ) {
    this.gl = gl
    this.width = width
    this.height = height
    this._numParticles = numParticles
    this._options = { ...options }
    this.programs = new GeographicProgramCache(gl, onProgramsReady)
  }

  get options(): StreamlineVisualiserOptions {
    return { ...this._options }
  }

  get numParticles(): number {
    return this._numParticles
  }

  get isInitialised(): boolean {
    return this.fadeRenderer !== null
  }

  /** The velocity field, or null if none has been set. */
  get velocityField(): RegularVelocityChunk | null {
    return this.field
  }

  private get widthParticleDataTexture(): number {
    return Math.ceil(Math.sqrt(this._numParticles))
  }

  private get numParticlesAllocate(): number {
    return this.widthParticleDataTexture ** 2
  }

  async initialise(colormap: Colormap): Promise<void> {
    const gl = this.gl
    const programFade = new ShaderProgram(
      gl,
      new VertexShader(gl, fadeVertexShaderSource),
      new FragmentShader(gl, fadeFragmentShaderSource)
    )
    await programFade.link()
    this.fadeRenderer = new FadeRenderer(programFade)
    this.fadeRenderer.initialise()

    this.transformFeedback = gl.createTransformFeedback()
    this.createQuad()
    this.resetParticleStorage()
    this.resetTrailTexture()
    this.setColorMap(colormap)
    this.particleTexture = createParticleTexture(gl, this._options)
    this.particleColor = parseCssColor(this._options.particleColor ?? 'black')
    if (this._options.spriteUrl) {
      this.spriteTexture = await createSpriteTexture(gl, this._options)
    }
  }

  /** Compiles the programs for a projection ahead of the first frame. */
  async prepare(shaderData: ProjectionShaderData): Promise<void> {
    await this.programs.prepare(shaderData)
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
    const gl = this.gl
    this.programs.destruct()
    this.fadeRenderer?.destruct()
    this.inputBuffers?.destroy()
    this.outputBuffers?.destroy()
    gl.deleteTransformFeedback(this.transformFeedback)
    for (const texture of [
      this.particleDataTexture,
      this.particleAgeTexture,
      this.trailTexture,
      this.particleTexture,
      this.spriteTexture,
      this.colormapTexture,
      this.velocityTexture,
      this.spawnTableTexture
    ]) {
      gl.deleteTexture(texture)
    }
    this.deleteQuad()
    this.deleteMesh()
  }

  setDimensions(width: number, height: number): void {
    if (this.width === width && this.height === height) return
    this.width = width
    this.height = height
    if (this.isInitialised) this.resetTrailTexture()
    this.dtMin = this.computeMinimumTimeStep()
  }

  setNumParticles(numParticles: number): void {
    if (this._numParticles === numParticles) return
    this._numParticles = numParticles
    if (this.isInitialised) {
      this.resetParticleStorage()
      this.fadeRenderer?.clear()
    }
  }

  setColorMap(colormap: Colormap): void {
    this.colormap = colormap
    this.gl.deleteTexture(this.colormapTexture)
    this.colormapTexture = colormap.toTexture(
      this.gl,
      this.NUM_SEGMENTS_COLORMAP
    )
    this.speedCurve = SpeedCurve.fromExponentFactorAndSpeed(
      this._options.speedExponent ?? 1.0,
      this._options.speedFactor,
      colormap.end
    )
    this.dtMin = this.computeMinimumTimeStep()
  }

  /**
   * Sets the velocity field. Its values are uploaded once.
   *
   * @param field the new field.
   * @param doResetParticles whether to restart all particles and clear their
   *   trails; when false, particles move on in the new field.
   */
  setVelocityField(
    field: RegularVelocityChunk,
    doResetParticles: boolean
  ): void {
    if (!this.isInitialised) {
      throw new Error('Cannot set velocity field for uninitialised visualiser.')
    }
    const gl = this.gl
    const domainChanged =
      this.field === null ||
      JSON.stringify(mercatorBoundsOf(this.field)) !==
        JSON.stringify(mercatorBoundsOf(field))

    this.field = field
    gl.deleteTexture(this.velocityTexture)
    this.velocityTexture = field.createTexture(gl)
    if (domainChanged) this.createMesh(field)
    this.dtMin = this.computeMinimumTimeStep()

    if (doResetParticles) {
      this.resetParticleStorage()
      this.fadeRenderer?.clear()
    }
  }

  async updateOptions(
    options: Partial<StreamlineVisualiserOptions>
  ): Promise<void> {
    const gl = this.gl
    const previous = this._options
    this._options = { ...this._options, ...options }

    if (this._options.spriteUrl === undefined) {
      gl.deleteTexture(this.spriteTexture)
      this.spriteTexture = null
    } else if (
      this.spriteTexture === null ||
      this._options.spriteUrl !== previous.spriteUrl ||
      this._options.particleSize !== previous.particleSize
    ) {
      const spriteTexture = await createSpriteTexture(gl, this._options)
      gl.deleteTexture(this.spriteTexture)
      this.spriteTexture = spriteTexture
    }

    if (this._options.maxAge !== previous.maxAge) {
      // Spread the particle ages over the new range.
      this.resetParticleStorage()
    }

    gl.deleteTexture(this.particleTexture)
    this.particleTexture = createParticleTexture(gl, this._options)
    this.particleColor = parseCssColor(this._options.particleColor ?? 'black')

    if (this.colormap) this.setColorMap(this.colormap)
  }

  /** Sets the per-frame input; call it before every {@link renderFrame}. */
  setView(view: GeographicView): void {
    this.view = view
    if (view.spawnTable !== this.spawnTable) {
      this.uploadSpawnTable(view.spawnTable)
    }
  }

  /**
   * Advances the particles by `dt` seconds and draws them into the currently
   * bound drawing buffer.
   *
   * Draws nothing until the programs for the view's projection have linked.
   */
  renderFrame(dt: number): void {
    if (!this.isRendering || !this.view || !this.field) return
    if (!this.fadeRenderer || !this.trailTexture) {
      throw new Error(
        'Visualiser was not initialised before attempting to render frame.'
      )
    }
    const programs = this.programs.get(this.view.shaderData)
    if (!programs) return

    const gl = this.gl
    // MapLibre shares the context, so set everything the passes rely on.
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)
    gl.depthMask(false)
    gl.colorMask(true, true, true, true)

    // Large time steps (e.g. when the window loses focus) would make all
    // particles die and be reborn together; spread their ages again.
    if (dt > 0.1 * this._options.maxAge) this.resetAges()

    // Trails are screen-space; they are in the wrong place once the camera
    // moves, so clear them. The particles themselves stay on the map.
    if (this.view.cameraChanged) this.fadeRenderer.clear()

    this.fadeRenderer.render(this.computeFadeAmount(dt))
    gl.viewport(0, 0, this.width, this.height)

    const needSubstepping = dt > this.dtMin
    const numSubSteps = needSubstepping
      ? Math.min(Math.floor(dt / this.dtMin), this.MAX_NUM_SUBSTEPS)
      : 1
    const dtSub = needSubstepping ? dt / numSubSteps : dt
    for (let i = 0; i < numSubSteps; i++) {
      this.propagate(programs, dtSub)
      // The fade renderer left the trail framebuffer bound.
      this.drawParticles(programs, false)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    this.drawComposite(programs)
    if (this.spriteTexture) this.drawParticles(programs, true)

    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
  }

  private propagate(programs: GeographicPrograms, dt: number): void {
    const gl = this.gl
    const program = programs.propagate
    const view = this.view
    const field = this.field
    if (
      !view ||
      !field ||
      !this.inputBuffers ||
      !this.outputBuffers ||
      !this.velocityTexture ||
      !this.spawnTableTexture ||
      !this.speedCurve
    ) {
      return
    }
    program.use()

    // The output of the previous step becomes the input of this one; the
    // output buffers are then read by the particle renderer.
    this.swapBuffers()

    // Attribute locations are fixed, so no vertex array is needed beyond the
    // buffers bound here.
    gl.bindVertexArray(null)
    const bindParticleAttribute = (
      buffer: WebGLBuffer,
      location: number,
      size: number
    ) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
    }
    bindParticleAttribute(
      this.inputBuffers.data,
      ATTRIBUTE_LOCATIONS.propagate.a_particle_data,
      4
    )
    bindParticleAttribute(
      this.inputBuffers.age,
      ATTRIBUTE_LOCATIONS.propagate.a_particle_age,
      1
    )
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    bindTexture(program, 'u_velocity_values', 0, this.velocityTexture)
    bindTexture(program, 'u_spawn_table', 1, this.spawnTableTexture)
    field.setUniforms(program, 'u_velocity_grid')
    setProjectionUniforms(program, view.projectionData)

    gl.uniform2i(
      program.getUniformLocation('u_spawn_table_size'),
      view.spawnTable.width,
      view.spawnTable.height
    )
    gl.uniform1ui(
      program.getUniformLocation('u_seed'),
      Math.floor(Math.random() * 2 ** 32) // NOSONAR(S2245) - Non-cryptographic random used for visual effect
    )
    gl.uniform1f(
      program.getUniformLocation('u_speed_factor'),
      this.speedCurve.exponent === 0
        ? this.speedCurve.baseFactor
        : this.speedCurve.factor
    )
    gl.uniform1f(
      program.getUniformLocation('u_speed_exponent'),
      this.speedCurve.exponent
    )
    gl.uniform1f(
      program.getUniformLocation('u_metres_per_clip_unit'),
      view.metresPerPixel * 0.5 * this.height
    )
    gl.uniform1f(program.getUniformLocation('u_dt'), dt)
    gl.uniform1f(
      program.getUniformLocation('u_max_age'),
      this._options.maxAge
    )
    gl.uniform1i(
      program.getUniformLocation('u_world_copy_min'),
      view.worldCopies[0]
    )
    gl.uniform1i(
      program.getUniformLocation('u_world_copy_max'),
      view.worldCopies[1]
    )

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.transformFeedback)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.outputBuffers.data)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.outputBuffers.age)
    gl.enable(gl.RASTERIZER_DISCARD)

    gl.beginTransformFeedback(gl.POINTS)
    gl.drawArrays(gl.POINTS, 0, this._numParticles)
    gl.endTransformFeedback()

    gl.disable(gl.RASTERIZER_DISCARD)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
    gl.disableVertexAttribArray(ATTRIBUTE_LOCATIONS.propagate.a_particle_data)
    gl.disableVertexAttribArray(ATTRIBUTE_LOCATIONS.propagate.a_particle_age)
  }

  private drawParticles(programs: GeographicPrograms, isSprite: boolean): void {
    const gl = this.gl
    const program = programs.render
    const view = this.view
    const texture = isSprite ? this.spriteTexture : this.particleTexture
    if (
      !view ||
      !texture ||
      !this.outputBuffers ||
      !this.particleDataTexture ||
      !this.particleAgeTexture
    ) {
      return
    }
    program.use()

    gl.enable(gl.BLEND)
    if (isSprite) {
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    } else {
      // Add the particles to the trails; alpha keeps the maximum.
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX)
      gl.blendFunc(gl.ONE, gl.ONE)
    }

    this.copyBufferToTexture(this.outputBuffers.data, this.particleDataTexture, 4)
    this.copyBufferToTexture(this.outputBuffers.age, this.particleAgeTexture, 1)

    gl.bindVertexArray(this.quadVertexArray)
    bindTexture(program, 'u_particle_texture', 0, texture)
    bindTexture(program, 'u_particle_data_texture', 1, this.particleDataTexture)
    bindTexture(program, 'u_particle_age_texture', 2, this.particleAgeTexture)
    setProjectionUniforms(program, view.projectionData)

    const scalingFactor = globalThis.devicePixelRatio ?? 1
    gl.uniform1i(
      program.getUniformLocation('u_width'),
      this.widthParticleDataTexture
    )
    // The quad's side in pixels. As in screen mode, particleSize is its side in
    // clip units times the width, and clip space is 2 units wide: particles are
    // particleSize / 2 CSS pixels across.
    gl.uniform1f(
      program.getUniformLocation('u_particle_size'),
      0.5 * this._options.particleSize * scalingFactor
    )
    gl.uniform2f(
      program.getUniformLocation('u_viewport_size'),
      this.width,
      this.height
    )
    const metresPerPixel = program.findUniformLocation('u_metres_per_pixel')
    if (metresPerPixel) gl.uniform1f(metresPerPixel, view.metresPerPixel)
    gl.uniform1i(
      program.getUniformLocation('u_do_rotate_particles'),
      isSprite || determineDoRotateParticles(this._options) ? 1 : 0
    )
    gl.uniform1f(program.getUniformLocation('u_max_age'), this._options.maxAge)
    gl.uniform1f(
      program.getUniformLocation('u_growth_rate'),
      this._options.growthRate ?? this.DEFAULT_GROWTH_RATE
    )

    const worldOffset = program.getUniformLocation('u_world_offset')
    for (let copy = view.worldCopies[0]; copy <= view.worldCopies[1]; copy++) {
      gl.uniform1f(worldOffset, copy)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._numParticles)
    }
  }

  private drawComposite(programs: GeographicPrograms): void {
    const gl = this.gl
    const program = programs.final
    const view = this.view
    if (
      !view ||
      !this.field ||
      !this.colormap ||
      !this.trailTexture ||
      !this.colormapTexture ||
      !this.velocityTexture ||
      !this.meshVertexArray
    ) {
      return
    }
    program.use()

    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    gl.bindVertexArray(this.meshVertexArray)
    bindTexture(program, 'u_particle_texture', 0, this.trailTexture)
    bindTexture(program, 'u_colormap_texture', 1, this.colormapTexture)
    bindTexture(program, 'u_velocity_values', 2, this.velocityTexture)
    this.field.setUniforms(program, 'u_velocity_grid')
    setProjectionUniforms(program, view.projectionData)

    gl.uniform1i(program.getUniformLocation('u_style'), this._options.style)
    const opacity = program.findUniformLocation('u_particle_opacity')
    if (opacity) {
      gl.uniform1f(opacity, this._options.particleOverlayOpacity ?? 1.0)
    }
    const particleColor = program.findUniformLocation('u_particle_color')
    if (particleColor) gl.uniform3f(particleColor, ...this.particleColor)
    gl.uniform1f(
      program.getUniformLocation('u_colormap_start'),
      this.colormap.start
    )
    gl.uniform1f(program.getUniformLocation('u_colormap_end'), this.colormap.end)

    const worldOffset = program.getUniformLocation('u_world_offset')
    for (let copy = view.worldCopies[0]; copy <= view.worldCopies[1]; copy++) {
      gl.uniform1f(worldOffset, copy)
      gl.drawElements(gl.TRIANGLES, this.meshIndexCount, gl.UNSIGNED_SHORT, 0)
    }
  }

  private computeMinimumTimeStep(): number {
    if (!this.field || !this.speedCurve) return Infinity
    const [maxU, maxV] = this.field.maxVelocity()
    const maxSpeed = Math.hypot(maxU, maxV)
    // Clip units per second, as in the propagation shader; one clip unit is
    // half the drawing buffer's height in pixels.
    const curve = this.speedCurve
    const clipSpeed =
      curve.exponent === 0
        ? curve.baseFactor
        : curve.factor * Math.pow(maxSpeed, curve.exponent)
    const pixelsPerSecond = clipSpeed * 0.5 * this.height
    if (!(pixelsPerSecond > 0)) return Infinity
    return this._options.maxDisplacement / pixelsPerSecond
  }

  private computeFadeAmount(dt: number): number {
    const fadeAmount = this._options.fadeAmountPerSecond * dt
    // The alpha channel has 8 bits, so amounts below 1/255 cannot be
    // represented; fade by 1/255 with a probability proportional to the
    // desired amount instead.
    const fadeAmountMin = 1 / 255
    if (fadeAmount >= fadeAmountMin) return fadeAmount
    const fadeProbability = fadeAmount / fadeAmountMin
    return Math.random() < fadeProbability ? fadeAmountMin : 0 // NOSONAR(S2245) - Non-cryptographic random used for visual effect
  }

  private resetParticleStorage(): void {
    const gl = this.gl
    this.inputBuffers?.destroy()
    this.outputBuffers?.destroy()
    this.inputBuffers = new ParticleBuffers(gl, this.numParticlesAllocate)
    this.outputBuffers = new ParticleBuffers(gl, this.numParticlesAllocate)

    // All particles start dormant (zero velocity), so the first propagation
    // step spawns them on screen, with random ages.
    const data = new Float32Array(4 * this._numParticles)
    this.outputBuffers.initialise(data, this.randomAges())

    gl.deleteTexture(this.particleDataTexture)
    gl.deleteTexture(this.particleAgeTexture)
    this.particleDataTexture = this.createDataTexture(gl.RGBA32F)
    this.particleAgeTexture = this.createDataTexture(gl.R32F)
  }

  private resetAges(): void {
    // The output buffers are the input of the next step.
    this.outputBuffers?.resetAges(this.randomAges())
  }

  private randomAges(): Float32Array {
    const ages = new Float32Array(this._numParticles)
    for (let i = 0; i < ages.length; i++) {
      ages[i] = Math.random() * this._options.maxAge // NOSONAR(S2245) - Non-cryptographic random used for visual effect
    }
    return ages
  }

  private swapBuffers(): void {
    const input = this.inputBuffers
    this.inputBuffers = this.outputBuffers
    this.outputBuffers = input
  }

  private createDataTexture(internalFormat: number): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    if (texture === null) throw new Error('Failed to create texture.')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const size = this.widthParticleDataTexture
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, size, size)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
  }

  private copyBufferToTexture(
    buffer: WebGLBuffer,
    texture: WebGLTexture,
    numComponents: 1 | 4
  ): void {
    const gl = this.gl
    const size = this.widthParticleDataTexture
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      size,
      size,
      numComponents === 1 ? gl.RED : gl.RGBA,
      gl.FLOAT,
      0
    )
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null)
  }

  private resetTrailTexture(): void {
    // Only allocate storage; attaching it to the fade renderer's framebuffer
    // clears it.
    this.gl.deleteTexture(this.trailTexture)
    this.trailTexture = createTexture(
      this.gl,
      this.gl.LINEAR,
      null,
      this.width,
      this.height
    )
    this.fadeRenderer?.setTrailTexture(this.trailTexture)
  }

  private uploadSpawnTable(table: SpawnTable): void {
    const gl = this.gl
    if (table.data.length !== 4 * table.width * table.height) {
      throw new Error('Spawn table data does not match its size.')
    }
    if (table.width < 1 || table.height < 1) {
      throw new Error('Spawn table must have at least one cell.')
    }
    const sizeChanged =
      this.spawnTable === null ||
      this.spawnTable.width !== table.width ||
      this.spawnTable.height !== table.height
    if (sizeChanged || !this.spawnTableTexture) {
      gl.deleteTexture(this.spawnTableTexture)
      this.spawnTableTexture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.spawnTableTexture)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, table.width, table.height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.spawnTableTexture)
    }
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      table.width,
      table.height,
      gl.RGBA,
      gl.FLOAT,
      table.data
    )
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.spawnTable = table
  }

  private createQuad(): void {
    const gl = this.gl
    const vertexArray = gl.createVertexArray()
    gl.bindVertexArray(vertexArray)
    // A unit quad as a triangle strip, with the texture's v flipped, as the
    // particle renderer of screen mode.
    const positions = new Float32Array([0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5])
    const texCoords = new Float32Array([1, 0, 0, 0, 1, 1, 0, 1])
    const buffers = [positions, texCoords].map((data, location) => {
      const buffer = createAndFillStaticBuffer(gl, data)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
      return buffer
    })
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    this.quadBuffers = buffers
    this.quadVertexArray = vertexArray
  }

  private deleteQuad(): void {
    this.quadBuffers.forEach(buffer => this.gl.deleteBuffer(buffer))
    this.gl.deleteVertexArray(this.quadVertexArray)
    this.quadBuffers = []
    this.quadVertexArray = null
  }

  private createMesh(field: RegularVelocityChunk): void {
    const gl = this.gl
    this.deleteMesh()
    const { vertices, indices } = createDomainMeshData(mercatorBoundsOf(field))

    const vertexArray = gl.createVertexArray()
    gl.bindVertexArray(vertexArray)
    const vertexBuffer = createAndFillStaticBuffer(gl, vertices)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    const location = ATTRIBUTE_LOCATIONS.final.a_mercator
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    const indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    this.meshBuffers = [vertexBuffer, indexBuffer]
    this.meshVertexArray = vertexArray
    this.meshIndexCount = indices.length
  }

  private deleteMesh(): void {
    this.meshBuffers.forEach(buffer => this.gl.deleteBuffer(buffer))
    this.gl.deleteVertexArray(this.meshVertexArray)
    this.meshBuffers = []
    this.meshVertexArray = null
    this.meshIndexCount = 0
  }
}

