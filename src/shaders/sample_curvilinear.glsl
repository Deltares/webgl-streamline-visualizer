// Samples a curvilinear velocity grid at a geographic position.
//
// Requires `sample_velocity` to be included first. Mirrors
// `CurvilinearVelocityField.sample` in
// src/geographic/curvilinear-velocity-field.ts; keep both in step.
//
// Three textures describe the grid:
// - values: RG32F (u, v) per cell, in the grid's native order;
// - corners: RG32F (longitude, latitude) per cell, in degrees relative to
//   `origin`, which keeps float32 precision for cells of tens of metres;
// - lookup: RG32F (column, row) on a regular lon/lat raster. A negative value
//   -1 - x means the texel lies just outside the mesh, and x is a nearby cell;
//   values below MISSING_FLOAT_THRESHOLD mean nothing is near.

const int CURVILINEAR_MAX_WALK_STEPS = 8;
const int CURVILINEAR_NEWTON_STEPS = 3;
// The largest number of quads to jump in one walk step, along each axis.
const float CURVILINEAR_MAX_JUMP = 16.0;
// Float32 positions are a few µ° apart, about 1 % of the smallest cells.
const float CURVILINEAR_FRACTION_SLACK = 2.0e-3;
// Offsets of the lookup texels to retry from when a walk fails.
const int CURVILINEAR_NUM_RETRIES = 8;
const ivec2 CURVILINEAR_RETRIES[CURVILINEAR_NUM_RETRIES] = ivec2[CURVILINEAR_NUM_RETRIES](
    ivec2(2, 0), ivec2(-2, 0), ivec2(0, 2), ivec2(0, -2),
    ivec2(2, 2), ivec2(-2, 2), ivec2(2, -2), ivec2(-2, -2)
);

struct CurvilinearGrid {
    // Number of columns and rows.
    ivec2 size;
    // (west, south) of the cell centres, in degrees; the origin of `corners`.
    vec2 origin;
    // (east, north) relative to `origin`, in degrees.
    vec2 extent;
    // Position of the lookup texture's lower left corner relative to `origin`.
    vec2 lookup_origin;
    // Lookup texels per degree.
    vec2 lookup_scale;
    // Lookup texels per side.
    ivec2 lookup_size;
};

// Returns (longitude, latitude) in degrees relative to the grid's origin.
vec2 curvilinear_local_position(CurvilinearGrid grid, vec2 lonlat) {
    vec2 local = degrees(lonlat) - grid.origin;
    // Bring the longitude to the grid's side of the antimeridian. Measuring
    // from the centre and subtracting whole turns keeps the precision that a
    // modulo of values around 180 would lose.
    float centred = local.x - 0.5 * grid.extent.x;
    local.x = centred - 360.0 * round(centred / 360.0) + 0.5 * grid.extent.x;
    return local;
}

bool curvilinear_read_corner(sampler2D corners, ivec2 cell, out vec2 corner) {
    corner = texelFetch(corners, cell, 0).rg;
    return corner.x >= MISSING_FLOAT_THRESHOLD && corner.y >= MISSING_FLOAT_THRESHOLD;
}

// Walks from a seed in the lookup texture to the quad holding a position: Newton
// steps within a quad, then on to the quad the fractions point to. Returns false
// if the seed is empty, or the walk ends at the grid's edge or at a quad without
// coordinates.
bool curvilinear_walk(
    sampler2D lookup,
    sampler2D corners,
    CurvilinearGrid grid,
    vec2 local,
    ivec2 texel,
    out ivec2 quad,
    out vec2 f
) {
    quad = ivec2(0);
    f = vec2(0.0);
    if (any(lessThan(texel, ivec2(0))) || any(greaterThanEqual(texel, grid.lookup_size))) {
        return false;
    }
    vec2 seed = texelFetch(lookup, texel, 0).rg;
    if (seed.x < MISSING_FLOAT_THRESHOLD) return false;
    if (seed.x < 0.0) seed = -1.0 - seed;

    ivec2 last = grid.size - 2;
    quad = clamp(ivec2(floor(seed)), ivec2(0), last);
    f = clamp(seed - vec2(quad), 0.0, 1.0);

    for (int walk = 0; walk < CURVILINEAR_MAX_WALK_STEPS; walk++) {
        vec2 a, b, c, d;
        if (!curvilinear_read_corner(corners, quad, a)
            || !curvilinear_read_corner(corners, quad + ivec2(1, 0), b)
            || !curvilinear_read_corner(corners, quad + ivec2(0, 1), c)
            || !curvilinear_read_corner(corners, quad + ivec2(1, 1), d)) {
            return false;
        }
        vec2 q = local - a;
        b -= a;
        c -= a;
        d -= a;
        for (int step = 0; step < CURVILINEAR_NEWTON_STEPS; step++) {
            vec2 error = f.x * (1.0 - f.y) * b + (1.0 - f.x) * f.y * c + f.x * f.y * d - q;
            // Partial derivatives along f.x and f.y.
            vec2 along_x = (1.0 - f.y) * b + f.y * (d - c);
            vec2 along_y = (1.0 - f.x) * c + f.x * (d - b);
            float determinant = along_x.x * along_y.y - along_x.y * along_y.x;
            if (determinant == 0.0) return false;
            f -= vec2(
                error.x * along_y.y - error.y * along_y.x,
                along_x.x * error.y - along_x.y * error.x
            ) / determinant;
        }
        if (all(greaterThanEqual(f, vec2(-CURVILINEAR_FRACTION_SLACK)))
            && all(lessThanEqual(f, vec2(1.0 + CURVILINEAR_FRACTION_SLACK)))) {
            f = clamp(f, 0.0, 1.0);
            return true;
        }
        // Fractions outside 0..1 say how many quads away the position is.
        ivec2 next = clamp(
            quad + ivec2(clamp(floor(f), -CURVILINEAR_MAX_JUMP, CURVILINEAR_MAX_JUMP)),
            ivec2(0),
            last
        );
        if (next == quad) return false;
        quad = next;
        f = vec2(0.5);
    }
    return false;
}

