#pragma once

#include <cstdint>
#include <map>
#include <string>

namespace gvt {

// 单个通道的 .iprh 文本头解析结果。
struct ChannelHeader {
    int channels          = 0;  // CHANNELS
    int samples           = 0;  // SAMPLES
    int lastTrace         = 0;  // LAST TRACE
    int zeroLevel         = 0;  // ZERO LEVEL（直达波/地面起始采样）
    int signalPosition    = 0;  // SIGNAL POSITION

    double frequencyMHz        = 0.0; // FREQUENCY（5120 MHz → 0.1953 ns/采样）
    double timeWindowNs        = 0.0; // TIMEWINDOW
    double distanceIntervalM   = 0.0; // DISTANCE INTERVAL（m/道）
    double soilVelocity        = 0.0; // SOIL VELOCITY（m/µs）
    double chXOffsetM          = 0.0; // CH_X_OFFSET（跨轨偏移，m）

    std::map<std::string, std::string> raw; // 全部原始键值（键已规范化）
};

// 规范化键：" Distance  Interval " -> "DISTANCE INTERVAL"
std::string NormalizeKey(const std::string& s);

// 解析单个 .iprh（UTF-8 路径）。容忍注释/非 ASCII 行，无 ':' 的行跳过。
bool ParseIprhFile(const std::string& pathUtf8, ChannelHeader& out);

// 从 raw 取数值；找不到或解析失败返回 false。
bool GetIprhInt(const ChannelHeader& h, const char* key, int& out);
bool GetIprhDouble(const ChannelHeader& h, const char* key, double& out);

} // namespace gvt
