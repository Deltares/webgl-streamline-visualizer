#version 300 es

uniform float u_factor;

in vec4 a_position;
in vec2 a_tex_coord;

out vec2 v_tex_coord;

void main() {
    v_tex_coord = u_factor * a_tex_coord;
    gl_Position = a_position;
}
