bool is_missing_velocity(vec4 raw) {
    // There is no velocity if r = g = 255.
    return raw.r == 1.0 && raw.g == 1.0;
}
