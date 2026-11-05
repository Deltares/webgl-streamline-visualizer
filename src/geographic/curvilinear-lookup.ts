import lookupVertexSource from '../shaders/curvilinear_lookup.vert.glsl'
import lookupFragmentSource from '../shaders/curvilinear_lookup.frag.glsl'
import dilateVertexSource from '../shaders/curvilinear_dilate.vert.glsl'
import dilateFragmentSource from '../shaders/curvilinear_dilate.frag.glsl'

import { FragmentShader, VertexShader } from '../utils/shader'
import { ShaderProgram, bindTexture } from '../utils/shader-program'
import {
  createFloatTexture,
  type CurvilinearGrid
} from './curvilinear-velocity-field'
import { MISSING_FLOAT_SENTINEL } from './regular-velocity-chunk'

/** The GPU textures of a curvilinear grid; see `sample_curvilinear.glsl`. */
export interface CurvilinearGridTextures {
  readonly grid: CurvilinearGrid
  readonly corners: WebGLTexture
  readonly lookup: WebGLTexture
  /** Position of the lookup texture's corner, in degrees from (west, south). */
  readonly lookupOrigin: [number, number]
  /** Lookup texels per degree. */
  readonly lookupScale: [number, number]
}

const ATTRIBUTES = { a_local: 0, a_cell: 1 } as const
// Margin around the mesh in texels: room for texels grown beyond its edge.
const LOOKUP_MARGIN = 4
// Each pass grows the lookup by one texel. Lines and points already put every
// cell centre and quad edge within reach; two more texels cover the rest.
const NUM_DILATION_PASSES = 2

/**
 * Builds the textures of curvilinear grids.
 *
 * The lookup texture is a regular lon/lat raster of (column, row), made by
 * drawing the cell-centre mesh on the GPU. It only has to land near the right
 * quad; `sample_curvilinear.glsl` does the rest.
 */
