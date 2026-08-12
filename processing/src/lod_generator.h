#pragma once

#include "volume.h"

namespace gvt {

// Max-Abs 降采样（规格书 §11）：保留块内 |值| 最大的体素，避免正负抵消。
// 输出尺寸 = ceil(src/sx, src/sy, src/sz)，边界块对现存体素聚合。
Volume DownsampleMaxAbs(const Volume& src, int sx, int sy, int sz);

} // namespace gvt
