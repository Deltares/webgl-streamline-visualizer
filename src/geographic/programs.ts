import particleVertexBody from '../shaders/geo_particle.vert.glsl'
import renderVertexBody from '../shaders/geo_render.vert.glsl'
import finalVertexBody from '../shaders/geo_final.vert.glsl'
import placeholderFragmentSource from '../shaders/placeholder.frag.glsl'
import renderFragmentSource from '../shaders/render.frag.glsl'
import finalFragmentSource from '../shaders/geo_final.frag.glsl'

import { FragmentShader, VertexShader } from '../utils/shader'
import { ShaderProgram } from '../utils/shader-program'

/**
 * MapLibre's shader data for the current projection
 * (`CustomRenderMethodInput.shaderData`).
 */
export interface ProjectionShaderData {
  /** Changes whenever the other properties change; used as cache key. */
  variantName: string
  /** Declares `projectTile` and the `u_projection_*` uniforms. */
  vertexShaderPrelude: string
  define: string
}

/**
 * MapLibre's projection uniforms for the current frame
 * (`CustomRenderMethodInput.defaultProjectionData`), for which `projectTile`
 * takes Web Mercator in 0..1.
 */
export interface ProjectionUniformData {
  mainMatrix: ArrayLike<number>
  fallbackMatrix: ArrayLike<number>
  tileMercatorCoords: ArrayLike<number>
  clippingPlane: ArrayLike<number>
  projectionTransition: number
}

/**
 * Fixed attribute locations, so that vertex arrays work with every projection
 * variant of a program.
 */
export const ATTRIBUTE_LOCATIONS = {
  propagate: { a_particle_data: 0, a_particle_age: 1 },
  render: { a_position: 0, a_tex_coord: 1 },
  final: { a_mercator: 0 }
} as const

/** Assembles a geographic vertex shader with MapLibre's prelude. */
export function assembleVertexShader(
  shaderData: ProjectionShaderData,
  body: string
): string {
  return `#version 300 es\n${shaderData.vertexShaderPrelude}\n${shaderData.define}\n${body}`
}

/** The programs of geographic mode, for one projection variant. */
export class GeographicPrograms {
  private constructor(
    readonly propagate: ShaderProgram,
    readonly render: ShaderProgram,
    readonly final: ShaderProgram
  ) {}

  static async create(
    gl: WebGL2RenderingContext,
    shaderData: ProjectionShaderData
  ): Promise<GeographicPrograms> {
    const vertex = (body: string) =>
      new VertexShader(gl, assembleVertexShader(shaderData, body))

    const propagate = new ShaderProgram(
      gl,
      vertex(particleVertexBody),
      new FragmentShader(gl, placeholderFragmentSource),
      ['v_new_particle_data', 'v_new_particle_age'],
      ATTRIBUTE_LOCATIONS.propagate
    )
    const render = new ShaderProgram(
      gl,
      vertex(renderVertexBody),
      new FragmentShader(gl, renderFragmentSource),
      undefined,
      ATTRIBUTE_LOCATIONS.render
    )
    const final = new ShaderProgram(
      gl,
      vertex(finalVertexBody),
      new FragmentShader(gl, finalFragmentSource),
      undefined,
      ATTRIBUTE_LOCATIONS.final
    )
    const programs = [propagate, render, final]
    try {
      await Promise.all(programs.map(program => program.link()))
    } catch (error) {
      programs.forEach(program => program.destruct())
      throw error
    }
    return new GeographicPrograms(propagate, render, final)
  }

  destruct(): void {
    this.propagate.destruct()
    this.render.destruct()
    this.final.destruct()
  }
}

/**
 * Compiles the geographic programs once per projection variant.
 *
 * Linking is asynchronous: {@link get} returns null until the programs for a
 * variant are ready, so callers skip drawing instead of blocking the frame.
 */
export class GeographicProgramCache {
  private readonly programs = new Map<string, GeographicPrograms>()
  private readonly pending = new Set<string>()
  private readonly failed = new Set<string>()
  private isDestroyed = false

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly onReady?: () => void
  ) {}

  get(shaderData: ProjectionShaderData): GeographicPrograms | null {
    const name = shaderData.variantName
    const programs = this.programs.get(name)
    if (programs) return programs
    if (!this.pending.has(name) && !this.failed.has(name)) {
      // Errors are logged in compile; a failed variant is not retried.
      this.compile(shaderData).catch(() => {})
    }
    return null
  }

  /** Compiles the programs for a variant, and resolves when they are ready. */
  async prepare(shaderData: ProjectionShaderData): Promise<void> {
    if (this.programs.has(shaderData.variantName)) return
    await this.compile(shaderData)
  }

  destruct(): void {
    this.isDestroyed = true
    this.programs.forEach(programs => programs.destruct())
    this.programs.clear()
  }

  private async compile(shaderData: ProjectionShaderData): Promise<void> {
    const name = shaderData.variantName
    this.pending.add(name)
    try {
      const programs = await GeographicPrograms.create(this.gl, shaderData)
      if (this.isDestroyed) {
        programs.destruct()
        return
      }
      this.programs.set(name, programs)
      this.onReady?.()
    } catch (error) {
      this.failed.add(name)
      console.error(
        `Failed to compile geographic shaders for projection "${name}":`,
        error
      )
      throw error
    } finally {
      this.pending.delete(name)
    }
  }
}

/** Sets the `u_projection_*` uniforms that the prelude declares. */
export function setProjectionUniforms(
  program: ShaderProgram,
  data: ProjectionUniformData
): void {
  const gl = program.gl
  const matrix = (name: string, value: ArrayLike<number>) => {
    const location = program.findUniformLocation(name)
    if (location) gl.uniformMatrix4fv(location, false, Float32Array.from(value))
  }
  const vec4 = (name: string, value: ArrayLike<number>) => {
    const location = program.findUniformLocation(name)
    if (location) {
      gl.uniform4f(
        location,
        value[0] as number,
        value[1] as number,
        value[2] as number,
        value[3] as number
      )
    }
  }

  matrix('u_projection_matrix', data.mainMatrix)
  matrix('u_projection_fallback_matrix', data.fallbackMatrix)
  vec4('u_projection_tile_mercator_coords', data.tileMercatorCoords)
  vec4('u_projection_clipping_plane', data.clippingPlane)
  const transition = program.findUniformLocation('u_projection_transition')
  if (transition) gl.uniform1f(transition, data.projectionTransition)
}
