#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_tex_coord;

uniform int u_width;
uniform highp sampler2D u_particle_data_texture;
uniform highp sampler2D u_particle_age_texture;

uniform float u_particle_size;
uniform float u_aspect_ratio;

uniform lowp int u_is_sprite;

uniform vec2 u_bbox_scale;
uniform vec2 u_bbox_offset;

uniform float u_growth_rate;

out vec2 v_tex_coord;

float compute_particle_size(float age) {
    // Grow up to a maximum of the particle size.
    float unconstrained_size = age * u_growth_rate * u_particle_size;
    return min(unconstrained_size, u_particle_size);
}

void main() {
    // Obtain particle position from texture.
    ivec2 texture_indices = ivec2(
        gl_InstanceID / u_width,
        gl_InstanceID % u_width
    );
    const int mipmap_level = 0;
    vec4 particle_data = texelFetch(
        u_particle_data_texture,
        texture_indices,
        mipmap_level
    );
    float particle_age = texelFetch(
        u_particle_age_texture,
        texture_indices,
        mipmap_level
    ).r;

    vec2 particle_position = particle_data.xy;
    vec2 particle_velocity = particle_data.zw;

    if (particle_velocity.x == 0.0 && particle_velocity.y == 0.0) {
        // If the velocity is exactly zero, we are in a position where no
        // velocity has been defined. Return the same position for all vertices,
        // resulting in degenerate triangles that will not be rendered.
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec2 position = a_position;
    if (u_is_sprite == 1) {
        // Rotate the quad according to the velocity direction. We take the
        // velocity direction as the y-axis of a local coordinate system, and
        // a vector perpendicular to that as the x-axis. This gives two basis
        // vectors:
        //
        //     e1 = (v, -u)    e2 = (u, v)
        //
        // Hence, a transformation matrix from world coordinate to this local
        // coordinate system is:
        //
        //     [ v u ]
        //     [-u v ]
        //
        vec2 direction = normalize(particle_velocity);
        mat2 transformation = mat2(
            vec2(-direction.y, direction.x),
            direction
        );
        position = transformation * position;
    }

    // Scale quad and correct for aspect ratio.
    position *= compute_particle_size(particle_age);
    position.y *= u_aspect_ratio;

    gl_Position = vec4(
        position + particle_position,
        0.0, 1.0
    );

    // Scale bounding box.
    gl_Position.xy = gl_Position.xy * u_bbox_scale + u_bbox_offset;

    v_tex_coord = a_tex_coord;
}
