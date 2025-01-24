#version 300 es
precision highp float;

uniform sampler2D u_velocity_texture;

uniform float u_speed_factor;
uniform float u_speed_exponent;

uniform float u_aspect_ratio;
uniform vec2 u_scale_in;
uniform vec2 u_offset_in;

uniform float u_dt;

uniform int u_index_eliminate_start;
uniform int u_index_eliminate_end;

in vec4 a_particle_data;
out vec4 v_new_particle_data;

#include is_missing_velocity;

// From: https://stackoverflow.com/questions/4200224/random-noise-functions-for-glsl
float gold_noise(vec2 pos, float seed){
    const float phi = 1.61803398874989484820459;
    return fract(tan(distance(pos * phi, pos) * seed) * pos.x);
}

vec2 random_position() {
    vec2 pos = a_particle_data.xy;
    float x = gold_noise(pos, -123.456) * 2.0 - 1.0;
    float y = gold_noise(pos, 789.012) * 2.0 - 1.0;
    return vec2(x, y);
}

vec2 get_clip_space_velocity(vec2 pos) {
    // Position is in clip space, but should be transformed to texture
    // coordinates. Because the velocity texture was loaded from an image, it is
    // vertically flipped, so the v texture coordinate is inverted.
    vec2 pos_texture = vec2(
        0.5 + 0.5 * pos.x,
        0.5 - 0.5 * pos.y
    );
    vec4 velocity_raw = texture(u_velocity_texture, pos_texture);

    // Set missing velocities to zero.
    if (is_missing_velocity(velocity_raw)) {
        return vec2(0.0, 0.0);
    }

    // Compute velocity in physical coordinates.
    vec2 velocity = velocity_raw.rg * u_scale_in + u_offset_in;

    // Apply speed exponent to "compress" the speed---for exponents smaller
    // than 1, higher speeds will be closer together.
    float speed_compressed = pow(length(velocity), u_speed_exponent);

    // Scale the speed by the speed factor so it is appropriately scaled for
    // particles moving in clip space.
    speed_compressed *= u_speed_factor;

    // Finally, compute the velocity based on the compressed speed.
    velocity = normalize(velocity) * speed_compressed;

    // Correct the x-velocity for the aspect ratio of the canvas.
    velocity.x *= u_aspect_ratio;

    return velocity;
}

void main() {
    vec2 pos = a_particle_data.xy;
    vec2 velocity = a_particle_data.zw;

    vec2 new_position;
    if (gl_VertexID >= u_index_eliminate_start && gl_VertexID < u_index_eliminate_end) {
        // Randomly selected particles will be eliminated.
        new_position = random_position();
    } else if (pos.x < -1.0 || pos.x > 1.0 || pos.y < -1.0 || pos.y > 1.0) {
        // Also generate new positions if our particle leaves clip space.
        new_position = random_position();
    } else {
        new_position = pos + velocity * u_dt;
    }

    vec2 new_velocity = get_clip_space_velocity(new_position);
    v_new_particle_data = vec4(new_position, new_velocity);
}
