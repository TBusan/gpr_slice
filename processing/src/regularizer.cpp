#include "regularizer.h"

#include <algorithm>
#include <climits>
#include <cstdio>

namespace gvt {

void Regularize(const std::vector<ChannelHeader>& headers,
                const std::vector<std::vector<int16_t>>& channelData,
                const std::vector<double>& xOffsetsByChannel,
                const RegularizeOptions& opts,
                Volume& outVol, RegularizedMeta& outMeta,
                int16_t& outMin, int16_t& outMax) {
    const int nc = (int)headers.size();
    if (nc == 0) {
        outMin = outMax = 0;
        return;
    }

    const int samples = headers[0].samples;
    if (samples <= 0) {
        std::fprintf(stderr, "  [error] SAMPLES 无效\n");
        return;
    }

    // 各通道实际 trace 数（由数据长度反算）
    std::vector<int64_t> ntr(nc);
    for (int i = 0; i < nc; ++i) ntr[i] = (int64_t)(channelData[i].size() / samples);

    // 通道按跨轨偏移排序 -> Y 轴
    std::vector<int> order(nc);
    for (int i = 0; i < nc; ++i) order[i] = i;
    std::sort(order.begin(), order.end(), [&](int a, int b) {
        return xOffsetsByChannel[a] < xOffsetsByChannel[b];
    });

    // 裁剪起点：max 模式 = 整线最大 ZERO LEVEL（地面平）；channel 模式 = 各通道独立
    int zeroMax = 0, zeroMin = INT32_MAX;
    for (int i = 0; i < nc; ++i) {
        zeroMax = std::max(zeroMax, headers[i].zeroLevel);
        zeroMin = std::min(zeroMin, headers[i].zeroLevel);
    }
    const bool perChannel = (opts.zeroMode == "channel");
    const int commonStart = perChannel ? zeroMin : zeroMax;

    int64_t nx = 0;
    for (int i = 0; i < nc; ++i) nx = std::max(nx, ntr[i]);
    const int64_t ny = nc;
    const int64_t nz = std::max((int64_t)0, (int64_t)samples - commonStart);

    outVol.Alloc(nx, ny, nz);

    int mn = INT16_MAX, mx = INT16_MIN;
    for (int y = 0; y < nc; ++y) {
        const int ch = order[y];
        const int zeroCh = headers[ch].zeroLevel;
        const int64_t n = ntr[ch];
        const std::vector<int16_t>& src = channelData[ch];
        for (int64_t x = 0; x < nx; ++x) {
            const int64_t row = x * samples;
            for (int64_t z = 0; z < nz; ++z) {
                int16_t val = 0;
                if (x < n) {
                    const int s = perChannel ? (zeroCh + (int)z) : (commonStart + (int)z);
                    if (s >= 0 && s < samples) {
                        val = src[row + s];
                        // 只统计真实采样：越界/padding 的 0 不计入全局 min/max（否则污染统计）。
                        if (val < mn) mn = val;
                        if (val > mx) mx = val;
                    }
                }
                outVol.At(x, y, z) = val;
            }
        }
        std::fprintf(stderr, "  [ch] Y=%d 通道#%d trace=%lld xOff=%+.3f 已就位\n",
                     y, ch, (long long)n, xOffsetsByChannel[ch]);
    }
    outMin = (mn == INT16_MAX) ? 0 : (int16_t)mn;
    outMax = (mx == INT16_MIN) ? 0 : (int16_t)mx;

    // 通道元数据一致性：timeWindowNs/soilVelocity 各通道应一致；不一致 warn（仍用 headers[0]）。
    for (int i = 1; i < nc; ++i) {
        if (headers[i].timeWindowNs != headers[0].timeWindowNs)
            std::fprintf(stderr, "  [warn] 通道#%d timeWindowNs(%.4g) 与通道#0(%.4g) 不一致\n",
                         i, headers[i].timeWindowNs, headers[0].timeWindowNs);
        if (headers[i].soilVelocity != headers[0].soilVelocity)
            std::fprintf(stderr, "  [warn] 通道#%d soilVelocity(%.3g) 与通道#0(%.3g) 不一致\n",
                         i, headers[i].soilVelocity, headers[0].soilVelocity);
    }

    // 元数据
    outMeta.channels = nc;
    outMeta.samples = samples;
    outMeta.commonZeroLevel = commonStart;
    outMeta.sampleTimeNs = headers[0].timeWindowNs > 0 ? headers[0].timeWindowNs / samples : 0.0;
    outMeta.soilVelocity = headers[0].soilVelocity;
    // depth = t(ns) * v/2，v: m/µs -> m/ns = v/1000，两倍时程再 /2
    outMeta.depthPerSampleM = outMeta.sampleTimeNs * (headers[0].soilVelocity / 2000.0);
    outMeta.xSpacingM = headers[0].distanceIntervalM;

    outMeta.yOffsetsM.clear();
    for (int y = 0; y < nc; ++y) outMeta.yOffsetsM.push_back(xOffsetsByChannel[order[y]]);
    if (nc > 1) {
        outMeta.ySpacingM = (outMeta.yOffsetsM.back() - outMeta.yOffsetsM.front()) / (nc - 1);
    } else {
        outMeta.ySpacingM = 0.0;
    }
}

} // namespace gvt
