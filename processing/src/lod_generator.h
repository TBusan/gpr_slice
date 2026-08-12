#pragma once

#include "volume.h"

namespace gvt {

// Max-Abs 降采样（规格书 §11）：保留块内 |值| 最大的体素，避免正负抵消。
// 输出尺寸 = ceil(src/sx, src/sy, src/sz)，边界块对现存体素聚合。
Volume DownsampleMaxAbs(const Volume& src, int sx, int sy, int sz);

// Mean 降采样（块内算术平均，四舍五入）：用于切片专用平滑 LOD（sliceLevel）。
// Max-Abs 保留 3D 反射体但把高频噪声固化进粗级；切片显示需要均值抑制噪声，
// 故另出一路 mean 链供 B-Scan/C-Scan 读取，3D 仍走 max-abs 链。
Volume DownsampleMean(const Volume& src, int sx, int sy, int sz);

} // namespace gvt
