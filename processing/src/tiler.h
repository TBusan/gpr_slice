#pragma once

#include <cstdint>
#include <vector>

#include "volume.h"

namespace gvt {

struct TileDesc {
    int   level   = 0;
    int   tx = 0, ty = 0, tz = 0;  // 瓦片坐标
    int   coreW = 0, coreH = 0, coreD = 0;   // 核心尺寸（边界瓦片可能不满）
    int   storeW = 0, storeH = 0, storeD = 0; // 核心 + 2*ghost
    float minV = 0.f, maxV = 0.f, meanV = 0.f; // 只统计核心区
    std::vector<int16_t> data;  // storeW*storeH*storeD，含 ghost 边界（clamp 填充）

    // 存储坐标 (sw,sh,sd) 对应的世界体素：wx = tx*tileW - ghost + sw（并 clamp 到卷边界）
};

// 对指定层级卷分块（含 ghost 与统计）。
void BuildTiles(const Volume& vol, int level, int tileW, int tileH, int tileD,
                int ghost, std::vector<TileDesc>& out);

} // namespace gvt
