// Samples the velocity field: up to two fields in priority order, each regular
// or curvilinear, with fallback where the first one is missing.
//
// Requires `is_missing_velocity`, `sample_velocity` and `sample_curvilinear` to
// be included first. Samplers cannot be indexed dynamically, so the slots are
// spelled out; see `MAX_NESTED_FIELDS` in src/geographic/velocity-field.ts.

const int FIELD_KIND_REGULAR = 0;
const int FIELD_KIND_CURVILINEAR = 1;

struct VelocityFieldSlot {
    // FIELD_KIND_REGULAR or FIELD_KIND_CURVILINEAR.
    int kind;
    VelocityGrid regular;
    CurvilinearGrid curvilinear;
};

uniform int u_field_count;
uniform VelocityFieldSlot u_field_0;
uniform VelocityFieldSlot u_field_1;
uniform sampler2D u_field_values_0;
uniform sampler2D u_field_values_1;
uniform sampler2D u_field_lookup_0;
uniform sampler2D u_field_lookup_1;
uniform sampler2D u_field_corners_0;
uniform sampler2D u_field_corners_1;

// Samples the field at (longitude, latitude) in radians.
bool sample_field(vec2 lonlat, out vec2 velocity) {
    bool isValid = u_field_0.kind == FIELD_KIND_REGULAR
        ? sample_velocity(u_field_values_0, u_field_0.regular, lonlat, velocity)
        : sample_curvilinear(u_field_values_0, u_field_lookup_0, u_field_corners_0, u_field_0.curvilinear, lonlat, velocity);
    if (isValid || u_field_count < 2) return isValid;
    return u_field_1.kind == FIELD_KIND_REGULAR
        ? sample_velocity(u_field_values_1, u_field_1.regular, lonlat, velocity)
        : sample_curvilinear(u_field_values_1, u_field_lookup_1, u_field_corners_1, u_field_1.curvilinear, lonlat, velocity);
}

// As sample_field, but cheap enough for every fragment of the composite.
bool sample_field_coarse(vec2 lonlat, out vec2 velocity) {
    bool isValid = u_field_0.kind == FIELD_KIND_REGULAR
        ? sample_velocity(u_field_values_0, u_field_0.regular, lonlat, velocity)
        : sample_curvilinear_coarse(u_field_values_0, u_field_lookup_0, u_field_0.curvilinear, lonlat, velocity);
    if (isValid || u_field_count < 2) return isValid;
    return u_field_1.kind == FIELD_KIND_REGULAR
        ? sample_velocity(u_field_values_1, u_field_1.regular, lonlat, velocity)
        : sample_curvilinear_coarse(u_field_values_1, u_field_lookup_1, u_field_1.curvilinear, lonlat, velocity);
}
