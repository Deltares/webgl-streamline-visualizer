#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_tex_coord;

uniform int u_width;
uniform highp sampler2D u_particle_position_texture;

uniform float u_particle_size;
uniform float u_aspect_ratio;

uniform lowp int u_is_sprite;

out vec2 v_tex_coord;

void main() {
    // Obtain particle position from texture.
    ivec2 texture_indices = ivec2(
        gl_InstanceID / u_width,
        gl_InstanceID % u_width
    );
    const int mipmap_level = 0;
    vec4 particle_data = texelFetch(
        u_particle_position_texture,
        texture_indices,
        mipmap_level
    );
    vec2 particle_position = particle_data.xy;

    vec2 position = a_position;
    if (u_is_sprite == 1) {
        // When rendering to the canvas instead of a texture, clip space
        // coordinates are inverted for some reason.
        particle_position.y *= -1.0;

        // Rotate the quad according to the velocity direction.
        vec2 direction = normalize(particle_data.zw);
        position = vec2(
            direction.y * a_position.x - direction.x * a_position.y,
            direction.x * a_position.x + direction.y * a_position.y
        );
    }

    // Scale quad and correct for aspect ratio.
    position *= u_particle_size;
    position.y *= u_aspect_ratio;

    gl_Position = vec4(
        position + particle_position,
        0.0, 1.0
    );
    v_tex_coord = a_tex_coord;
}
