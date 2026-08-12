#include "regularizer.h"

#include <algorithm>
#include <cstdio>

namespace gvt {

void Regularize(const std::vector<ChannelHeader>& headers,
                const std::vector<std::vector<int16_t>>& channelData,
                const std::vector<double>& xOffsetsByChannel,
                const RegularizeOptions& opts,
                Volume& outVol, RegularizedMeta& outMeta) {
    const int nc = (int)headers.size();
    if (nc == 0) return;

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
                    if (s >= 0 && s < samples) val = src[row + s];
                }
                outVol.At(x, y, z) = val;
            }
        }
        std::fprintf(stderr, "  [ch] Y=%d 通道#%d trace=%lld xOff=%+.3f 已就位\n",
                     y, ch, (long long)n, xOffsetsByChannel[ch]);
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
