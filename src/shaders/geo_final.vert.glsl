// Draws the mesh over the field's domain for the final composite, in
// geographic mode.
//
// This is the body of the shader: it is assembled with `#version 300 es`,
// MapLibre's vertex shader prelude and its define (see geographic/programs.ts).

precision highp float;

// Web Mercator in 0..1; y = -1 marks the north pole, y = 2 the south pole.
in vec2 a_mercator;

uniform float u_world_offset;

// (longitude, latitude) in radians. The mesh's rows are evenly spaced in
// latitude, so linear interpolation is accurate.
out vec2 v_lonlat;

void main() {
    vec2 offset = vec2(u_world_offset, 0.0);
    float lon = (a_mercator.x - 0.5) * 2.0 * PI;
    if (a_mercator.y < -0.5) {
        // MapLibre's projectTile puts raw y below -32767.5 at the north pole.
        v_lonlat = vec2(lon, 0.5 * PI);
        gl_Position = projectTile(vec2(a_mercator.x, 0.0) + offset, vec2(0.0, -32768.0));
    } else if (a_mercator.y > 1.5) {
        // ... and raw y above 32766.5 at the south pole.
        v_lonlat = vec2(lon, -0.5 * PI);
        gl_Position = projectTile(vec2(a_mercator.x, 1.0) + offset, vec2(0.0, 32767.0));
    } else {
        v_lonlat = vec2(lon, atan(sinh(PI * (1.0 - 2.0 * a_mercator.y))));
        gl_Position = projectTile(a_mercator + offset);
    }
}
