#pragma once

#include <cstdint>
#include <vector>

namespace gvt {

// 规则体：v[x + nx*(y + ny*z)]。x=沿轨、y=跨轨、z=深度。
struct Volume {
    int64_t nx = 0, ny = 0, nz = 0;
    std::vector<int16_t> v;

    size_t Count() const { return (size_t)(nx * ny * nz); }

    size_t Idx(int64_t x, int64_t y, int64_t z) const {
        return (size_t)(x + nx * (y + ny * z));
    }

    int16_t At(int64_t x, int64_t y, int64_t z) const { return v[Idx(x, y, z)]; }
    int16_t& At(int64_t x, int64_t y, int64_t z) { return v[Idx(x, y, z)]; }

    void Alloc(int64_t X, int64_t Y, int64_t Z) {
        nx = X;
        ny = Y;
        nz = Z;
        v.assign((size_t)(nx * ny * nz), 0);
    }
};

} // namespace gvt
