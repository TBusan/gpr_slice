// gpr2gvt —— 国产阵列 GPR (.iprh/.iprb/.ord) → GPR Volume Tile (.gvt) + metadata.json
//
// 用法：
//   gpr2gvt --line "data/mingxingroad/明星路_001" [--out dataset]
//          [--zero-mode max|channel] [--tile-size W,H,D] [--ghost 1]
//          [--lod-scale X,Y,Z] [--levels 4] [--zstd-level 12] [--jobs N]
//          [--gps <路径>]
//
// Windows 中文路径：用 GetCommandLineW/CommandLineToArgvW 取宽字符 argv，
// 内部统一 UTF-8，文件系统边界用 std::filesystem::u8path 转换。

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "gvt_common.h"
#include "gvt_writer.h"
#include "iprh_parser.h"
#include "iprb_reader.h"
#include "lod_generator.h"
#include "metadata_writer.h"
#include "ord_parser.h"
#include "regularizer.h"
#include "thread_pool.h"
#include "tiler.h"

namespace fs = std::filesystem;
using namespace gvt;

// ------------------------------------------------------------------ 宽字符 argv
static std::string WideToUtf8(const wchar_t* s) {
    if (!s) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return {};
    std::string out(n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s, -1, &out[0], n, nullptr, nullptr);
    return out;
}

static std::vector<std::string> GetUtf8Args() {
    int argc = 0;
    LPWSTR* argvw = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<std::string> out;
    if (argvw) {
        for (int i = 0; i < argc; ++i) out.push_back(WideToUtf8(argvw[i]));
        LocalFree(argvw);
    }
    return out;
}

// ------------------------------------------------------------------ CLI 参数
struct CliArgs {
    std::string line;
    std::string out = "dataset";
    std::string zeroMode = "max";
    int tileW = 256, tileH = 32, tileD = 32;
    int ghost = 1;
    int sx = 2, sy = 1, sz = 2;
    int levels = 4;
    std::string align = "max";
    int zstdLevel = 12;
    int jobs = 0;              // 0 = 自动（min(hardware_concurrency,8)）
    std::string gps;           // 空 = 由 --line 基名派生 .utmgps
    int sliceLod = 2;          // 切片专用 mean-LOD 的降采样次数（相对 LOD0）；0 = 不生成
    std::string road = "mingxingroad"; // dataset id 前缀（原硬编码）
    int  utmZone = 51;         // GPS UTM 分带（原硬编码）
    bool utmNorth = true;      // GPS UTM 北半球（原硬编码）
};

static bool ParseVec3(const std::string& s, int& a, int& b, int& c) {
    int vals[3] = {0, 0, 0};
    int n = 0;
    size_t pos = 0;
    while (pos < s.size() && n < 3) {
        size_t comma = s.find(',', pos);
        std::string tok = (comma == std::string::npos) ? s.substr(pos) : s.substr(pos, comma - pos);
        if (tok.empty()) return false;
        vals[n++] = std::atoi(tok.c_str());
        if (comma == std::string::npos) break;
        pos = comma + 1;
    }
    if (n != 3) return false;
    a = vals[0];
    b = vals[1];
    c = vals[2];
    return true;
}

static void PrintHelp() {
    std::printf(
        "gpr2gvt — 国产阵列 GPR 数据处理 → GPR Volume Tile\n\n"
        "用法:\n"
        "  gpr2gvt --line <测线基名> [--out <目录>]\n"
        "         [--zero-mode max|channel] [--tile-size W,H,D] [--ghost N]\n"
        "         [--lod-scale X,Y,Z] [--levels N] [--zstd-level N] [--jobs N]\n"
        "         [--gps <.utmgps 路径>] [--slice-lod N]\n"
        "         [--road <前缀>] [--utm-zone N] [--utm-north 0|1]\n\n"
        "  --slice-lod N  生成切片专用 mean-LOD（从 LOD0 箱平均 N 次，级别号=levels；0=不生成）\n"
        "  --road S       dataset id 前缀（默认 mingxingroad）\n"
        "  --utm-zone N   GPS UTM 分带（默认 51）；--utm-north 0|1 南/北半球（默认 1=北）\n\n"
        "示例:\n"
        "  gpr2gvt --line \"data/mingxingroad/明星路_001\" --out dataset\n"
        "  gpr2gvt --line \"data/mingxingroad/明星路_001\" --gps \"data/mingxingroad/明星路_测试路段_rad.utmgps\"\n");
}

