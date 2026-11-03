#version 300 es
precision highp float;

uniform int u_style;
uniform float u_particle_opacity;
uniform vec3 u_particle_color;

uniform sampler2D u_particle_texture;
uniform sampler2D u_colormap_texture;
uniform sampler2D u_velocity_texture;

uniform float u_colormap_start;
uniform float u_colormap_end;

uniform vec2 u_scale;
uniform vec2 u_offset;

in vec2 v_tex_coord;
in vec2 v_flipped_tex_coord;

out vec4 color;

#include is_missing_velocity;
#include composite_style;

float get_speed(vec2 pos) {
    vec4 velocity_raw = texture(u_velocity_texture, pos);

    // Set missing velocities to zero.
    if (is_missing_velocity(velocity_raw)) {
        return 0.0;
    }

    // Compute velocity in physical units.
    vec2 velocity = velocity_raw.rg * u_scale + u_offset;
    return length(velocity);
}

void main() {
    // Get the speed at the current point (in physical units), we need flipped
    // texture coordinates because the velocity texture was loaded from an
    // image and therefore flipped vertically.
    float speed = get_speed(v_flipped_tex_coord);

    if (speed > 0.0) {
        // Find the coordinate into the colormap texture for this speed.
        vec2 colormap_coords = vec2(0.0, 0.0);
        colormap_coords.s = clamp(
            (speed - u_colormap_start) / (u_colormap_end - u_colormap_start),
            0.0, 1.0
        );
        // Interpolate the colormap texture for this value.
        lowp vec4 magnitude_color = texture(u_colormap_texture, colormap_coords);

        // Interpolate the particle texture at this point.
        lowp vec4 particle_color = texture(u_particle_texture, v_tex_coord);

        // Blend the velocity magnitude texture with the particle texture.
        color = composite_style(magnitude_color, particle_color);
    } else {
        color = vec4(0.0, 0.0, 0.0, 0.0);
    }
}
