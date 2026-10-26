bool is_missing_velocity(vec4 raw) {
    // FEWS sentinel or a fully transparent velocity pixel.
    return (raw.r == 1.0 && raw.g == 1.0) || raw.a == 0.0;
}
