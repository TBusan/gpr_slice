#include "iprb_reader.h"

#include <cstdio>
#include <filesystem>
#include <fstream>

namespace gvt {

bool ReadIprbFile(const std::string& pathUtf8, int samples, int64_t& outTraces,
                  std::vector<int16_t>& outData) {
    std::ifstream in(std::filesystem::u8path(pathUtf8), std::ios::binary);
    if (!in) return false;
    if (samples <= 0) return false;

    in.seekg(0, std::ios::end);
    std::streamoff size = in.tellg();
    in.seekg(0, std::ios::beg);
    if (size <= 0) return false;

    const int64_t bytesPerTrace = (int64_t)samples * 2;
    int64_t traces = (int64_t)size / bytesPerTrace;
    if (traces == 0) return false;
    if ((int64_t)size % bytesPerTrace != 0) {
        std::fprintf(stderr, "  [warn] %s 文件大小 %lld 不是完整 trace 倍数，截断到 %lld 道\n",
                     pathUtf8.c_str(), (long long)size, (long long)traces);
    }

    outTraces = traces;
    outData.resize((size_t)(traces * samples));
    if (outData.empty()) return true;

    const std::streamsize need = (std::streamsize)(traces * bytesPerTrace);
    in.read(reinterpret_cast<char*>(outData.data()), need);
    return in.gcount() == need;
}

} // namespace gvt
