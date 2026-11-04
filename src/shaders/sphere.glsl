// Positions on the sphere, for geographic mode. Positions are (longitude,
// latitude) in radians. Requires PI, which MapLibre's vertex shader prelude
// declares.

// MapLibre's GLOBE_RADIUS, in metres.
const float EARTH_RADIUS = 6371008.8;
// Latitude limit of Web Mercator, in radians (85.05112878 degrees).
const float MAX_MERCATOR_LATITUDE = 1.4844222297;

vec3 lonlat_to_unit(vec2 p) {
    return vec3(cos(p.y) * cos(p.x), cos(p.y) * sin(p.x), sin(p.y));
}

vec2 unit_to_lonlat(vec3 x) {
    // atan2 for the latitude stays accurate near the poles, unlike asin.
    return vec2(atan(x.y, x.x), atan(x.z, length(x.xy)));
}

// Returns the rate of change of a position, in radians per second, for a
// velocity (east, north) in m/s.
//
// Positions are advanced in longitude and latitude directly rather than
// through unit vectors: converting to a unit vector and back costs the
// accuracy of the GPU's sin and cos (about 1e-6 rad, worse on some GPUs) in
// every step, which is comparable to a step at high zoom. Particles stay
// within Web Mercator's latitudes, so the poles, where this is singular, are
// never reached.
vec2 lonlat_rate(vec2 p, vec2 velocity) {
    return vec2(velocity.x / (EARTH_RADIUS * cos(p.y)), velocity.y / EARTH_RADIUS);
}

// Wraps the longitude into [-PI, PI).
vec2 wrap_longitude(vec2 p) {
    p.x -= 2.0 * PI * floor((p.x + PI) / (2.0 * PI));
    return p;
}

// Returns the rate of change of Web Mercator (0..1, y from north to south) per
// metre moved in a direction (east, north) of unit length.
vec2 mercator_rate(vec2 p, vec2 direction) {
    vec2 rate = lonlat_rate(p, direction);
    return vec2(rate.x, -rate.y / cos(p.y)) / (2.0 * PI);
}

// Converts a position to Web Mercator in 0..1, the input of MapLibre's
// projectTile, with (0, 0) at the north-west corner.
vec2 to_mercator(vec2 p) {
    float lat = clamp(p.y, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
    return vec2(
        p.x / (2.0 * PI) + 0.5,
        0.5 - log(tan(0.25 * PI + 0.5 * lat)) / (2.0 * PI)
    );
}
