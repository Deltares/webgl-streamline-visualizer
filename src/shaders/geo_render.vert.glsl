// Draws particles and sprites in geographic mode, as instanced quads.
//
// This is the body of the shader: it is assembled with `#version 300 es`,
// MapLibre's vertex shader prelude and its define (see geographic/programs.ts).

precision highp float;
precision highp int;

#include sphere;

in vec2 a_position;
in vec2 a_tex_coord;

uniform int u_width;
uniform highp sampler2D u_particle_data_texture;
uniform highp sampler2D u_particle_age_texture;

// Side of the particle's quad and size of the viewport, in device pixels.
uniform float u_particle_size;
uniform vec2 u_viewport_size;
uniform float u_metres_per_pixel;

uniform lowp int u_do_rotate_particles;
uniform float u_world_offset;

uniform float u_max_age;
uniform float u_growth_rate;

out vec2 v_tex_coord;

// Distance ahead used to find the direction of a particle on screen.
const float HEADING_DISTANCE_PIXELS = 4.0;

float compute_particle_size(float age) {
    const float shrink_time = 0.1;
    // Grow up to the particle size, until the last 100 ms, in which we shrink
    // down to 0 again to make vanishing particles seem more natural.
    float shrink_start_age = u_max_age - shrink_time;
    if (age > shrink_start_age) {
        float start_size = min(shrink_start_age * u_growth_rate * u_particle_size, u_particle_size);
        float shrink_factor = 1.0 - (age - shrink_start_age) / shrink_time;
        return start_size * shrink_factor;
    }
    return min(age * u_growth_rate * u_particle_size, u_particle_size);
}

void main() {
    ivec2 texture_indices = ivec2(gl_InstanceID / u_width, gl_InstanceID % u_width);
    vec4 particle_data = texelFetch(u_particle_data_texture, texture_indices, 0);
    float particle_age = texelFetch(u_particle_age_texture, texture_indices, 0).r;

    vec2 particle_position = particle_data.xy;
    vec2 particle_velocity = particle_data.zw;

    v_tex_coord = a_tex_coord;

    if (particle_velocity.x == 0.0 && particle_velocity.y == 0.0) {
        // Dormant particle: give all vertices the same position, so the
        // triangles are degenerate and nothing is drawn.
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec2 offset = vec2(u_world_offset, 0.0);
    vec2 mercator = to_mercator(particle_position);
    vec4 centre = projectTile(mercator + offset);

    vec2 corner = a_position;
    if (u_do_rotate_particles == 1) {
        // Direction on screen: project a point a few pixels ahead along the
        // velocity. Mercator's derivative is exact, so this does not depend on
        // the accuracy of sin and cos at the point ahead.
        vec2 ahead_mercator = mercator + mercator_rate(particle_position, normalize(particle_velocity))
            * (HEADING_DISTANCE_PIXELS * u_metres_per_pixel);
        vec4 ahead = projectTile(ahead_mercator + offset);
        vec2 delta = (ahead.xy / ahead.w - centre.xy / centre.w) * u_viewport_size;
        vec2 direction = length(delta) > 0.0 ? normalize(delta) : vec2(0.0, 1.0);
        // Take the direction as the local y-axis, and the vector perpendicular
        // to it as the local x-axis.
        mat2 transformation = mat2(vec2(-direction.y, direction.x), direction);
        corner = transformation * corner;
    }

    // Extrude the quad in pixels, so particles have the same size everywhere
    // on screen.
    corner *= compute_particle_size(particle_age);
    gl_Position = centre + vec4(corner * 2.0 / u_viewport_size * centre.w, 0.0, 0.0);
}
