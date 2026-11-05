#version 300 es
// Grows the lookup texture by one texel. A position inside a quad can fall in a
// texel whose centre lies outside the mesh, near the domain's edge; it still
// needs a seed, and the Newton steps decide whether it is inside. Grown texels
// are stored as -1 - (column, row), so the composite can tell them apart.
precision highp float;
precision highp sampler2D;

const float MISSING_THRESHOLD = -1.0e38;
const int NUM_NEIGHBOURS = 8;
const ivec2 NEIGHBOURS[NUM_NEIGHBOURS] = ivec2[NUM_NEIGHBOURS](
    ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
    ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1)
);

uniform sampler2D u_lookup;

out vec4 color;

void main() {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    vec2 value = texelFetch(u_lookup, texel, 0).rg;
    if (value.x < MISSING_THRESHOLD) {
        ivec2 last = textureSize(u_lookup, 0) - 1;
        for (int i = 0; i < NUM_NEIGHBOURS; i++) {
            vec2 neighbour = texelFetch(u_lookup, clamp(texel + NEIGHBOURS[i], ivec2(0), last), 0).rg;
            if (neighbour.x < MISSING_THRESHOLD) continue;
            value = neighbour.x < 0.0 ? neighbour : -1.0 - neighbour;
            break;
        }
    }
    color = vec4(value, 0.0, 1.0);
}
