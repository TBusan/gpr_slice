#pragma once

#include <cstdint>
#include <string>

#include "tiler.h"

namespace gvt {

// 写 .gvt 文件：{outDir}/tiles/{level}/{tx}/{ty}/{tz}.gvt
// 返回该文件总字节数（头+统计+压缩数据）；失败返回 -1。
int64_t WriteGvtFile(const std::string& outDirUtf8, const TileDesc& tile, int zstdLevel);

} // namespace gvt
