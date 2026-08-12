#include "iprh_parser.h"

#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace gvt {

static std::string Trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && std::isspace((unsigned char)s[b])) ++b;
    while (e > b && std::isspace((unsigned char)s[e - 1])) --e;
    return s.substr(b, e - b);
}

std::string NormalizeKey(const std::string& s) {
    std::string out;
    bool lastSpace = true;
    for (unsigned char c : s) {
        if (std::isspace(c)) {
            if (!lastSpace) out.push_back(' ');
            lastSpace = true;
        } else {
            out.push_back((char)std::toupper(c));
            lastSpace = false;
        }
    }
    if (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

bool GetIprhInt(const ChannelHeader& h, const char* key, int& out) {
    auto it = h.raw.find(key);
    if (it == h.raw.end()) return false;
    try {
        out = std::stoi(it->second);
        return true;
    } catch (...) {
        return false;
    }
}

bool GetIprhDouble(const ChannelHeader& h, const char* key, double& out) {
    auto it = h.raw.find(key);
    if (it == h.raw.end()) return false;
    try {
        out = std::stod(it->second);
        return true;
    } catch (...) {
        return false;
    }
}

bool ParseIprhFile(const std::string& pathUtf8, ChannelHeader& out) {
    std::ifstream in(std::filesystem::u8path(pathUtf8), std::ios::binary);
    if (!in) return false;

    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        auto colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = NormalizeKey(Trim(line.substr(0, colon)));
        if (key.empty()) continue;
        std::string val = Trim(line.substr(colon + 1));
        if (val.empty()) continue;
        out.raw[key] = val;
    }
    if (out.raw.empty()) return false;

    int tmp;
    if (GetIprhInt(out, "CHANNELS", tmp)) out.channels = tmp;
    if (GetIprhInt(out, "SAMPLES", tmp)) out.samples = tmp;
    if (GetIprhInt(out, "LAST TRACE", tmp)) out.lastTrace = tmp;
    if (GetIprhInt(out, "ZERO LEVEL", tmp)) out.zeroLevel = tmp;
    if (GetIprhInt(out, "SIGNAL POSITION", tmp)) out.signalPosition = tmp;
    double d;
    if (GetIprhDouble(out, "FREQUENCY", d)) out.frequencyMHz = d;
    if (GetIprhDouble(out, "TIMEWINDOW", d)) out.timeWindowNs = d;
    if (GetIprhDouble(out, "DISTANCE INTERVAL", d)) out.distanceIntervalM = d;
    if (GetIprhDouble(out, "SOIL VELOCITY", d)) out.soilVelocity = d;
    if (GetIprhDouble(out, "CH_X_OFFSET", d)) out.chXOffsetM = d;
    return true;
}

} // namespace gvt