// Finds the quad holding a position. Near a coast, a walk can run into a quad
// without coordinates while the position lies just beyond it; the seeds of the
// surrounding texels then reach it from another side. This only costs extra
// where the first walk fails.
bool curvilinear_locate(
    sampler2D lookup,
    sampler2D corners,
    CurvilinearGrid grid,
    vec2 local,
    out ivec2 quad,
    out vec2 f
) {
    ivec2 texel = ivec2(floor((local - grid.lookup_origin) * grid.lookup_scale));
    if (curvilinear_walk(lookup, corners, grid, local, texel, quad, f)) return true;
    for (int i = 0; i < CURVILINEAR_NUM_RETRIES; i++) {
        if (curvilinear_walk(lookup, corners, grid, local, texel + CURVILINEAR_RETRIES[i], quad, f)) {
            return true;
        }
    }
    return false;
}

bool curvilinear_read_value(sampler2D values, ivec2 cell, out vec2 value) {
    value = texelFetch(values, cell, 0).rg;
    return value.x >= MISSING_FLOAT_THRESHOLD && value.y >= MISSING_FLOAT_THRESHOLD;
}

// Interpolates a quad's values. Missing if the nearest corner is; otherwise
// missing corners are left out and the weights renormalised.
bool curvilinear_interpolate(sampler2D values, ivec2 quad, vec2 f, out vec2 velocity) {
    velocity = vec2(0.0);
    vec2 v;
    if (!curvilinear_read_value(values, quad + ivec2(greaterThanEqual(f, vec2(0.5))), v)) {
        return false;
    }
    vec2 sum = vec2(0.0);
    float weight_sum = 0.0;
    float w;

    w = (1.0 - f.x) * (1.0 - f.y);
    if (curvilinear_read_value(values, quad, v)) { sum += w * v; weight_sum += w; }
    w = f.x * (1.0 - f.y);
    if (curvilinear_read_value(values, quad + ivec2(1, 0), v)) { sum += w * v; weight_sum += w; }
    w = (1.0 - f.x) * f.y;
    if (curvilinear_read_value(values, quad + ivec2(0, 1), v)) { sum += w * v; weight_sum += w; }
    w = f.x * f.y;
    if (curvilinear_read_value(values, quad + ivec2(1, 1), v)) { sum += w * v; weight_sum += w; }

    velocity = sum / weight_sum;
    return true;
}

// Samples the velocity at (longitude, latitude) in radians, inverting the
// bilinear map exactly. For particles: a few lookups each.
bool sample_curvilinear(
    sampler2D values,
    sampler2D lookup,
    sampler2D corners,
    CurvilinearGrid grid,
    vec2 lonlat,
    out vec2 velocity
) {
    velocity = vec2(0.0);
    ivec2 quad;
    vec2 f;
    vec2 local = curvilinear_local_position(grid, lonlat);
    if (!curvilinear_locate(lookup, corners, grid, local, quad, f)) return false;
    return curvilinear_interpolate(values, quad, f, velocity);
}

// Samples the velocity from the lookup texture alone, without the inversion.
// For fragments: this runs millions of times, and only colours the background.
// (column, row) then interpolates linearly over each quad's two triangles, as
// Tempo's field shader does.
bool sample_curvilinear_coarse(
    sampler2D values,
    sampler2D lookup,
    CurvilinearGrid grid,
    vec2 lonlat,
    out vec2 velocity
) {
    velocity = vec2(0.0);
    vec2 local = curvilinear_local_position(grid, lonlat);
    vec2 raster = (local - grid.lookup_origin) * grid.lookup_scale;
    ivec2 texel = ivec2(floor(raster));
    if (any(lessThan(texel, ivec2(0))) || any(greaterThanEqual(texel, grid.lookup_size))) {
        return false;
    }
    vec2 seed = texelFetch(lookup, texel, 0).rg;
    // Texels outside the mesh are missing: this is what cuts off the domain.
    if (seed.x < 0.0) return false;

    // Interpolate between texel centres where all four lie inside the mesh.
    vec2 centred = raster - 0.5;
    ivec2 base = clamp(ivec2(floor(centred)), ivec2(0), grid.lookup_size - 2);
    vec2 t = centred - vec2(base);
    vec2 s00 = texelFetch(lookup, base, 0).rg;
    vec2 s10 = texelFetch(lookup, base + ivec2(1, 0), 0).rg;
    vec2 s01 = texelFetch(lookup, base + ivec2(0, 1), 0).rg;
    vec2 s11 = texelFetch(lookup, base + ivec2(1, 1), 0).rg;
    if (min(min(s00.x, s10.x), min(s01.x, s11.x)) >= 0.0) {
        seed = mix(mix(s00, s10, t.x), mix(s01, s11, t.x), t.y);
    }

    ivec2 quad = clamp(ivec2(floor(seed)), ivec2(0), grid.size - 2);
    return curvilinear_interpolate(values, quad, clamp(seed - vec2(quad), 0.0, 1.0), velocity);
}
