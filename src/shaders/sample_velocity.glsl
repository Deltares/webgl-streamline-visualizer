// Samples a regular velocity grid at a geographic position.
//
// Requires `is_missing_velocity` to be included first. Mirrors
// `RegularVelocityChunk.sample` in src/geographic/regular-velocity-chunk.ts;
// keep both in step.

const float SAMPLE_VELOCITY_PI = 3.14159265358979;
// EPSG:3857 uses the WGS 84 semi-major axis as its sphere radius.
const float MERCATOR_RADIUS = 6378137.0;
// Latitude limit of Web Mercator, in radians (85.05112878 degrees).
const float VELOCITY_MERCATOR_MAX_LATITUDE = 1.4844222297;
// Float values below this are missing (the uploaded sentinel is -3e38).
const float MISSING_FLOAT_THRESHOLD = -1.0e38;

const int VELOCITY_CRS_LONLAT = 0;
const int VELOCITY_CRS_MERCATOR = 1;
const int VELOCITY_ENCODING_RG8 = 0;
const int VELOCITY_ENCODING_FLOAT = 1;

struct VelocityGrid {
    // VELOCITY_CRS_LONLAT (degrees) or VELOCITY_CRS_MERCATOR (EPSG:3857 metres).
    int crs;
    // Centre of cell (0, 0), in the units of `crs`.
    vec2 origin;
    // Cell size (dx, dy); dx > 0, and dy < 0 when rows run north to south.
    vec2 spacing;
    // Number of columns and rows.
    ivec2 size;
    // Whether the grid covers the whole earth in x, and so wraps around.
    bool wraps;
    // VELOCITY_ENCODING_RG8 or VELOCITY_ENCODING_FLOAT.
    int encoding;
    // For RG8: (u scale, u offset, v scale, v offset) per normalised value.
    vec4 decode;
};

// Returns the fractional (column, row) of a position given as (longitude,
// latitude) in radians. Cell centres are at integer positions.
vec2 velocity_grid_position(VelocityGrid grid, vec2 lonlat) {
    vec2 xy;
    float period;
    if (grid.crs == VELOCITY_CRS_MERCATOR) {
        float lat = clamp(lonlat.y, -VELOCITY_MERCATOR_MAX_LATITUDE, VELOCITY_MERCATOR_MAX_LATITUDE);
        xy = MERCATOR_RADIUS * vec2(
            lonlat.x,
            log(tan(0.25 * SAMPLE_VELOCITY_PI + 0.5 * lat))
        );
        period = 2.0 * SAMPLE_VELOCITY_PI * MERCATOR_RADIUS;
    } else {
        xy = degrees(lonlat);
        period = 360.0;
    }
    // Measure x eastwards from the western edge of the grid, so that any
    // longitude maps into [0, period).
    float west = grid.origin.x - 0.5 * grid.spacing.x;
    float column = mod(xy.x - west, period) / grid.spacing.x - 0.5;
    float row = (xy.y - grid.origin.y) / grid.spacing.y;
    return vec2(column, row);
}

// Reads one cell. Returns false if it is missing or outside the grid.
bool fetch_velocity(sampler2D values, VelocityGrid grid, ivec2 cell, out vec2 velocity) {
    velocity = vec2(0.0);
    if (grid.wraps) {
        // GLSL's % is undefined for negative operands.
        cell.x -= grid.size.x * int(floor(float(cell.x) / float(grid.size.x)));
    }
    if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, grid.size))) {
        return false;
    }
    vec4 raw = texelFetch(values, cell, 0);
    if (grid.encoding == VELOCITY_ENCODING_RG8) {
        if (is_missing_velocity(raw)) return false;
        velocity = raw.rg * grid.decode.xz + grid.decode.yw;
    } else {
        if (raw.r < MISSING_FLOAT_THRESHOLD || raw.g < MISSING_FLOAT_THRESHOLD) return false;
        velocity = raw.rg;
    }
    return true;
}

// Samples the velocity at (longitude, latitude) in radians.
//
// A position is missing if its nearest cell is missing or outside the grid.
// Otherwise the velocity is interpolated bilinearly over the four surrounding
// cells, leaving out missing ones and renormalising the weights. The nearest
// cell always has a weight of at least 1/4, so the weights never sum to zero.
bool sample_velocity(sampler2D values, VelocityGrid grid, vec2 lonlat, out vec2 velocity) {
    velocity = vec2(0.0);
    vec2 position = velocity_grid_position(grid, lonlat);

    vec2 nearest_velocity;
    if (!fetch_velocity(values, grid, ivec2(floor(position + 0.5)), nearest_velocity)) {
        return false;
    }

    vec2 base = floor(position);
    vec2 f = position - base;
    ivec2 cell = ivec2(base);

    vec2 sum = vec2(0.0);
    float weight_sum = 0.0;
    vec2 v;
    float w;

    w = (1.0 - f.x) * (1.0 - f.y);
    if (fetch_velocity(values, grid, cell, v)) { sum += w * v; weight_sum += w; }
    w = f.x * (1.0 - f.y);
    if (fetch_velocity(values, grid, cell + ivec2(1, 0), v)) { sum += w * v; weight_sum += w; }
    w = (1.0 - f.x) * f.y;
    if (fetch_velocity(values, grid, cell + ivec2(0, 1), v)) { sum += w * v; weight_sum += w; }
    w = f.x * f.y;
    if (fetch_velocity(values, grid, cell + ivec2(1, 1), v)) { sum += w * v; weight_sum += w; }

    velocity = sum / weight_sum;
    return true;
}
