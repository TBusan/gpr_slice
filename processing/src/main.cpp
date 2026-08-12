// gpr2gvt —— 国产阵列 GPR (.iprh/.iprb/.ord) → GPR Volume Tile (.gvt) + metadata.json
//
// 用法：
//   gpr2gvt --line "data/mingxingroad/明星路_001" [--out dataset]
//          [--zero-mode max|channel] [--tile-size W,H,D] [--ghost 1]
//          [--lod-scale X,Y,Z] [--levels 4] [--zstd-level 5]
//
// Windows 中文路径：用 GetCommandLineW/CommandLineToArgvW 取宽字符 argv，
// 内部统一 UTF-8，文件系统边界用 std::filesystem::u8path 转换。

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "gvt_common.h"
#include "gvt_writer.h"
#include "iprh_parser.h"
#include "iprb_reader.h"
#include "lod_generator.h"
#include "metadata_writer.h"
#include "ord_parser.h"
#include "regularizer.h"
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
    int zstdLevel = 5;
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
        "         [--lod-scale X,Y,Z] [--levels N] [--zstd-level N]\n\n"
        "示例:\n"
        "  gpr2gvt --line \"data/mingxingroad/明星路_001\" --out dataset\n");
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

    std::printf("=== gpr2gvt: 国产阵列 GPR -> .gvt 瓦片 ===\n");
    std::printf("测线基名 : %s\n", a.line.c_str());
    std::printf("输出目录 : %s\n", a.out.c_str());
    std::printf("瓦片尺寸 : %d,%d,%d  ghost=%d  lod-scale=%d,%d,%d  levels=%d  zstd=%d\n",
                a.tileW, a.tileH, a.tileD, a.ghost, a.sx, a.sy, a.sz, a.levels, a.zstdLevel);

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

    // 4. 规则化
    RegularizeOptions ropts;
    ropts.zeroMode = a.zeroMode;
    ropts.alignMode = a.align;
    Volume vol0;
    RegularizedMeta meta;
    Regularize(headers, datas, xOffsets, ropts, vol0, meta);
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

    int16_t gmin = 0, gmax = 0;
    VolumeMinMax(vol0, gmin, gmax);
    std::printf("全局值域: %d .. %d\n", (int)gmin, (int)gmax);

    // 5. GPS 轨迹
    Metadata md;
    md.datasetId = "mingxingroad_001";
    md.datasetName = fs::u8path(a.line).filename().u8string();
    md.lod0 = &vol0;
    md.spatial = meta;
    md.tileW = a.tileW;
    md.tileH = a.tileH;
    md.tileD = a.tileD;
    md.ghost = a.ghost;
    md.valueScale = 1.0;
    md.valueOffset = 0.0;
    md.globalMin = gmin;
    md.globalMax = gmax;
    ParseUtmTrack(linePath.parent_path().u8string() + "/" + "明星路_测试路段_rad.utmgps", md.gps);

    // 6. LOD 分层分块写出
    int64_t totalBytes = 0;
    int64_t totalTiles = 0;
    Volume current = std::move(vol0);
    int sxAcc = 1, syAcc = 1, szAcc = 1;

    for (int level = 0; level < a.levels; ++level) {
        std::vector<TileDesc> tiles;
        BuildTiles(current, level, a.tileW, a.tileH, a.tileD, a.ghost, tiles);

        int64_t levelBytes = 0;
        for (auto& t : tiles) {
            const int64_t n = WriteGvtFile(a.out, t, a.zstdLevel);
            if (n < 0) {
                std::fprintf(stderr, "[error] 写瓦片失败 L%d (%d,%d,%d)\n",
                             level, t.tx, t.ty, t.tz);
                return 1;
            }
            levelBytes += n;
        }
        totalTiles += (int64_t)tiles.size();
        totalBytes += levelBytes;
        std::printf("LOD%d: 尺寸=%lld,%lld,%lld  瓦片=%zu  压缩后=%.1f MB\n",
                    level, (long long)current.nx, (long long)current.ny,
                    (long long)current.nz, tiles.size(), (double)levelBytes / 1048576.0);

        LevelInfo li;
        li.level = level;
        li.sx = sxAcc; li.sy = syAcc; li.sz = szAcc;
        li.nx = current.nx; li.ny = current.ny; li.nz = current.nz;
        li.spx = meta.xSpacingM * sxAcc;
        li.spy = meta.ySpacingM * syAcc;
        li.spz = meta.depthPerSampleM * szAcc;
        md.levels.push_back(li);

        if (level < a.levels - 1) {
            Volume next = DownsampleMaxAbs(current, a.sx, a.sy, a.sz);
            current = std::move(next);
            sxAcc *= a.sx;
            syAcc *= a.sy;
            szAcc *= a.sz;
        }
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
