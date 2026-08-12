# GPR 查看器优化计划（processing + web）— 修订版

## Context

用户要求全面复查 `processing/`（C++ 数据管线）与 `web/`（Three.js 前端），找出可优化点。重点约束：**processing 改动会改变（或要求重新生成）`dataset/` 中的数据**。

经排查，管线当前瓶颈：
- **单线程 zstd 压缩**：全数据集 4 级 LOD 约 1.3 GB 体素数据逐瓦片串行压缩写盘（估算 10–25 s），瓦片间完全独立，可并行。
- **分块阶段内存峰值 ~3.2 GB**：`main.cpp` 先存 14 通道原始数据（~1 GB）→ `regularizer.cpp` 建 vol0（~1 GB）→ `tiler.cpp` 的 `BuildTiles` **一次性**把整个 LOD 全部瓦片数据填入内存（LOD0 ≈ 1.24 GB）再逐个写盘。
- **热循环逐体素乘法索引**：`DownsampleMaxAbs`/`BuildTiles` 每体素算 `x + nx*(y + ny*z)`。
- **`VolumeMinMax` 独立全卷扫描**：500M 体素，可并入 Regularize。
- **zstd 级别 5**：网页下载 619 MB 偏大，可调高。
- **硬编码 GPS 文件名**：`main.cpp:316` 固定读 `明星路_测试路段_rad.utmgps`，与 `--line` 无关。

web 端：每帧重建 LOD 阈值 Map、`computeDesired` 每帧分配 Vector3、`syncStyle` 每帧更新全部 512 个缓存瓦片 uniform（实际只需场景中可见的）。

**用户已确认范围**：processing + web 都做；允许提高 zstd 级别并重新生成 dataset；给 processing 加多线程（std::thread，无新依赖）。

> 关键解耦事实：web 由 `metadata.json` 全自描述驱动，processing 改变 tile 尺寸/zstd/LOD 配置均**无需改 web**。`tileLoader.js` 硬编码 dataType=2(int16)/compression=2(zstd)，本次不改数据格式，保持不变。

---

## Part A — processing 优化（改完需重新生成 dataset）

### P1 并行「构建瓦片 + 压缩 + 写盘」（收益最大，且修正内存峰值）
- 文件：`processing/src/main.cpp`、`processing/src/tiler.{h,cpp}`、新增 `processing/src/thread_pool.h`。
- **拆 API**：把 `BuildTiles`（`tiler.cpp:8`）拆成
  - `TileGrid`：`{ ntx, nty, ntz, tileW, tileH, tileD, ghost }`（由卷尺寸一次算出）；
  - `void BuildTile(const Volume&, int level, int tx, int ty, int tz, const TileGrid&, TileDesc& out)`：只构建单个瓦片（核心区 AABB + ghost 填值 + min/max/mean 统计）。
- **主流程**：对每个 LOD 级：
  1. 计算 `TileGrid`；**串行**预创建全部父目录 `{out}/tiles/{level}/{tx}/{ty}/`（递归 create_directories，消除写盘阶段的目录竞态）。
  2. `std::atomic<size_t> next{0}` 分发 N 线程（`--jobs N`，默认 `min(hardware_concurrency, 8)`）；每线程循环 `idx = next.fetch_add(1)` → 由 idx 反解 `(tx,ty,tz)` → 本地 `TileDesc` → `BuildTile`（只读 vol，并发安全）→ `WriteGvtFile` → 局部量随函数退出释放。
  3. `std::atomic<int64_t>` 累加级别字节；`std::atomic<int>` 记录首个失败瓦片索引；join 后若失败打印并 `return 1`（保持现行为）。
- **改 `WriteGvtFile`**：删除其内部 `create_directories`（目录已预创建；它只被线程池调用）。
- 加 `--jobs N` CLI 参数（`CliArgs.jobs`）。
- **收益**：压缩从串行 ~10–25s → 8 线程 ~2–4s；瓦片缓冲从 ~1.24GB → jobs×单瓦片(<1MB)。语义不变（zstd 单发同级别确定，逐瓦片字节与单线程一致）。

### P2 流式读通道，降峰值内存（可选，收益已因 P1 减弱）
- 文件：`processing/src/main.cpp`、`processing/src/regularizer.{h,cpp}`。
- 现结构把 14 通道全部读入 `datas` 再 `Regularize`。给 `Regularize` 增加 loader 回调重载：`Regularize(..., loader)` 在按序 y 循环内逐通道读 `.iprb` → 放置 → 释放。
- **明确风险**：API 变更 + 读取失败需经返回值传播（`Regularize` 改返回 bool，失败中断）。P1 修正后峰值已降到 ~1.9GB（datas + vol0，无瓦片缓冲），本项只再省 ~900MB → **优先级下调，可不做**。

### P3 热循环指针步进（聚焦 tiler + downsample）
- 文件：`processing/src/tiler.cpp`、`processing/src/lod_generator.cpp`。
- `BuildTile`（见 P1）内层：每 `(sh,sd)` 先算 `wx` 行基址 `&vol.v[nx*(wy + ny*wz)]`，内层 sw 直接 `srcRow[wx]`（x 最内，src 连续）；`core` 统计从内层分支提出，改为对核心区 `[ghost,ghost+core)` 的独立连续扫描。
- `DownsampleMaxAbs`（`lod_generator.cpp:19`）：块内扫描用连续行指针步进，去掉 `src.At` 每访问乘算。
- **诚实预期**：`regularizer.cpp` 是转置写（z 内层 → dest 步进 `nx*ny`），缓存不友好是固有的；只合并 min/max（P4），**不强行重排循环**（收益有限、风险不成比例）。

