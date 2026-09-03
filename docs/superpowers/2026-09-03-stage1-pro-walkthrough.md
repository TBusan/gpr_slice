# Stage 1 Pro Walkthrough（2026-09-03）

把 GPR 三维体渲染查看器从「单测线 + B/C-Scan + GPS 轨迹」的小 demo 拉到「分层+测量+剖面+DXF 的接近专业工程工具」。

---

## 1. 范围（14 个 T 任务全部完成）

| T | 任务 | 关键产物 | Tests |
|---|---|---|---|
| 1 | vitest 基建 | `vitest.config.js` + 1 smoke | 1 |
| 2 | 钻孔 CSV 解析器 | `io/boreholeCsv.js`（ND/缺值/BOM/合并孔号） | 8 |
| 3 | 坐标配准 | `io/boreholeAlign.js` 相似变换 closed-form | 6 |
| 4 | 色带扩展 | `style.js` 7 种 + `legendPanel.js` | 0（视觉）|
| 5 | 图层管理 | `LayerManager` + `layerPanel` + `index.html` 侧栏 | 4 |
| 6 | 场景参照 | `sceneGizmos` grid/axes/NorthArrow + scale bar | 5 |
| 7 | 钻孔 L1 | `boreholeLayer` head+cylinder + CSV 拖入 | 5 |
| 8 | 剖面连线 | `sectionLinkLayer` top 配对 | 6 |
| 9 | 体素采样 | `volumeSampler` world→local→amplitude | 8 |
| 10 | 任意剖面 | `arbitrarySection` 重采样 + canvas 渲染 | 6 |
| 11 | 测量工具 | `measureTool` polylineLength + shoelace | 8 |
| 12 | 数据源 | `sources.json` + URL `?src=` + `layerStore` | 4 |
| 13 | DXF 预览 | `dxfLoader` + `dxfLayer` + 极简行扫描 | 12 |
| 14 | 收口 | `util/throttle` + 本文 | 2 |
| | **合计** | | **75** |

---

## 2. 体系结构（自下而上）

```
┌────────────────────────────────────────────────────────┐
│  data  dataset/  (C++ 处理产物 .f32/.json)             │
│        public/dataset/  (前端运行时)                   │
└──────────┬─────────────────────────────────────────────┘
           ↓
io/  解析器与坐标 (5 个)                    纯函数，可单测
  ├ boreholeCsv         CSV → Borehole[]
  ├ boreholeAlign       场地 → UTM 相似变换
  ├ volumeSampler       世界 → 局部 → 振幅
  ├ layerStore          localStorage 跨源
  └ dxfLoader           DXF → 线段数组
           ↓
layers/  LayerManager                     状态机
           ↓
render/  几何 + 面板 (8 个)
  ├ style / legendPanel    振幅色标
  ├ sceneGizmos            网格/三轴/指北针/比例尺
  ├ layerPanel             图层列表
  ├ boreholeLayer/Panel    钻孔柱状 + 列表
  ├ sectionLinkLayer       剖面连线
  ├ arbitrarySection       任意折线剖面
  ├ measureTool            测距/测面积
  ├ dxfLayer               DXF LineSegments
  ├ sliceView / gpsMapView / viewCube  已有
  └ ...
           ↓
util/  工具 (1 个)
  └ throttle / debounce
           ↓
main.js  boot() 装配 (单线/多线/数据源)
```

---

## 3. 关键设计决策

- **图层与数据源解耦**：`LayerManager` 只存 `id→{object3D, builtin, visible}`，与数据集、坐标、相机、样式都无关；切源时靠 `?src=` URL 重载避免 teardown 泄漏。
- **测量/采样几何下沉**：`measureTool`、`volumeSampler` 是纯函数；DOM/Three 包装在 main.js。便于单测和未来扩展（WebWorker 化）。
- **拖入文件入口统一**：`#dropHint` 监听整个 window，按后缀分派：`.csv` → `boreholeCsv` → 钻孔层；`.dxf` → 极简行扫描（ENTITIES 段 LINE 的 10/11/20/21/30/31 组码）→ LineSegments。
- **键盘语义**：1 任意剖面打点 / 2 测距 / 3 测面积 / Enter 完成 / Esc 取消。无 onboarding 弹窗（专业工具惯例）。
- **持久化粒度**：每数据源一份 `gpr_slice_layerStore_<srcId>`，仅记 builtin 可见性 + 相机位 + 配色（避免巨量 holeId 写入）。
- **NorthArrow 旋向**：`computeNorthDeg = atan2(crossVec[0], crossVec[1]) * 180/π`。`ref` 缺失/单线 fallback 时返回 0°（世界 +Y 即正北），不会崩溃。
- **borehole 颜色**：12 槽 stratum 调色板循环；`stratum` 缺/无效 → 灰色 (128,128,128)。

---

## 4. 用户可见的快捷键/操作

| 操作 | 触发 |
|---|---|
| 切换数据源 | 左侧「数据源」下拉 |
| 拖入 CSV | 拖到任意位置 → 自动 add 钻孔图层 + 刷新面板 |
| 拖入 DXF | 拖到任意位置 → 自动 add 线段图层 |
| 钻孔显隐/剖面 | 钻孔面板复选 / 剖面按钮（连点两次连两孔） |
| 任意剖面 | 1 进入 → 点地面打点 → Enter → 中央弹窗出图 |
| 测距 | 2 进入 → 点地面打点 → Enter → HUD 显示累计 |
| 测面积 | 3 进入 → ≥3 点 → Enter → HUD 显示面积 |
| 切视图 | 右下 viewCube 点击（前/俯/左） |
| 配色 | 右下 stylePanel 7 种色带 + 增益/伽马/不透明度 |

---

## 5. 后续路线（Stage 2 候选）

- **L2 插值地层**：用 borehole 层位做克里金/RBF，体素化后覆盖到任意 (x,y,z) 网格 → `volumeSampler` 直接读地层振幅。
- **L3 污染体素**：CSV 的 `ph`/污染物浓度场 → 体积染色。
- **DXF 实体扩展**：CIRCLE/ARC/HATCH/INSERT（块引用）→ 圆/弧线段化；插入点归零。
- **DWG 预览**（Stage 3）：cad-viewer 或 dxf-converter + WASM。
- **剖面高程曲线**：用 `volumeSampler` 沿任意 polyline 取振幅并画到 2D 图底叠加高程折线。
- **历史回放 / 时序**：当前 dataset 单时刻；后续加 manifest.timeIndex。
- **导出**：当前 DXF 仅预览；导出剖面图 PNG、钻孔 GeoJSON。
