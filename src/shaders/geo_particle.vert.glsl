// Propagates particles in geographic mode, with transform feedback.
//
// This is the body of the shader: it is assembled with `#version 300 es`,
// MapLibre's vertex shader prelude and its define (see geographic/programs.ts).

precision highp float;
precision highp int;
precision highp sampler2D;

#include is_missing_velocity;
#include sample_velocity;
#include sample_curvilinear;
#include sample_field;
#include sphere;

// Maps the screen to the sphere: unit vector in xyz, spawn probability in w.
uniform sampler2D u_spawn_table;
uniform ivec2 u_spawn_table_size;
uniform uint u_seed;

uniform float u_speed_factor;
uniform float u_speed_exponent;
// Metres per clip space unit in y at the view centre.
uniform float u_metres_per_clip_unit;

uniform float u_dt;
uniform float u_max_age;

// Range of world copies to test for visibility (Mercator only).
uniform int u_world_copy_min;
uniform int u_world_copy_max;

// Position (longitude, latitude) in radians, and velocity (east, north) in clip
// units per second, after the speed curve. Zero velocity means dormant.
in vec4 a_particle_data;
in float a_particle_age;

out vec4 v_new_particle_data;
out float v_new_particle_age;

const int MAX_SPAWN_ATTEMPTS = 4;

uint hash(uint x) {
    x ^= x >> 16u;
    x *= 0x7feb352du;
    x ^= x >> 15u;
    x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}

float random_float(inout uint state) {
    state = hash(state);
    return float(state >> 8u) / 16777216.0;
}

// Picks a random screen position and returns the location on the sphere under
// it, interpolating unit vectors from the spawn table.
//
// The table's w is the probability of accepting a spawn in a cell: 0 where
// nothing may spawn, and 1 / n where a location shows on screen in n world
// copies, so that particle density on screen stays uniform.
bool spawn(inout uint state, out vec2 position) {
    position = vec2(0.0);
    ivec2 last = u_spawn_table_size - 1;
    for (int attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
        // Cell centres are at integer table positions; the screen edges are
        // half a cell outside the outer centres. Extrapolate there rather than
        // clamping, which would put all particles of the outer half-cells on
        // the outer centres.
        vec2 table = vec2(random_float(state), random_float(state)) * vec2(u_spawn_table_size) - 0.5;
        ivec2 base = clamp(ivec2(floor(table)), ivec2(0), max(last - 1, ivec2(0)));
        ivec2 next = min(base + 1, last);
        vec2 f = table - vec2(base);

        vec4 c00 = texelFetch(u_spawn_table, base, 0);
        vec4 c10 = texelFetch(u_spawn_table, ivec2(next.x, base.y), 0);
        vec4 c01 = texelFetch(u_spawn_table, ivec2(base.x, next.y), 0);
        vec4 c11 = texelFetch(u_spawn_table, next, 0);
        float acceptance = min(min(c00.w, c10.w), min(c01.w, c11.w));
        if (acceptance == 0.0 || random_float(state) >= acceptance) continue;

        vec3 x = mix(mix(c00.xyz, c10.xyz, f.x), mix(c01.xyz, c11.xyz, f.x), f.y);
        if (length(x) < 1e-6) continue;
        position = unit_to_lonlat(normalize(x));
        return true;
    }
    return false;
}

// Returns the velocity in clip units per second after the speed curve, or zero
// where the field is missing.
vec2 scaled_velocity(vec2 position) {
    vec2 velocity;
    if (!sample_field(position, velocity)) {
        return vec2(0.0);
    }
    float speed = length(velocity);
    if (speed == 0.0) return vec2(0.0);
    vec2 direction = velocity / speed;
    if (u_speed_exponent == 0.0) {
        // Only use the direction and ignore the magnitude.
        return direction * u_speed_factor;
    }
    // Compress the speed: for exponents below 1, high speeds move closer
    // together.
    return direction * pow(speed, u_speed_exponent) * u_speed_factor;
}

// Advances a position by one time step with the explicit midpoint method, so
// particles follow curved streamlines closely.
vec2 step_midpoint(vec2 position, vec2 velocity) {
    vec2 midpoint = position + lonlat_rate(position, velocity * u_metres_per_clip_unit) * (0.5 * u_dt);
    vec2 velocity_mid = scaled_velocity(midpoint);
    // Where the midpoint has no data, fall back to the start velocity.
    if (velocity_mid == vec2(0.0)) velocity_mid = velocity;
    return wrap_longitude(position + lonlat_rate(midpoint, velocity_mid * u_metres_per_clip_unit) * u_dt);
}

bool is_on_screen(vec4 clip) {
#ifdef GLOBE
    // Behind the horizon, MapLibre puts z beyond the far plane.
    return clip.w > 0.0 && all(lessThanEqual(abs(clip.xyz), vec3(clip.w)));
#else
    return clip.w > 0.0 && all(lessThanEqual(abs(clip.xy), vec2(clip.w)));
#endif
}

bool is_visible(vec2 position) {
    vec2 mercator = to_mercator(position);
    for (int copy = u_world_copy_min; copy <= u_world_copy_max; copy++) {
        if (is_on_screen(projectTile(mercator + vec2(float(copy), 0.0)))) return true;
    }
    return false;
}

void main() {
    uint state = hash(uint(gl_VertexID) ^ hash(u_seed));

    vec2 position = a_particle_data.xy;
    vec2 velocity = a_particle_data.zw;

    bool do_spawn;
    float new_age;
    if (a_particle_age > u_max_age) {
        // Too old: start again at age 0.
        do_spawn = true;
        new_age = 0.0;
    } else if (velocity.x == 0.0 && velocity.y == 0.0) {
        // Dormant, or no velocity here. Use a random age, so that particles
        // respawned together do not all die together.
        do_spawn = true;
        new_age = random_float(state) * u_max_age;
    } else if (!is_visible(position)) {
        // Off screen or behind the horizon.
        do_spawn = true;
        new_age = 0.0;
    } else {
        do_spawn = false;
        position = step_midpoint(position, velocity);
        new_age = a_particle_age + u_dt;
    }

    bool is_placed = do_spawn ? spawn(state, position) : true;

    // Particles that could not be placed, or left Web Mercator's latitude
    // range, stay dormant with zero velocity and are respawned next frame.
    vec2 new_velocity = vec2(0.0);
    if (is_placed && abs(position.y) <= MAX_MERCATOR_LATITUDE) {
        new_velocity = scaled_velocity(position);
    }

    v_new_particle_data = vec4(position, new_velocity);
    v_new_particle_age = new_age;
}
