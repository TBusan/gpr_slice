#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "regularizer.h"
#include "volume.h"

namespace gvt {

struct LevelInfo {
    int    level = 0;
    int    sx = 1, sy = 1, sz = 1;      // 累积 scale（相对 LOD0）
    int64_t nx = 0, ny = 0, nz = 0;      // 体素尺寸
    double spx = 0, spy = 0, spz = 0;    // 间距（m/体素）
    std::string kernel = "maxabs";       // 降采样核："maxabs"（3D 链）| "mean"（切片链）
};

struct GpsTrack {
    std::vector<std::pair<double, double>> utmPoints; // 中心线 (E,N)，源自 .utmgps
    int  utmZone       = 51;
    bool utmHemisphereN = true;
};

struct Metadata {
    std::string datasetId;
    std::string datasetName;
    int64_t lod0Nx = 0, lod0Ny = 0, lod0Nz = 0; // LOD0 体素尺寸（move 之前取值拷贝，见 main.cpp）
    RegularizedMeta spatial;
    int tileW = 256, tileH = 32, tileD = 32;
    int ghost = 1;
    double valueScale  = 1.0;
    double valueOffset = 0.0;
    int16_t globalMin = 0, globalMax = 0;
    std::vector<LevelInfo> levels;
    GpsTrack gps;

    // 切片专用平滑 LOD（kernel="mean"），独立于 max-abs 链，供 B-Scan/C-Scan 读取。
    // 不在 levels[] 里（避免干扰 3D 的 LOD 递归：computeDesired 假定级别连续单调）。
    LevelInfo sliceLevel;
    bool hasSliceLevel = false;
};

// 写 metadata.json 到 {outDir}/metadata.json。
bool WriteMetadataFile(const std::string& outDirUtf8, const Metadata& meta);

} // namespace gvt