static bool ParseArgs(const std::vector<std::string>& args, CliArgs& a) {
    for (size_t i = 1; i < args.size(); ++i) {
        const std::string& arg = args[i];
        std::string key = arg, val;
        auto eq = arg.find('=');
        if (eq != std::string::npos) {
            key = arg.substr(0, eq);
            val = arg.substr(eq + 1);
        }
        auto needsVal = [&]() -> bool {
            if (val.empty() && i + 1 < args.size() && !args[i + 1].empty() && args[i + 1][0] != '-') {
                val = args[++i];
            }
            if (val.empty()) {
                std::fprintf(stderr, "缺少参数值: %s\n", key.c_str());
                return false;
            }
            return true;
        };

        if (key == "--line") {
            if (!needsVal()) return false;
            a.line = val;
        } else if (key == "--out") {
            if (!needsVal()) return false;
            a.out = val;
        } else if (key == "--zero-mode") {
            if (!needsVal()) return false;
            a.zeroMode = val;
        } else if (key == "--tile-size") {
            if (!needsVal()) return false;
            if (!ParseVec3(val, a.tileW, a.tileH, a.tileD)) return false;
        } else if (key == "--ghost") {
            if (!needsVal()) return false;
            a.ghost = std::atoi(val.c_str());
        } else if (key == "--lod-scale") {
            if (!needsVal()) return false;
            if (!ParseVec3(val, a.sx, a.sy, a.sz)) return false;
        } else if (key == "--levels") {
            if (!needsVal()) return false;
            a.levels = std::atoi(val.c_str());
        } else if (key == "--align") {
            if (!needsVal()) return false;
            a.align = val;
        } else if (key == "--zstd-level") {
            if (!needsVal()) return false;
            a.zstdLevel = std::atoi(val.c_str());
        } else if (key == "--jobs") {
            if (!needsVal()) return false;
            a.jobs = std::atoi(val.c_str());
        } else if (key == "--gps") {
            if (!needsVal()) return false;
            a.gps = val;
        } else if (key == "--slice-lod") {
            if (!needsVal()) return false;
            a.sliceLod = std::atoi(val.c_str());
        } else if (key == "--road") {
            if (!needsVal()) return false;
            a.road = val;
        } else if (key == "--utm-zone") {
            if (!needsVal()) return false;
            a.utmZone = std::atoi(val.c_str());
        } else if (key == "--utm-north") {
            if (!needsVal()) return false;
            a.utmNorth = (std::atoi(val.c_str()) != 0);
        } else if (key == "--help" || key == "-h") {
            PrintHelp();
            return false;
        } else {
            std::fprintf(stderr, "未知选项: %s\n", key.c_str());
            return false;
        }
    }
    if (a.line.empty()) {
        std::fprintf(stderr, "缺少 --line\n");
        PrintHelp();
        return false;
    }
    return true;
}

