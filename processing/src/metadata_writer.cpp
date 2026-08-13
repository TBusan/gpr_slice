#include "metadata_writer.h"

#include <filesystem>
#include <fstream>

#include "json.hpp"
#include "gvt_common.h"

namespace gvt {

using nlohmann::json;

bool WriteMetadataFile(const std::string& outDirUtf8, const Metadata& meta) {
    namespace fs = std::filesystem;
    fs::path dir = fs::u8path(outDirUtf8);
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) return false;

    json j;
    j["format"] = "GPR-Volume-Tile";
    j["version"] = "1.0";

    j["dataset"]["id"] = meta.datasetId;
    j["dataset"]["name"] = meta.datasetName;

    j["volume"]["dimensions"] = {meta.lod0Nx, meta.lod0Ny, meta.lod0Nz};
    j["volume"]["voxelType"] = "int16";
    j["volume"]["axisOrder"] = {"x", "y", "z"};

    const double originY = meta.spatial.yOffsetsM.empty() ? 0.0 : meta.spatial.yOffsetsM.front();
    j["spatial"]["origin"] = {0.0, originY, 0.0};
    j["spatial"]["coordinateSystem"]["type"] = "LOCAL";
    j["spatial"]["coordinateSystem"]["code"] = 0;
    j["spatial"]["axis"]["x"]["type"] = "distance";
    j["spatial"]["axis"]["x"]["unit"] = "m";
    j["spatial"]["axis"]["y"]["type"] = "distance";
    j["spatial"]["axis"]["y"]["unit"] = "m";
    j["spatial"]["axis"]["z"]["type"] = "depth";
    j["spatial"]["axis"]["z"]["unit"] = "m";
    j["spatial"]["axis"]["z"]["velocity"] = meta.spatial.soilVelocity;
    j["spatial"]["axis"]["z"]["velocityUnit"] = "m/us";
    j["spatial"]["axis"]["z"]["sampleTimeNs"] = meta.spatial.sampleTimeNs;
    j["spatial"]["axis"]["z"]["depthPerSampleM"] = meta.spatial.depthPerSampleM;
    j["spatial"]["channelOffsetsY"] = meta.spatial.yOffsetsM;

    j["tile"]["size"] = {meta.tileW, meta.tileH, meta.tileD};
    j["tile"]["ghost"] = meta.ghost;

    j["value"]["type"] = "int16";
    j["value"]["scale"] = meta.valueScale;
    j["value"]["offset"] = meta.valueOffset;
    j["value"]["globalMin"] = (double)meta.globalMin;
    j["value"]["globalMax"] = (double)meta.globalMax;

    j["levels"] = json::array();
    for (const auto& l : meta.levels) {
        json jl;
        jl["level"] = l.level;
        jl["scale"] = {l.sx, l.sy, l.sz};
        jl["dimensions"] = {l.nx, l.ny, l.nz};
        jl["spacing"] = {l.spx, l.spy, l.spz};
        jl["kernel"] = l.kernel;
        j["levels"].push_back(jl);
    }

    if (meta.hasSliceLevel) {
        const auto& l = meta.sliceLevel;
        j["sliceLevel"] = {
            {"level", l.level},
            {"scale", {l.sx, l.sy, l.sz}},
            {"dimensions", {l.nx, l.ny, l.nz}},
            {"spacing", {l.spx, l.spy, l.spz}},
            {"kernel", l.kernel},
        };
    }

    j["storage"]["tilePath"] = "tiles/{level}/{x}/{y}/{z}.gvt";
    j["storage"]["compression"] = "zstd";

    if (!meta.gps.utmPoints.empty()) {
        j["gpsTrack"]["utm"]["zone"] = meta.gps.utmZone;
        j["gpsTrack"]["utm"]["hemisphere"] = meta.gps.utmHemisphereN ? "N" : "S";
        j["gpsTrack"]["points"] = json::array();
        for (const auto& p : meta.gps.utmPoints) {
            j["gpsTrack"]["points"].push_back({p.first, p.second});
        }
    }

    std::ofstream out(fs::u8path(outDirUtf8) / "metadata.json", std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out << j.dump(2);
    return out.good();
}

} // namespace gvt
