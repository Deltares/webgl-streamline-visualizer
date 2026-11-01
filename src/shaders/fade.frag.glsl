#version 300 es
precision highp float;

uniform float u_fade_amount;

out vec4 color;

void main() {
    // With reverse subtractive blending, this leaves the colour of the trail
    // texture unchanged and decreases its alpha by the fade amount.
    color = vec4(0.0, 0.0, 0.0, u_fade_amount);
}
