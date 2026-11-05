#version 300 es
precision highp float;

in vec2 v_cell;

out vec4 color;

void main() {
    color = vec4(v_cell, 0.0, 1.0);
}
