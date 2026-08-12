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

// 瓦片网格：把某级卷切成 ntx×nty×ntz 个瓦片（由卷尺寸一次算出）。
struct TileGrid {
    int64_t ntx = 0, nty = 0, ntz = 0;
    int tileW = 0, tileH = 0, tileD = 0;
    int ghost = 0;

    int64_t Count() const { return ntx * nty * ntz; }

    // 由线性序号反解瓦片坐标（P1 并行分发用）。
    void Decode(int64_t idx, int& tx, int& ty, int& tz) const {
        tz = (int)(idx / (ntx * nty));
        ty = (int)((idx / ntx) % nty);
        tx = (int)(idx % ntx);
    }
};

// 由卷尺寸生成网格。
TileGrid MakeTileGrid(const Volume& vol, int tileW, int tileH, int tileD, int ghost);

// 构建单个瓦片（只读 vol，线程安全）。out.data 内部分配。
void BuildTile(const Volume& vol, int level, int tx, int ty, int tz,
               const TileGrid& grid, TileDesc& out);

// 兼容旧调用：构建全部瓦片（内部循环 BuildTile）。
void BuildTiles(const Volume& vol, int level, int tileW, int tileH, int tileD,
                int ghost, std::vector<TileDesc>& out);

} // namespace gvt
