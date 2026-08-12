#include "tiler.h"

#include <algorithm>
#include <climits>

namespace gvt {

TileGrid MakeTileGrid(const Volume& vol, int tileW, int tileH, int tileD, int ghost) {
    TileGrid g;
    g.tileW = std::max(1, tileW);
    g.tileH = std::max(1, tileH);
    g.tileD = std::max(1, tileD);
    g.ghost = std::max(0, ghost);
    g.ntx = (vol.nx + g.tileW - 1) / g.tileW;
    g.nty = (vol.ny + g.tileH - 1) / g.tileH;
    g.ntz = (vol.nz + g.tileD - 1) / g.tileD;
    return g;
}

void BuildTile(const Volume& vol, int level, int tx, int ty, int tz,
               const TileGrid& g, TileDesc& out) {
    const int ghost = g.ghost;
    const int64_t cx0 = (int64_t)tx * g.tileW, cx1 = std::min(vol.nx, cx0 + g.tileW);
    const int64_t cy0 = (int64_t)ty * g.tileH, cy1 = std::min(vol.ny, cy0 + g.tileH);
    const int64_t cz0 = (int64_t)tz * g.tileD, cz1 = std::min(vol.nz, cz0 + g.tileD);

    out.level = level;
    out.tx = tx; out.ty = ty; out.tz = tz;
    out.coreW  = (int)(cx1 - cx0);
    out.coreH  = (int)(cy1 - cy0);
    out.coreD  = (int)(cz1 - cz0);
    out.storeW = out.coreW + 2 * ghost;
    out.storeH = out.coreH + 2 * ghost;
    out.storeD = out.coreD + 2 * ghost;
    out.data.assign((size_t)out.storeW * out.storeH * out.storeD, 0);

    // 填 ghost 区（含核心区）：x 最内连续读源卷行，sw 用行基址步进。
    const int64_t stepZ = vol.nx * vol.ny;
    for (int sd = 0; sd < out.storeD; ++sd) {
        const int64_t wz = std::clamp(cz0 - ghost + sd, (int64_t)0, vol.nz - 1);
        for (int sh = 0; sh < out.storeH; ++sh) {
            const int64_t wy = std::clamp(cy0 - ghost + sh, (int64_t)0, vol.ny - 1);
            const int16_t* srcRow = &vol.v[(size_t)(vol.nx * wy + stepZ * wz)];
            int16_t* dst = &out.data[(size_t)(sd * out.storeH + sh) * out.storeW];
            for (int sw = 0; sw < out.storeW; ++sw) {
                const int64_t wx = std::clamp(cx0 - ghost + sw, (int64_t)0, vol.nx - 1);
                dst[sw] = srcRow[wx];
            }
        }
    }

    // 核心区统计（独立连续扫描，去掉填值阶段的每体素分支）。
    double sum = 0;
    int mn = INT16_MAX, mx = INT16_MIN;
    const int64_t coreCount = (int64_t)out.coreW * out.coreH * out.coreD;
    const int64_t gx0 = ghost, gx1 = ghost + out.coreW;
    const int64_t gy0 = ghost, gy1 = ghost + out.coreH;
    const int64_t gz0 = ghost, gz1 = ghost + out.coreD;
    for (int sd = (int)gz0; sd < (int)gz1; ++sd) {
        for (int sh = (int)gy0; sh < (int)gy1; ++sh) {
            const int16_t* p = &out.data[(size_t)(sd * out.storeH + sh) * out.storeW];
            for (int sw = (int)gx0; sw < (int)gx1; ++sw) {
                const int16_t val = p[sw];
                if (val < mn) mn = val;
                if (val > mx) mx = val;
                sum += (double)val;
            }
        }
    }

    out.minV  = (mn == INT16_MAX) ? 0.0f : (float)mn;
    out.maxV  = (mx == INT16_MIN) ? 0.0f : (float)mx;
    out.meanV = coreCount ? (float)(sum / (double)coreCount) : 0.0f;
}

void BuildTiles(const Volume& vol, int level, int tileW, int tileH, int tileD,
                int ghost, std::vector<TileDesc>& out) {
    out.clear();
    TileGrid g = MakeTileGrid(vol, tileW, tileH, tileD, ghost);
    out.reserve((size_t)g.Count());
    for (int64_t tz = 0; tz < g.ntz; ++tz) {
        for (int64_t ty = 0; ty < g.nty; ++ty) {
            for (int64_t tx = 0; tx < g.ntx; ++tx) {
                TileDesc t;
                BuildTile(vol, level, (int)tx, (int)ty, (int)tz, g, t);
                out.push_back(std::move(t));
            }
        }
    }
}

} // namespace gvt
