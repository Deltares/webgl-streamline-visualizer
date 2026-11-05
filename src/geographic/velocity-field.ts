import type { ShaderProgram } from '../utils/shader-program'
import { bindTexture } from '../utils/shader-program'
import type {
  CurvilinearLookupBuilder,
  CurvilinearGridTextures
} from './curvilinear-lookup'
import { CurvilinearVelocityField } from './curvilinear-velocity-field'
import type { CurvilinearGrid } from './curvilinear-velocity-field'
import type { RegularVelocityChunk } from './regular-velocity-chunk'

/** A field that covers one grid. */
export type SingleVelocityField =
  RegularVelocityChunk | CurvilinearVelocityField

/** The fields that a nested field can hold; see `sample_field.glsl`. */
export const MAX_NESTED_FIELDS = 2

/**
 * Several fields in priority order: sampling tries the first, and falls back to
 * the next where the first is missing, which includes outside its grid.
 *
 * For a finer model nested in a coarser one, such as SWAN Kuststrook in DCSM.
 */
export class NestedVelocityField {
  readonly fields: readonly SingleVelocityField[]

  /** @param fields the fields, highest priority first. */
  constructor(fields: readonly SingleVelocityField[]) {
    if (fields.length < 1 || fields.length > MAX_NESTED_FIELDS) {
      throw new Error(
        `A nested field holds 1 to ${MAX_NESTED_FIELDS} fields, got ${fields.length}.`
      )
    }
    this.fields = [...fields]
  }

  /**
   * Samples the velocity at a position.
   *
   * @param lon longitude in degrees.
   * @param lat latitude in degrees.
   * @returns `[u, v]` of the first field that has a value, or null if none has.
   */
  sample(lon: number, lat: number): [number, number] | null {
    for (const field of this.fields) {
      const velocity = field.sample(lon, lat)
      if (velocity !== null) return velocity
    }
    return null
  }

  /** Largest absolute u and v of all fields. */
  maxVelocity(): [number, number] {
    let uMax = 0
    let vMax = 0
    for (const field of this.fields) {
      const [u, v] = field.maxVelocity()
      uMax = Math.max(uMax, u)
      vMax = Math.max(vMax, v)
    }
    return [uMax, vMax]
  }
}

/** A velocity field in geographic mode. */
export type VelocityField = SingleVelocityField | NestedVelocityField

// Must match the constants in sample_field.glsl.
const GLSL_KIND = { regular: 0, curvilinear: 1 } as const

interface Slot {
  field: SingleVelocityField
  values: WebGLTexture
}

/**
 * Holds a field's textures on the GPU, and binds them for `sample_field.glsl`.
 *
 * Values are uploaded when a field is set. A curvilinear grid's textures are
 * built once, in {@link prepare}, and kept for as long as the next field uses
 * the same grid, so changing lead times costs one value upload.
 */
export class VelocityFieldTextures {
  private slots: Slot[] = []
  private readonly gridTextures = new Map<
    CurvilinearGrid,
    CurvilinearGridTextures
  >()

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly lookupBuilder: CurvilinearLookupBuilder
  ) {}

  setField(field: VelocityField): void {
    const gl = this.gl
    const fields = field instanceof NestedVelocityField ? field.fields : [field]
    this.slots.forEach(slot => gl.deleteTexture(slot.values))
    this.slots = fields.map(single => ({
      field: single,
      values: single.createTexture(gl)
    }))

    const grids = new Set(fields.map(curvilinearGridOf))
    for (const [grid, textures] of this.gridTextures) {
      if (grids.has(grid)) continue
      gl.deleteTexture(textures.corners)
      gl.deleteTexture(textures.lookup)
      this.gridTextures.delete(grid)
    }
  }

  /**
   * Builds the textures of new curvilinear grids. This changes GL state, so
   * call it within a frame.
   */
  prepare(): void {
    for (const { field } of this.slots) {
      const grid = curvilinearGridOf(field)
      if (grid && !this.gridTextures.has(grid)) {
        this.gridTextures.set(grid, this.lookupBuilder.build(grid))
      }
    }
  }

  /**
   * Binds the textures and sets the uniforms of `sample_field.glsl`.
   *
   * @param program linked and currently used program.
   * @param firstUnit first texture unit to use; takes up to six units.
   */
  bind(program: ShaderProgram, firstUnit: number): void {
    const gl = program.gl
    gl.uniform1i(program.getUniformLocation('u_field_count'), this.slots.length)
    let unit = firstUnit
    this.slots.forEach(({ field, values }, index) => {
      const name = `u_field_${index}`
      gl.uniform1i(
        program.getUniformLocation(`${name}.kind`),
        field instanceof CurvilinearVelocityField
          ? GLSL_KIND.curvilinear
          : GLSL_KIND.regular
      )
      bindTexture(program, `u_field_values_${index}`, unit++, values)
      if (!(field instanceof CurvilinearVelocityField)) {
        field.setUniforms(program, `${name}.regular`)
        return
      }
      const textures = this.gridTextures.get(field.grid)
      if (!textures) {
        throw new Error('Prepare the velocity field before binding it.')
      }
      bindTexture(program, `u_field_lookup_${index}`, unit++, textures.lookup)
      // The composite does not use the corners, so the compiler removes them.
      if (program.findUniformLocation(`u_field_corners_${index}`)) {
        bindTexture(
          program,
          `u_field_corners_${index}`,
          unit++,
          textures.corners
        )
      }
      setCurvilinearUniforms(program, `${name}.curvilinear`, textures)
    })
  }

  destruct(): void {
    const gl = this.gl
    this.slots.forEach(slot => gl.deleteTexture(slot.values))
    this.slots = []
    this.gridTextures.forEach(textures => {
      gl.deleteTexture(textures.corners)
      gl.deleteTexture(textures.lookup)
    })
    this.gridTextures.clear()
    this.lookupBuilder.destruct()
  }
}

/** Sets a `CurvilinearGrid` uniform struct (see `sample_curvilinear.glsl`). */
function setCurvilinearUniforms(
  program: ShaderProgram,
  name: string,
  textures: CurvilinearGridTextures
): void {
  const gl = program.gl
  const { grid, lookupOrigin, lookupScale } = textures
  const set = (
    member: string,
    apply: (location: WebGLUniformLocation) => void
  ) => {
    const location = program.findUniformLocation(`${name}.${member}`)
    if (location) apply(location)
  }
  set('size', location => gl.uniform2i(location, grid.nx, grid.ny))
  set('origin', location => gl.uniform2f(location, grid.west, grid.south))
  set('extent', location =>
    gl.uniform2f(location, grid.east - grid.west, grid.north - grid.south)
  )
  set('lookup_origin', location => gl.uniform2f(location, ...lookupOrigin))
  set('lookup_scale', location => gl.uniform2f(location, ...lookupScale))
  set('lookup_size', location =>
    gl.uniform2i(location, grid.lookupSize, grid.lookupSize)
  )
}

function curvilinearGridOf(field: SingleVelocityField): CurvilinearGrid | null {
  return field instanceof CurvilinearVelocityField ? field.grid : null
}
