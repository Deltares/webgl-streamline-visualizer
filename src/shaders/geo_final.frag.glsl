#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#include is_missing_velocity;
#include sample_velocity;
#include sample_curvilinear;
#include sample_field;

uniform int u_style;
uniform float u_particle_opacity;
uniform vec3 u_particle_color;

uniform sampler2D u_particle_texture;
uniform sampler2D u_colormap_texture;

uniform float u_colormap_start;
uniform float u_colormap_end;

in vec2 v_lonlat;

out vec4 color;

#include composite_style;

void main() {
    vec2 lonlat = v_lonlat;

    vec2 velocity;
    if (!sample_field_coarse(lonlat, velocity)) {
        color = vec4(0.0);
        return;
    }
    float speed = length(velocity);

    vec2 colormap_coords = vec2(
        clamp((speed - u_colormap_start) / (u_colormap_end - u_colormap_start), 0.0, 1.0),
        0.0
    );
    vec4 magnitude_color = texture(u_colormap_texture, colormap_coords);

    // The trail texture has the size of the drawing buffer.
    vec4 particle_color = texelFetch(u_particle_texture, ivec2(gl_FragCoord.xy), 0);

    color = composite_style(magnitude_color, particle_color);
}