### P4 全局 min/max 并入 Regularize
- 文件：`regularizer.{h,cpp}`、`main.cpp`。
- 在 Regularize 放置循环顺带累加 gmin/gmax，经输出参数带回；删 `main.cpp:298-300` 的 `VolumeMinMax` 调用。语义不变。

### P5 提高 zstd 默认级别（小收益，需重新生成）
- 文件：`processing/src/main.cpp`。`CliArgs.zstdLevel` 默认 `5 → 12`。
- **诚实预期**：对噪声 GPR int16 数据通常仅小 3–8%（619 → ~580MB）。解码值完全一致，仅瓦片字节变小；P1 并行抵消生成时间增加。

### P6 修 GPS 文件名硬编码
- 文件：`processing/src/main.cpp:316`。由 `--line` 基名派生 `.utmgps`，或新增 `--gps <路径>` 覆盖（默认回退基名）。修 `ParseUtmTrack` 行不足 9 列容错。

---

## Part B — web 优化（不影响 dataset）

### W1 缓存 LOD 阈值
- 文件：`web/src/render/volumeScene.js`。`tick()` 每帧 `buildThresholds`（新建 Map + tan）；缓存键 `(clientHeight, fov)`，仅变化时重算（fov 固定 45，实际只在 resize 时变化）。

### W2 复用临时向量，减少每帧 GC
- `computeDesired()`：`box.getCenter(new THREE.Vector3())` → 复用 `this._scratchV`。
- `viewCube.update()`：right/up/viewDir 三个 `new THREE.Vector3()` → 复用成员。
- `gpsMapView.pointAtFrac()`：返回 `[x,y]` 数组（每帧 65+ 次分配）→ 复用 `this._pt`。
- 渲染结果不变。

### W3 syncStyle 只同步场景内可见 mesh
- 文件：`web/src/render/volumeScene.js`。`syncStyle()` 现遍历 `this.meshes`（≤512）；改为遍历 `mesh.parent` 存在者。`tick()` 中 syncStyle 在场景增删之后调用，新入场景 mesh 当帧即同步；隐藏期间样式变化在重新入场景当帧补齐。

### W4 gpsMapView 按帧门控
- 文件：`web/src/render/gpsMapView.js`。相机 X 与 canvas 尺寸均不变时跳过重绘。

### 明确不做（避免引入风险）
- `volumeScene.tick()` fallback 判定的 O(meshes×desired) 扫描 → 空间索引重构风险高、当前瓦片数下收益有限。
- 前端 LOD 递归硬编码 `[2,1,2]` 细分（`volumeScene.js:160-167`）→ 正确性/健壮性问题而非性能，另立 issue。

---

## Part C — 重新生成 dataset（含备份）

1. **备份**：`mv dataset dataset.bak`（619MB，rename 不复制），供抽验对比；验证通过后再删。
2. **重建**：`cmake --build processing/build --target gpr2gvt`（已有 MinGW Makefiles / Release 配置）。
3. **运行**（cwd = 仓库根）：`processing/build/gpr2gvt.exe --line "data/mingxingroad/明星路_001" --out dataset`（约 5989 瓦片，zstd 12）。

---

## 验证

### A. 语义不变性（processing）
- 写临时对比脚本（复用 `web/_shots/decode.mjs` 的解析逻辑 + `web/node_modules/fzstd`）：随机抽样 `.gvt`（如 `0/0/0/0`、`3/0/0/0`、`3/22/0/3`），对 `dataset.bak` 与 `dataset` 各解压，断言 int16 序列**逐字节一致**（zstd 级别只影响压缩字节）。
- 对比 `metadata.json`：`levels[].dimensions`、`value.globalMin/Max`、`tile`、`spatial` 不变。

### B. 运行期
- `npm run dev`（端口 5177），打开页面：3D 体渲染、LOD 流式加载（L3 92 块常驻、切片无黑洞）、B/C-Scan 滑块、ViewCube 三视图、GPS 相机标记正常。
- Chrome DevTools Performance：帧内无 Map/Vector3 分配峰值；uniform 更新数 ≈ 可见 mesh 数。

### C. 性能记录
- 记录重新生成前/后耗时（P1 多核提速）与 dataset 总大小（P5 减小）；如实汇报测量值，不预测。

---

## 风险与缓解（头脑风暴产出）

1. **目录并发竞态**：`fs::create_directories` 并发调用在 Windows 可能抛 `filesystem_error` → P1 预创建 + 从 `WriteGvtFile` 移除该调用。
2. **dataset 覆盖**：已 gitignore，重生成覆盖工作数据 → 先 `mv dataset dataset.bak`。
3. **线程错误传播**：原子捕获首个失败并 join 后中断，保持「失败 return 1」。
4. **zstd 线程安全**：单发 `ZSTD_compress` 每次自带 ctx，安全；各线程写不同路径，无共享状态。
5. **P2 API 变更面大**：降为可选，默认不做；P1 修正后峰值 ~1.9GB 已可接受。

---

## 涉及文件汇总

- `processing/src/main.cpp`（P1 并行 + jobs、P2 可选接线、P4 删 VolumeMinMax、P5 zstd 默认、P6 GPS 路径）
- `processing/src/tiler.{h,cpp}`（P1 拆 `TileGrid`/`BuildTile`、P3 指针步进 + 统计独立扫描）
- `processing/src/lod_generator.cpp`（P3 指针步进）
- `processing/src/regularizer.{h,cpp}`（P4 min/max 合并；P2 可选 loader 回调）
- `processing/src/gvt_writer.cpp`（P1 移除 create_directories）
- `processing/src/thread_pool.h`（新增，P1）
- `web/src/render/volumeScene.js`（W1/W2/W3）
- `web/src/render/viewCube.js`（W2）
- `web/src/render/gpsMapView.js`（W2/W4）
