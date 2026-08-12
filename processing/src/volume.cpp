#include "volume.h"

#include <climits>

namespace gvt {

void VolumeMinMax(const Volume& vol, int16_t& outMin, int16_t& outMax) {
    if (vol.v.empty()) {
        outMin = outMax = 0;
        return;
    }
    int mn = INT16_MAX, mx = INT16_MIN;
    for (int16_t val : vol.v) {
        if (val < mn) mn = val;
        if (val > mx) mx = val;
    }
    outMin = (int16_t)mn;
    outMax = (int16_t)mx;
}

} // namespace gvt
