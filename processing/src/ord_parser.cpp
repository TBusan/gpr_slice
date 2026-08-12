#include "ord_parser.h"

#include <filesystem>
#include <fstream>
#include <sstream>

namespace gvt {

bool ParseOrdFile(const std::string& pathUtf8, std::vector<ChannelOffset>& out) {
    std::ifstream in(std::filesystem::u8path(pathUtf8));
    if (!in) return false;

    out.clear();
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty()) continue;
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::istringstream ss(line);
        ChannelOffset o{};
        int valid = 0;
        if (!(ss >> o.channel >> o.xOffset >> o.yOffset >> valid)) continue;
        o.valid = (valid != 0);
        out.push_back(o);
    }
    return !out.empty();
}

} // namespace gvt