// ------------------------------------------------------------------ 通道枚举
// 枚举 "<base>_A<NN>.iprh"，按 NN 数值排序。返回完整 UTF-8 路径列表。
static std::vector<std::string> EnumerateChannels(const std::string& lineBaseUtf8) {
    fs::path base = fs::u8path(lineBaseUtf8);
    fs::path dir = base.parent_path();
    const std::string prefix = base.filename().u8string() + "_A";

    std::error_code ec;
    std::vector<std::pair<int, std::string>> found;
    if (!fs::is_directory(dir, ec)) {
        std::fprintf(stderr, "[error] 目录不存在: %s\n", dir.u8string().c_str());
        return {};
    }
    for (auto& entry : fs::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file()) continue;
        const std::string fn = entry.path().filename().u8string();
        if (fn.rfind(prefix, 0) != 0) continue;
        const std::string suffix = ".iprh";
        if (fn.size() <= prefix.size() + suffix.size()) continue;
        if (fn.compare(fn.size() - suffix.size(), suffix.size(), suffix) != 0) continue;
        const std::string numStr = fn.substr(prefix.size(), fn.size() - prefix.size() - suffix.size());
        int num = std::atoi(numStr.c_str());
        found.push_back({num, entry.path().u8string()});
    }
    std::sort(found.begin(), found.end());
    // 去重校验：atoi 会把 "A01"/"A1" 都解析成 1；重复通道号报错退出（否则静默丢通道）。
    for (size_t i = 1; i < found.size(); ++i) {
        if (found[i].first == found[i - 1].first) {
            std::fprintf(stderr, "[error] 重复通道号 A%02d: %s\n",
                         found[i].first, fs::u8path(found[i].second).filename().u8string().c_str());
            return {};
        }
    }
    std::vector<std::string> out;
    for (auto& p : found) out.push_back(p.second);
    return out;
}

// ------------------------------------------------------------------ UTM 轨迹
// .utmgps 每行: E1,N1,E2,N2,E3,N3,E4,N4,heading（道路横断面 4 角点）。
// 取 4 角质心作为中心线点。
static void ParseUtmTrack(const std::string& pathUtf8, GpsTrack& out) {
    out.utmPoints.clear();
    std::ifstream in(fs::u8path(pathUtf8));
    if (!in) return;
    std::string line;
    while (std::getline(in, line)) {
        double v[9] = {0};
        int n = std::sscanf(line.c_str(), "%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf",
                            &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7], &v[8]);
        if (n != 9) continue;
        const double e = (v[0] + v[2] + v[4] + v[6]) / 4.0;
        const double nor = (v[1] + v[3] + v[5] + v[7]) / 4.0;
        if (!(std::isfinite(e) && std::isfinite(nor))) continue; // 坏行（NaN/Inf）→ 跳过，防质心 NaN 污染 GPS
        out.utmPoints.push_back({e, nor});
    }
}

