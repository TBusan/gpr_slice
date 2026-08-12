#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace gvt {

// 读取 .iprb（int16 小端，trace-major：data[trace*samples + sample]）。
// 实际 trace 数由文件大小反算（filesize / (samples*2)），不依赖头部的 LAST TRACE。
// 成功返回 true；outTraces 为实际 trace 数。
bool ReadIprbFile(const std::string& pathUtf8, int samples, int64_t& outTraces,
                  std::vector<int16_t>& outData);

} // namespace gvt
