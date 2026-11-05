#version 300 es
// Draws the cell-centre mesh into the lookup texture.
precision highp float;

// Cell centre in degrees relative to the grid's origin.
in vec2 a_local;
// (column, row) of the cell.
in vec2 a_cell;

uniform vec2 u_lookup_origin;
uniform vec2 u_lookup_scale;
uniform vec2 u_lookup_size;

out vec2 v_cell;

void main() {
    vec2 raster = (a_local - u_lookup_origin) * u_lookup_scale;
    gl_Position = vec4(2.0 * raster / u_lookup_size - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    v_cell = a_cell;
}
