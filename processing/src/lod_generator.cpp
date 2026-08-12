#include "lod_generator.h"

#include <algorithm>

namespace gvt {

Volume DownsampleMaxAbs(const Volume& src, int sx, int sy, int sz) {
    if (sx <= 0) sx = 1;
    if (sy <= 0) sy = 1;
    if (sz <= 0) sz = 1;

    const int64_t ox = (src.nx + sx - 1) / sx;
    const int64_t oy = (src.ny + sy - 1) / sy;
    const int64_t oz = (src.nz + sz - 1) / sz;

    Volume out;
    out.Alloc(ox, oy, oz);

    for (int64_t z = 0; z < oz; ++z) {
        const int64_t z0 = z * sz, z1 = std::min(src.nz, z0 + sz);
        for (int64_t y = 0; y < oy; ++y) {
            const int64_t y0 = y * sy, y1 = std::min(src.ny, y0 + sy);
            for (int64_t x = 0; x < ox; ++x) {
                const int64_t x0 = x * sx, x1 = std::min(src.nx, x0 + sx);
                int16_t best = 0;
                int maxAbs = -1;
                for (int64_t zz = z0; zz < z1; ++zz) {
                    for (int64_t yy = y0; yy < y1; ++yy) {
                        for (int64_t xx = x0; xx < x1; ++xx) {
                            const int16_t val = src.At(xx, yy, zz);
                            const int a = val < 0 ? -val : val;
                            if (a > maxAbs) {
                                maxAbs = a;
                                best = val;
                            }
                        }
                    }
                }
                out.At(x, y, z) = best;
            }
        }
    }
    return out;
}

} // namespace gvt
