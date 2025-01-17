#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_tex_coord;

uniform int u_width;
uniform sampler2D u_particle_position_texture;

uniform float u_particle_size;
uniform float u_aspect_ratio;

out vec2 v_tex_coord;

void main() {
    // Scale quad and correct for aspect ratio.
    vec2 position = a_position * u_particle_size;
    position.y *= u_aspect_ratio;

    // Obtain particle position from texture.
    ivec2 texture_indices = ivec2(
        gl_InstanceID / u_width,
        gl_InstanceID % u_width
    );
    const int mipmap_level = 0;
    vec4 particle_position = texelFetch(
        u_particle_position_texture,
        texture_indices,
        mipmap_level
    );

    gl_Position = vec4(
        position + particle_position.xy,
        0.0, 1.0
    );
    v_tex_coord = a_tex_coord;
}
