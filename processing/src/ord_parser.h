#pragma once

#include <string>
#include <vector>

namespace gvt {

// .ord 一行：channelIndex  xOffset(m)  yOffset(m)  valid
struct ChannelOffset {
    int    channel = -1;
    double xOffset = 0.0;
    double yOffset = 0.0;
    bool   valid   = false;
};

// 解析 .ord 通道表。返回全部行（含无效通道）。
bool ParseOrdFile(const std::string& pathUtf8, std::vector<ChannelOffset>& out);

} // namespace gvt
