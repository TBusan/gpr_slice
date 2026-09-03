#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "tiler.h"

namespace gvt {

// .gvtc chunk 容器（格式 v2）：把同一 (level, z-slab) 里连续 chunkSize 个 x 瓦片打包为一个文件，
// 整包一条 zstd 流（跨瓦片共享窗口），前端一次请求取到一批相邻瓦片。
// 前端 loader 优先读 .gvtc；缺失时回退单瓦片 .gvt（旧数据集兼容）。

constexpr uint32_t kChunkMagic = 0x47505243u; // "GPRC"
constexpr uint16_t kChunkVersion = 2;

// 24 字节 chunk 头（小端，packed）。
#pragma pack(push, 1)
struct ChunkHeader {
    uint8_t  magic[4];
    uint16_t version;
    uint16_t level;
    int32_t  chunkZ;    // z-slab 索引（= 瓦片 tz）
    int32_t  chunkX0;   // 起始 x 瓦片索引
    uint16_t count;     // 本 chunk 瓦片数
    uint16_t reserved;
    uint32_t dataOffset; // 压缩数据起始偏移（= 24 + count*20），自描述便于前端校验
};
#pragma pack(pop)
static_assert(sizeof(ChunkHeader) == 24, "ChunkHeader must be 24 bytes");

// 20 字节索引条目（小端，packed）。core* 为核心尺寸；store* = core* + 2*ghost（ghost 由 metadata 给出）。
// 前端需从 header 反推 store 尺寸，故此处存 core（与 BuildTile 的 TileDesc.coreW/H/D 一致）。
#pragma pack(push, 1)
struct ChunkEntry {
    int32_t  tx, ty, tz;
    uint16_t coreW, coreH, coreD;
    uint16_t reserved;
};
#pragma pack(pop)
static_assert(sizeof(ChunkEntry) == 20, "ChunkEntry must be 20 bytes");

constexpr uint32_t kChunkHeaderSize = sizeof(ChunkHeader); // 24
constexpr uint32_t kChunkEntrySize  = sizeof(ChunkEntry);  // 20

// 写一个 chunk 文件：{outDir}/tiles/{level}/z{tz}/x{tx0}.gvtc
// tiles：本 chunk 内按 tx 递增排序的瓦片（同 tz），只读。
// 返回文件总字节数（头 + 索引 + 压缩数据）；失败返回 -1。
int64_t WriteChunkFile(const std::string& outDirUtf8, int level, int tz, int tx0,
                       const std::vector<TileDesc>& tiles, int zstdLevel);

} // namespace gvt