export class CurvilinearLookupBuilder {
  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly meshProgram: ShaderProgram,
    private readonly dilateProgram: ShaderProgram
  ) {}

  static async create(
    gl: WebGL2RenderingContext
  ): Promise<CurvilinearLookupBuilder> {
    const meshProgram = new ShaderProgram(
      gl,
      new VertexShader(gl, lookupVertexSource),
      new FragmentShader(gl, lookupFragmentSource),
      undefined,
      ATTRIBUTES
    )
    const dilateProgram = new ShaderProgram(
      gl,
      new VertexShader(gl, dilateVertexSource),
      new FragmentShader(gl, dilateFragmentSource)
    )
    await Promise.all([meshProgram.link(), dilateProgram.link()])
    return new CurvilinearLookupBuilder(gl, meshProgram, dilateProgram)
  }

  destruct(): void {
    this.meshProgram.destruct()
    this.dilateProgram.destruct()
  }

  /**
   * Uploads a grid's coordinates and draws its lookup texture.
   *
   * This changes GL state, and MapLibre tracks its own: call it during a
   * custom layer's `render`, not from outside a frame.
   */
  build(grid: CurvilinearGrid): CurvilinearGridTextures {
    const gl = this.gl
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error(
        'Curvilinear velocity fields require the EXT_color_buffer_float extension.'
      )
    }
    const { nx, ny, west, east, south, north, lookupSize } = grid

    const numCells = nx * ny
    const corners = new Float32Array(2 * numCells)
    const vertices = new Float32Array(4 * numCells)
    for (let row = 0; row < ny; row++) {
      for (let column = 0; column < nx; column++) {
        const i = row * nx + column
        const lon = grid.lon[i] as number
        const hasCoordinates = !Number.isNaN(lon)
        const x = hasCoordinates ? lon - west : MISSING_FLOAT_SENTINEL
        const y = hasCoordinates
          ? (grid.lat[i] as number) - south
          : MISSING_FLOAT_SENTINEL
        corners.set([x, y], 2 * i)
        vertices.set(
          [hasCoordinates ? x : 0, hasCoordinates ? y : 0, column, row],
          4 * i
        )
      }
    }

    const scale = (span: number) =>
      (lookupSize - 2 * LOOKUP_MARGIN) / Math.max(span, 1e-9)
    const lookupScale: [number, number] = [
      scale(east - west),
      scale(north - south)
    ]
    const lookupOrigin: [number, number] = [
      -LOOKUP_MARGIN / lookupScale[0],
      -LOOKUP_MARGIN / lookupScale[1]
    ]

    const framebuffer = gl.getParameter(
      gl.FRAMEBUFFER_BINDING
    ) as WebGLFramebuffer | null
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array
    const enabled = [
      gl.BLEND,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.CULL_FACE,
      gl.SCISSOR_TEST
    ].filter(capability => {
      const isEnabled = gl.isEnabled(capability)
      gl.disable(capability)
      return isEnabled
    })
    gl.colorMask(true, true, true, true)
    gl.viewport(0, 0, lookupSize, lookupSize)

    const target = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    let lookup = createFloatTexture(gl, lookupSize, lookupSize, null)
    let scratch = createFloatTexture(gl, lookupSize, lookupSize, null)
    const attach = (texture: WebGLTexture) =>
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0
      )

    attach(lookup)
    gl.clearBufferfv(gl.COLOR, 0, [
      MISSING_FLOAT_SENTINEL,
      MISSING_FLOAT_SENTINEL,
      0,
      1
    ])
    this.drawMesh(grid, vertices, lookupOrigin, lookupScale)

    gl.useProgram(this.dilateProgram.program)
    const emptyVertexArray = gl.createVertexArray()
    gl.bindVertexArray(emptyVertexArray)
    for (let pass = 0; pass < NUM_DILATION_PASSES; pass++) {
      attach(scratch)
      bindTexture(this.dilateProgram, 'u_lookup', 0, lookup)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindTexture(gl.TEXTURE_2D, null)
      const previous = lookup
      lookup = scratch
      scratch = previous
    }

    gl.bindVertexArray(null)
    gl.deleteVertexArray(emptyVertexArray)
    gl.deleteTexture(scratch)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.deleteFramebuffer(target)
    gl.viewport(viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!)
    enabled.forEach(capability => gl.enable(capability))
    gl.useProgram(null)

    return {
      grid,
      corners: createFloatTexture(gl, nx, ny, corners),
      lookup,
      lookupOrigin,
      lookupScale
    }
  }

  private drawMesh(
    grid: CurvilinearGrid,
    vertices: Float32Array,
    lookupOrigin: [number, number],
    lookupScale: [number, number]
  ): void {
    const gl = this.gl
    const { nx, ny, lookupSize } = grid
    const hasCoordinates = (cell: number) => !Number.isNaN(grid.lon[cell])

    const triangles: number[] = []
    const lines: number[] = []
    const points: number[] = []
    for (let row = 0; row < ny; row++) {
      for (let column = 0; column < nx; column++) {
        const a = row * nx + column
        if (hasCoordinates(a)) points.push(a)
        if (column === nx - 1 || row === ny - 1) continue
        const b = a + 1
        const c = a + nx
        const d = c + 1
        if (![a, b, c, d].every(hasCoordinates)) continue
        triangles.push(a, b, c, b, d, c)
        lines.push(a, b, a, c, b, d, c, d)
      }
    }

    const program = this.meshProgram
    program.use()
    gl.uniform2f(program.getUniformLocation('u_lookup_origin'), ...lookupOrigin)
    gl.uniform2f(program.getUniformLocation('u_lookup_scale'), ...lookupScale)
    gl.uniform2f(
      program.getUniformLocation('u_lookup_size'),
      lookupSize,
      lookupSize
    )

    const vertexArray = gl.createVertexArray()
    gl.bindVertexArray(vertexArray)
    const vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(ATTRIBUTES.a_local)
    gl.vertexAttribPointer(ATTRIBUTES.a_local, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(ATTRIBUTES.a_cell)
    gl.vertexAttribPointer(ATTRIBUTES.a_cell, 2, gl.FLOAT, false, 16, 8)

    const indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    // Quads smaller than a texel can miss every texel centre, so first draw
    // lines and points, which always leave a seed nearby. Triangles come last,
    // and win where they cover a texel.
    const draw = (mode: number, indices: number[]) => {
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        Uint32Array.from(indices),
        gl.STREAM_DRAW
      )
      gl.drawElements(mode, indices.length, gl.UNSIGNED_INT, 0)
    }
    draw(gl.LINES, lines)
    draw(gl.POINTS, points)
    draw(gl.TRIANGLES, triangles)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
    gl.deleteVertexArray(vertexArray)
    gl.deleteBuffer(vertexBuffer)
    gl.deleteBuffer(indexBuffer)
  }
}
