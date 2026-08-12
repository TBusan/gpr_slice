#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "iprh_parser.h"
#include "volume.h"

namespace gvt {

struct RegularizeOptions {
    std::string zeroMode = "max";  // "max"=整线统一起点(地面平)；"channel"=各通道独立
    std::string alignMode = "max"; // 各通道 trace 数对齐（现仅 max，短通道尾部补 0）
};

struct RegularizedMeta {
    int    channels          = 0;
    int    samples           = 0;
    int    commonZeroLevel   = 0;
    double sampleTimeNs      = 0.0; // ns/采样
    double depthPerSampleM   = 0.0; // 深度 m/采样
    double soilVelocity      = 0.0; // m/µs
    double xSpacingM         = 0.0; // 沿轨 m/道
    double ySpacingM         = 0.0; // 跨轨均匀拟合间距
    std::vector<double> yOffsetsM;  // 各通道精确跨轨偏移（由 .ord/.iprh CH_X_OFFSET）
};

// 多通道原始数据 -> 规则卷。
// channelData[i] 为 trace-major int16，长度为 header[i].samples 的整数倍。
// xOffsetsByChannel[i] 为第 i 通道的跨轨偏移（用于按 x 排序确定 Y 轴）。
// outMin/outMax 在放置循环内顺带统计（避免后续再整卷扫描一次）。
void Regularize(const std::vector<ChannelHeader>& headers,
                const std::vector<std::vector<int16_t>>& channelData,
                const std::vector<double>& xOffsetsByChannel,
                const RegularizeOptions& opts,
                Volume& outVol, RegularizedMeta& outMeta,
                int16_t& outMin, int16_t& outMax);

} // namespace gvt
