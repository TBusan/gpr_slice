#pragma once

#include <cstdint>

namespace gvt {

// 文件魔数 "GPRV"（规格书 §15）
constexpr uint32_t kMagic = 0x47505256u;

// 格式版本（规格书 §14）
constexpr uint16_t kVersion = 1;

// 体素数据类型（规格书 §16）。写端与前端必须一致。
enum DataType : uint8_t {
    kUInt8   = 1,
    kInt16   = 2,
    kUInt16  = 3,
    kInt32   = 4,
    kFloat32 = 5,
    kInt8    = 6,
};

// 压缩方式（规格书 §21）
enum Compression : uint8_t {
    kCompressionNone = 0,
    kCompressionGzip = 1,
    kCompressionZstd = 2,
};

// 固定 40 字节瓦片头（规格书 §14/§29）。所有整数小端。
#pragma pack(push, 1)
struct GvtHeader {
    uint8_t  magic[4];
    uint16_t version;
    uint16_t flags;
    uint16_t level;
    uint16_t reserved;
    int32_t  x;         // 瓦片坐标（世界体素原点 = x * tileSize）
    int32_t  y;
    int32_t  z;
    uint16_t width;     // 存储尺寸（含 ghost）
    uint16_t height;
    uint16_t depth;
    uint8_t  dataType;      // DataType
    uint8_t  compression;   // Compression
    uint32_t dataOffset;    // 压缩数据起始偏移（= 52）
    uint32_t dataLength;    // 压缩数据字节数
};
#pragma pack(pop)
static_assert(sizeof(GvtHeader) == 40, "GvtHeader must be 40 bytes");

// 12 字节统计块（规格书 §18/§29）。只统计瓦片核心区。
#pragma pack(push, 1)
struct GvtStats {
    float min;
    float max;
    float mean;
};
#pragma pack(pop)
static_assert(sizeof(GvtStats) == 12, "GvtStats must be 12 bytes");

constexpr uint32_t kHeaderSize = sizeof(GvtHeader);   // 40
constexpr uint32_t kStatsSize  = sizeof(GvtStats);    // 12
constexpr uint32_t kDataOffset = kHeaderSize + kStatsSize; // 52

} // namespace gvt