// ------------------------------------------------------------------ main
int main() {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);

    std::vector<std::string> args = GetUtf8Args();
    CliArgs a;
    if (!ParseArgs(args, a)) return 1;

    // 瓦片存储尺寸（core + 2*ghost）必须 < 65536：GvtHeader.width/height/depth 是 uint16_t，
    // 超限会静默溢出为 0 → 损坏瓦片。显式校验。
    if (a.tileW + 2 * a.ghost > 65535 ||
        a.tileH + 2 * a.ghost > 65535 ||
        a.tileD + 2 * a.ghost > 65535) {
        std::fprintf(stderr, "[error] 瓦片尺寸 + 2*ghost 超 uint16 上限（65535）：%d,%d,%d ghost=%d\n",
                     a.tileW, a.tileH, a.tileD, a.ghost);
        return 1;
    }

    const int nworkers = (a.jobs > 0) ? a.jobs
        : std::max(1, std::min((int)std::thread::hardware_concurrency(), 8));

    std::printf("=== gpr2gvt: 国产阵列 GPR -> .gvt 瓦片 ===\n");
    std::printf("测线基名 : %s\n", a.line.c_str());
    std::printf("输出目录 : %s\n", a.out.c_str());
    std::printf("瓦片尺寸 : %d,%d,%d  ghost=%d  lod-scale=%d,%d,%d  levels=%d  zstd=%d  jobs=%d\n",
                a.tileW, a.tileH, a.tileD, a.ghost, a.sx, a.sy, a.sz, a.levels, a.zstdLevel,
                nworkers);

    // 1. 枚举通道
    std::vector<std::string> channelFiles = EnumerateChannels(a.line);
    if (channelFiles.empty()) {
        std::fprintf(stderr, "[error] 未找到任何通道文件（应为 %s_A*.iprh）\n", a.line.c_str());
        return 1;
    }
    std::printf("发现 %d 个通道文件\n", (int)channelFiles.size());

    // 2. 解析 .ord（通道偏移，做交叉校验；跨轨偏移以 iprh CH_X_OFFSET 为准）
    fs::path linePath = fs::u8path(a.line);
    const std::string ordPath = linePath.parent_path().u8string() + "/" +
                                linePath.filename().u8string() + ".ord";
    std::vector<ChannelOffset> ord;
    if (ParseOrdFile(ordPath, ord)) {
        int valid = 0;
        for (auto& o : ord) if (o.valid) ++valid;
        std::printf(".ord 通道表: %d 行，有效 %d\n", (int)ord.size(), valid);
    } else {
        std::printf("[warn] 未找到/无法解析 .ord: %s\n", ordPath.c_str());
    }

    // 3. 逐通道解析头 + 读取数据
    std::vector<ChannelHeader> headers;
    std::vector<std::vector<int16_t>> datas;
    std::vector<double> xOffsets;
    int samplesCheck = -1;
    for (size_t i = 0; i < channelFiles.size(); ++i) {
        ChannelHeader h;
        if (!ParseIprhFile(channelFiles[i], h)) {
            std::fprintf(stderr, "[error] 解析头失败: %s\n", channelFiles[i].c_str());
            return 1;
        }
        if (samplesCheck < 0) samplesCheck = h.samples;
        if (h.samples != samplesCheck) {
            std::fprintf(stderr, "[error] 通道间 SAMPLES 不一致 (%d vs %d)\n", h.samples, samplesCheck);
            return 1;
        }
        std::string iprbPath = channelFiles[i].substr(0, channelFiles[i].size() - 5) + ".iprb";
        std::vector<int16_t> data;
        int64_t traces = 0;
        if (!ReadIprbFile(iprbPath, h.samples, traces, data)) {
            std::fprintf(stderr, "[error] 读取失败: %s\n", iprbPath.c_str());
            return 1;
        }
        std::printf("  通道 %d/%zu  A%02d samples=%d traces=%lld (头 LAST TRACE=%d)  x=%+.3f\n",
                    (int)i + 1, channelFiles.size(), (int)i + 1, h.samples,
                    (long long)traces, h.lastTrace, h.chXOffsetM);
        headers.push_back(h);
        datas.push_back(std::move(data));
        xOffsets.push_back(h.chXOffsetM);
    }

    // 4. 规则化（min/max 在放置循环内顺带统计）
    RegularizeOptions ropts;
    ropts.zeroMode = a.zeroMode;
    ropts.alignMode = a.align;
    Volume vol0;
    RegularizedMeta meta;
    int16_t gmin = 0, gmax = 0;
    Regularize(headers, datas, xOffsets, ropts, vol0, meta, gmin, gmax);
    datas.clear();          // 释放原始数据
    datas.shrink_to_fit();

    if (vol0.nx <= 0 || vol0.nz <= 0) {
        std::fprintf(stderr, "[error] 规则卷为空\n");
        return 1;
    }
    std::printf("\n规则卷 LOD0: %lld x %lld x %lld (%.1f MB)\n",
                (long long)vol0.nx, (long long)vol0.ny, (long long)vol0.nz,
                (double)vol0.Count() * 2 / 1048576.0);
    std::printf("深度映射: %.4f ns/采样, %.5f m/采样 (v=%.0f m/µs), 地面起点=采样%d, 深度=%.3f m\n",
                meta.sampleTimeNs, meta.depthPerSampleM, meta.soilVelocity,
                meta.commonZeroLevel, meta.depthPerSampleM * vol0.nz);
    std::printf("全局值域: %d .. %d\n", (int)gmin, (int)gmax);

    // 5. GPS 轨迹
    Metadata md;
    // datasetId 由 --line 基名派生：取 "_NNN" 数字后缀，前缀由 --road 指定。
    // 例如 明星路_002 → mingxingroad_002（与 dataset/lines/manifest.json 的 id 一致）。
    {
        const std::string base = fs::u8path(a.line).filename().u8string();
        std::string lineNum;
        if (auto pos = base.rfind('_'); pos != std::string::npos && pos + 1 < base.size())
            lineNum = base.substr(pos + 1);
        md.datasetId = a.road + "_" + (lineNum.empty() ? "line" : lineNum);
    }
    md.datasetName = fs::u8path(a.line).filename().u8string();
    // LOD0 体素尺寸：在 vol0 被 move 进 current 之前取值的拷贝（不再持有悬空指针）。
    md.lod0Nx = vol0.nx;
    md.lod0Ny = vol0.ny;
    md.lod0Nz = vol0.nz;
    md.spatial = meta;
    md.tileW = a.tileW;
    md.tileH = a.tileH;
    md.tileD = a.tileD;
    md.ghost = a.ghost;
    md.valueScale = 1.0;
    md.valueOffset = 0.0;
    md.globalMin = gmin;
    md.globalMax = gmax;
    // GPS 轨迹：优先 --gps 显式路径；否则由 --line 基名派生 "<base>.utmgps"。
    {
        std::string gpsPath = a.gps;
        if (gpsPath.empty()) {
            gpsPath = linePath.parent_path().u8string() + "/" +
                      linePath.filename().u8string() + ".utmgps";
            if (!fs::exists(fs::u8path(gpsPath)))
                std::fprintf(stderr, "[warn] 未找到 GPS 文件（可 --gps 指定）: %s\n", gpsPath.c_str());
        }
        ParseUtmTrack(gpsPath, md.gps);
        md.gps.utmZone = a.utmZone;
        md.gps.utmHemisphereN = a.utmNorth;
        std::printf("GPS 轨迹: %zu 点 (%s)\n", md.gps.utmPoints.size(), gpsPath.c_str());
    }

    // 6. LOD 分层分块写出（并行：构建瓦片 + 压缩 + 写盘）
    // 通用「写一个 level 的全部瓦片」：并行 BuildTile → WriteGvtFile。
    // 返回压缩字节数；失败返回 -1（outTiles 回传瓦片数）。
    auto writeLevel = [&](const Volume& vol, int level, int64_t& outTiles) -> int64_t {
        const TileGrid grid = MakeTileGrid(vol, a.tileW, a.tileH, a.tileD, a.ghost);
        outTiles = grid.Count();

        // 串行预创建全部瓦片父目录（消除写盘阶段目录并发竞态）
        {
            std::error_code ec;
            for (int64_t tz = 0; tz < grid.ntz && !ec; ++tz)
                for (int64_t ty = 0; ty < grid.nty && !ec; ++ty)
                    for (int64_t tx = 0; tx < grid.ntx && !ec; ++tx) {
                        const fs::path dir = fs::u8path(a.out) / "tiles" /
                                             std::to_string(level) /
                                             std::to_string(tx) / std::to_string(ty);
                        fs::create_directories(dir, ec);
                    }
            if (ec) {
                std::fprintf(stderr, "[error] 创建瓦片目录失败 L%d\n", level);
                return -1;
            }
        }

        std::atomic<int64_t> levelBytes{0};
        int failures = RunParallel(outTiles, nworkers, [&](int64_t i) -> bool {
            int tx, ty, tz;
            grid.Decode(i, tx, ty, tz);
            TileDesc tile;
            BuildTile(vol, level, tx, ty, tz, grid, tile);
            const int64_t n = WriteGvtFile(a.out, tile, a.zstdLevel);
            if (n < 0) return false;
            levelBytes += n;
            return true;
        });
        if (failures > 0) {
            std::fprintf(stderr, "[error] 写瓦片失败 L%d（%d 块）\n", level, failures);
            return -1;
        }
        return levelBytes.load();
    };

    int64_t totalBytes = 0;
    int64_t totalTiles = 0;

    // 切片专用 mean-LOD：从 LOD0 直接箱平均（不继承 max-abs 噪声）。
    // 必须在 vol0 被 move 进 current 之前算出；随后写成独立级别供 B-Scan/C-Scan 读取。
    Volume sliceVol;
    int sliceLevelIdx = -1;
    if (a.sliceLod > 0) {
        sliceLevelIdx = a.levels;   // 紧接 max-abs 链之后（如 levels=4 → 级别 4）
        int ssx = 1, ssy = 1, ssz = 1;
        for (int i = 0; i < a.sliceLod; ++i) { ssx *= a.sx; ssy *= a.sy; ssz *= a.sz; }
        std::printf("切片 mean-LOD: 从 LOD0 箱平均 %d×%d×%d → 级别 %d\n", ssx, ssy, ssz, sliceLevelIdx);
        sliceVol = DownsampleMean(vol0, ssx, ssy, ssz);
    }

    Volume current = std::move(vol0);
    int sxAcc = 1, syAcc = 1, szAcc = 1;

    for (int level = 0; level < a.levels; ++level) {
        int64_t nTiles = 0;
        const int64_t levelBytes = writeLevel(current, level, nTiles);
        if (levelBytes < 0) return 1;

        totalTiles += nTiles;
        totalBytes += levelBytes;
        std::printf("LOD%d: 尺寸=%lld,%lld,%lld  瓦片=%lld  压缩后=%.1f MB\n",
                    level, (long long)current.nx, (long long)current.ny,
                    (long long)current.nz, (long long)nTiles,
                    (double)levelBytes / 1048576.0);

        LevelInfo li;
        li.level = level;
        li.sx = sxAcc; li.sy = syAcc; li.sz = szAcc;
        li.nx = current.nx; li.ny = current.ny; li.nz = current.nz;
        li.spx = meta.xSpacingM * sxAcc;
        li.spy = meta.ySpacingM * syAcc;
        li.spz = meta.depthPerSampleM * szAcc;
        li.kernel = "maxabs";
        md.levels.push_back(li);

        if (level < a.levels - 1) {
            Volume next = DownsampleMaxAbs(current, a.sx, a.sy, a.sz);
            current = std::move(next);
            sxAcc *= a.sx;
            syAcc *= a.sy;
            szAcc *= a.sz;
        }
    }

    // 写切片 mean-LOD 瓦片（级别号 = sliceLevelIdx）
    if (a.sliceLod > 0) {
        int64_t nTiles = 0;
        const int64_t bytes = writeLevel(sliceVol, sliceLevelIdx, nTiles);
        if (bytes < 0) return 1;
        totalTiles += nTiles;
        totalBytes += bytes;

        LevelInfo li;
        li.level = sliceLevelIdx;
        int ssx = 1, ssy = 1, ssz = 1;
        for (int i = 0; i < a.sliceLod; ++i) { ssx *= a.sx; ssy *= a.sy; ssz *= a.sz; }
        li.sx = ssx; li.sy = ssy; li.sz = ssz;
        li.nx = sliceVol.nx; li.ny = sliceVol.ny; li.nz = sliceVol.nz;
        li.spx = meta.xSpacingM * ssx;
        li.spy = meta.ySpacingM * ssy;
        li.spz = meta.depthPerSampleM * ssz;
        li.kernel = "mean";
        md.sliceLevel = li;
        md.hasSliceLevel = true;
        std::printf("sliceLevel LOD%d(mean): 尺寸=%lld,%lld,%lld  瓦片=%lld  压缩后=%.1f MB\n",
                    sliceLevelIdx, (long long)sliceVol.nx, (long long)sliceVol.ny,
                    (long long)sliceVol.nz, (long long)nTiles, (double)bytes / 1048576.0);
    }

    // 7. metadata.json
    if (!WriteMetadataFile(a.out, md)) {
        std::fprintf(stderr, "[error] 写 metadata.json 失败\n");
        return 1;
    }

    std::printf("\n完成: %lld 瓦片, %.1f MB, metadata.json 已写\n",
                (long long)totalTiles, (double)totalBytes / 1048576.0);
    return 0;
}
