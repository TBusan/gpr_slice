#include "tiler.h"

#include <algorithm>
#include <climits>

namespace gvt {

void BuildTiles(const Volume& vol, int level, int tileW, int tileH, int tileD,
                int ghost, std::vector<TileDesc>& out) {
    out.clear();
    if (tileW <= 0 || tileH <= 0 || tileD <= 0) return;
    if (ghost < 0) ghost = 0;

    const int64_t ntx = (vol.nx + tileW - 1) / tileW;
    const int64_t nty = (vol.ny + tileH - 1) / tileH;
    const int64_t ntz = (vol.nz + tileD - 1) / tileD;
    out.reserve((size_t)(ntx * nty * ntz));

    for (int64_t tz = 0; tz < ntz; ++tz) {
        for (int64_t ty = 0; ty < nty; ++ty) {
            for (int64_t tx = 0; tx < ntx; ++tx) {
                TileDesc t;
                t.level = level;
                t.tx = (int)tx;
                t.ty = (int)ty;
                t.tz = (int)tz;

                const int64_t cx0 = tx * tileW, cx1 = std::min(vol.nx, cx0 + tileW);
                const int64_t cy0 = ty * tileH, cy1 = std::min(vol.ny, cy0 + tileH);
                const int64_t cz0 = tz * tileD, cz1 = std::min(vol.nz, cz0 + tileD);

                t.coreW  = (int)(cx1 - cx0);
                t.coreH  = (int)(cy1 - cy0);
                t.coreD  = (int)(cz1 - cz0);
                t.storeW = t.coreW + 2 * ghost;
                t.storeH = t.coreH + 2 * ghost;
                t.storeD = t.coreD + 2 * ghost;

                t.data.assign((size_t)t.storeW * t.storeH * t.storeD, 0);

                double sum = 0;
                int mn = INT16_MAX, mx = INT16_MIN;
                const int64_t coreCount = (int64_t)t.coreW * t.coreH * t.coreD;

                for (int sd = 0; sd < t.storeD; ++sd) {
                    const int64_t wz = std::clamp(cz0 - ghost + sd, (int64_t)0, vol.nz - 1);
                    for (int sh = 0; sh < t.storeH; ++sh) {
                        const int64_t wy = std::clamp(cy0 - ghost + sh, (int64_t)0, vol.ny - 1);
                        for (int sw = 0; sw < t.storeW; ++sw) {
                            const int64_t wx = std::clamp(cx0 - ghost + sw, (int64_t)0, vol.nx - 1);
                            const int16_t val = vol.At(wx, wy, wz);
                            t.data[(size_t)(sw + t.storeW * (sh + t.storeH * sd))] = val;

                            const bool core = (sw >= ghost && sw < ghost + t.coreW &&
                                               sh >= ghost && sh < ghost + t.coreH &&
                                               sd >= ghost && sd < ghost + t.coreD);
                            if (core) {
                                if (val < mn) mn = val;
                                if (val > mx) mx = val;
                                sum += (double)val;
                            }
                        }
                    }
                }

                t.minV  = (mn == INT16_MAX) ? 0.0f : (float)mn;
                t.maxV  = (mx == INT16_MIN) ? 0.0f : (float)mx;
                t.meanV = coreCount ? (float)(sum / (double)coreCount) : 0.0f;
                out.push_back(std::move(t));
            }
        }
    }
}

} // namespace gvt
