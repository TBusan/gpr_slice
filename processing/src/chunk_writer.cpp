#include "chunk_writer.h"

#include <cstring>
#include <filesystem>
#include <fstream>

#include <zstd.h>

#include "gvt_common.h"

namespace gvt {

int64_t WriteChunkFile(const std::string& outDirUtf8, int level, int tz, int tx0,
                       const std::vector<TileDesc>& tiles, int zstdLevel) {
    namespace fs = std::filesystem;
    if (tiles.empty()) return -1;

    // 拼接：每个瓦片 x 最快 storeW*storeH*storeD，按 tx 递增顺序串联。
    size_t totalVoxels = 0;
    for (const auto& t : tiles) totalVoxels += (size_t)t.storeW * t.storeH * t.storeD;

    std::vector<int16_t> blob(totalVoxels);
    size_t off = 0;
    for (const auto& t : tiles) {
        const size_t n = (size_t)t.storeW * t.storeH * t.storeD;
        std::memcpy(blob.data() + off, t.data.data(), n * sizeof(int16_t));
        off += n;
    }

    const size_t srcBytes = totalVoxels * sizeof(int16_t);
    const size_t bound = ZSTD_compressBound(srcBytes);
    std::vector<uint8_t> cbuf(bound);
    const size_t csize = ZSTD_compress(cbuf.data(), bound, blob.data(), srcBytes, zstdLevel);
    if (ZSTD_isError(csize)) return -1;

    ChunkHeader h;
    std::memset(&h, 0, sizeof(h));
    std::memcpy(h.magic, "GPRC", 4);
    h.version    = kChunkVersion;
    h.level      = (uint16_t)level;
    h.chunkZ     = tz;
    h.chunkX0    = tx0;
    h.count      = (uint16_t)tiles.size();
    h.dataOffset = (uint32_t)(sizeof(ChunkHeader) + tiles.size() * sizeof(ChunkEntry));

    fs::path chunkPath = fs::u8path(outDirUtf8) / "tiles" / std::to_string(level) /
                         ("z" + std::to_string(tz)) /
                         ("x" + std::to_string(tx0) + ".gvtc");

    std::ofstream out(chunkPath, std::ios::binary | std::ios::trunc);
    if (!out) return -1;
    out.write(reinterpret_cast<const char*>(&h), sizeof(h));
    for (const auto& t : tiles) {
        ChunkEntry e;
        std::memset(&e, 0, sizeof(e));
        e.tx = t.tx; e.ty = t.ty; e.tz = t.tz;
        e.coreW = (uint16_t)t.coreW;
        e.coreH = (uint16_t)t.coreH;
        e.coreD = (uint16_t)t.coreD;
        out.write(reinterpret_cast<const char*>(&e), sizeof(e));
    }
    out.write(reinterpret_cast<const char*>(cbuf.data()), (std::streamsize)csize);
    if (!out) return -1;
    return (int64_t)(sizeof(h) + tiles.size() * sizeof(ChunkEntry) + csize);
}

} // namespace gvt
