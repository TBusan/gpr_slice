#include "gvt_writer.h"

#include <cstring>
#include <filesystem>
#include <fstream>
#include <vector>

#include <zstd.h>

#include "gvt_common.h"

namespace gvt {

int64_t WriteGvtFile(const std::string& outDirUtf8, const TileDesc& tile, int zstdLevel) {
    namespace fs = std::filesystem;
    fs::path tilePath = fs::u8path(outDirUtf8) / "tiles" / std::to_string(tile.level) /
                        std::to_string(tile.tx) / std::to_string(tile.ty) /
                        (std::to_string(tile.tz) + ".gvt");

    // 目录由并行管线在分发前串行预创建，此处不再 create_directories，
    // 避免多线程并发建目录在 Windows 上的 filesystem_error 竞态。

    const size_t srcBytes = (size_t)tile.data.size() * sizeof(int16_t);
    const size_t bound = ZSTD_compressBound(srcBytes);
    std::vector<uint8_t> cbuf(bound);
    const size_t csize = ZSTD_compress(cbuf.data(), bound, tile.data.data(), srcBytes, zstdLevel);
    if (ZSTD_isError(csize)) return -1;

    GvtHeader h;
    std::memset(&h, 0, sizeof(h));
    std::memcpy(h.magic, "GPRV", 4);
    h.version      = kVersion;
    h.flags        = 0;
    h.level        = (uint16_t)tile.level;
    h.reserved     = 0;
    h.x            = tile.tx;
    h.y            = tile.ty;
    h.z            = tile.tz;
    h.width        = (uint16_t)tile.storeW;
    h.height       = (uint16_t)tile.storeH;
    h.depth        = (uint16_t)tile.storeD;
    h.dataType     = (uint8_t)kInt16;
    h.compression  = (uint8_t)kCompressionZstd;
    h.dataOffset   = kDataOffset;
    h.dataLength   = (uint32_t)csize;

    GvtStats st;
    st.min  = tile.minV;
    st.max  = tile.maxV;
    st.mean = tile.meanV;

    std::ofstream out(tilePath, std::ios::binary | std::ios::trunc);
    if (!out) return -1;
    out.write(reinterpret_cast<const char*>(&h), sizeof(h));
    out.write(reinterpret_cast<const char*>(&st), sizeof(st));
    out.write(reinterpret_cast<const char*>(cbuf.data()), (std::streamsize)csize);
    if (!out) return -1;
    return (int64_t)(sizeof(h) + sizeof(st) + csize);
}

} // namespace gvt
