// Blends the velocity magnitude colour with the particle trail colour according
// to u_style, whose values correspond to the StreamlineStyle enum. Requires the
// uniforms u_style, u_particle_opacity and u_particle_color.
vec4 composite_style(vec4 magnitude_color, vec4 particle_color) {
    if (u_style == 0) {
        // Light particles on velocity magnitude.
        return mix(
            magnitude_color,
            vec4(1.0, 1.0, 1.0, 1.0),
            particle_color.a * u_particle_opacity
        );
    } else if (u_style == 1) {
        // Dark particles on velocity magnitude.
        float factor = 1.0 - particle_color.a * u_particle_opacity;
        vec4 color = magnitude_color;
        color.rgb *= factor * 0.8 + 0.2;
        return color;
    } else if (u_style == 2) {
        // Particles coloured by velocity magnitude on a transparent background.
        vec4 color = magnitude_color * particle_color.a;
        color.a = particle_color.a;
        return color;
    } else if (u_style == 3) {
        // Coloured particles on velocity magnitude.
        vec4 color = magnitude_color;
        color.rgb = mix(magnitude_color.rgb, particle_color.rgb, particle_color.a);
        return color;
    } else if (u_style == 4) {
        // Particles in the particle colour on a transparent background, for
        // maps that draw the magnitude themselves. The colour comes from the
        // option, since additive blending saturates the trail texture's.
        return vec4(u_particle_color, particle_color.a * u_particle_opacity);
    }
    // Invalid style, render transparent pixels.
    return vec4(0.0, 0.0, 0.0, 0.0);
}
