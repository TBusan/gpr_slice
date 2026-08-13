# GPR 查看器前后端审查 + 全量修复实施计划

## Context

用户要求对 `web/`（Three.js 前端）与 `processing/`（C++ 数据管线）做头脑风暴式审查，聚焦**数据处理 / 数据显示效果 / 前端帧率**，并已选择**全部实施**审查发现的修复项。

审查共发现约 16 个问题，分四档实施。以下为各修复的落地设计（所有改动保持行为兼容，除 F1 外无 UI 变化）。

---

## P0 批次 —— 正确性快赢（低风险，改动 <20 行/项）

### P0-1. D1：`syncStyle` 跳过无父 mesh → 重新入场景后样式陈旧
**文件**：`web/src/render/volumeScene.js:531-534`
**问题**：`if (!mesh.parent) continue;` 导致样式变化时不在场景的 mesh 永远拿不到新 uniform；重入场景后指纹已更新，不再补写 → 该 mesh 用旧样式渲染直到下一次样式变化。
**修复**：删除 `if (!mesh.parent) continue;` 一行，让 `styleChanged` 时对**全部** mesh（含 parentless）写 uniform（开销已被指纹门控覆盖，仅样式真正变化时发生）。更新 532 行注释说明原因。

### P0-2. D2：brickRenderer 死代码 `stepsFor` 最高 320 步 → 潜伏 GPU 粘滞卡死
**文件**：`web/src/render/brickRenderer.js:120-123,176`
**问题**：`stepsFor(coreSize)` 返回 64~320，仅 `opts.steps == null` 时用；`volumeScene` 恒传 16 故不可达，但任何新调用路径漏传即触发 update4.md 记录的粘滞 1Hz 卡死。
**修复**：删除 `stepsFor` 函数，`uSteps` uniform 改为 `opts.steps ?? 16`（模块级 `const DEFAULT_STEPS = 16`），注释标注「与 volumeScene.stepsFor 保持一致，勿改回自适应」。

### P0-3. P1：tileLoader 压缩区无边界检查
**文件**：`web/src/dataset/tileLoader.js:94`
**修复**：`buf.slice` 前加 `if (header.dataOffset + header.dataLength > buf.byteLength) throw new Error('gvt truncated: ...')`（主线程回退路径 `new Uint8Array(buf, ...)` 同样被此检查覆盖）。

### P0-4. F4：共享缓存「只增不减」→ 弱核显 OOM
**文件**：`web/src/render/multiLineHost.js:137-141` + `web/src/lod/tileCache.js`
**问题**：放大后 `cache.limit` 涨到 CACHE_CAP≈4096（≈2.3GB VRAM）永不回落。
**修复**：`tick()` 里加缩容（带迟滞）：
```js
if (totalDesired > this.cache.limit && totalDesired < CACHE_CAP) {
  this.cache.limit = totalDesired + 64;
} else if (this.cache.limit > CACHE_LIMIT && totalDesired < this.cache.limit * 0.6) {
  this.cache.limit = Math.max(CACHE_LIMIT, totalDesired + 64);
  this.cache.trim(); // 立即淘汰超限（onEvict 会 dispose + 移出场景）
}
```
注意 `tileCache.trim()` 只在 `set()` 时触发，降低 limit 后须手动调用。

---

## P1 批次 —— 帧率主菜

### P1-1. F1：切片滑块拖动「重建风暴」
**文件**：`web/src/render/sliceView.js`
**问题**：`input` 事件每帧置 `_dirty`（305-314）；`update()` 每帧 `_rebuildB` + `_rebuildC*` + 两个 canvas 渲染（336-348），无节流。拖深度滑块也重建 B-Scan（不随深度变化）、拖通道滑块也重建 C-Scan（不随通道变化）。
**修复**：
1. `_dirty` 拆成 `_dirtyB` / `_dirtyC`（构造器 107 行处初始化）：
   - `chanSlider` input（305-309）→ `_dirtyB = true`
   - `depthSlider` input（310-314）→ `_dirtyC = true`
   - `setSelected`（141）→ 两者都置（换线后 B 用新线通道、C 用新线深度）
   - `setVisible`（155）→ 仅 `_dirtyC`（只影响合成 C）
   - `setCscanMode`（162）→ 仅 `_dirtyC`
   - `setSource`（174）→ 两者都置
2. `update()`（326-352）重建/渲染拆分 + 100ms 节流（**dirty 强制重建会被 `canRebuild` 挡住**，拖动期间 ≤10Hz 重建）：
```js
if (!this._dirtyB && !this._dirtyC && !tilesChanged && !styleChanged) return;
const now = performance.now();
const canRebuild = now - this._lastRebuildAt > 100;
const rebuildB = canRebuild && (this._dirtyB || tilesChanged);
const rebuildC = canRebuild && (this._dirtyC || tilesChanged);
if (rebuildB) this._rebuildB();
if (rebuildC) {
  if (this.cscanMode === 'composite') this._rebuildCComposite();
  else this._rebuildCSingle();
}
if (rebuildB || rebuildC) this._lastRebuildAt = now;
if (styleChanged || rebuildB) this._renderCanvas(this.bCanvas, this.bCtx, this.gridB, this.gridX, this.gridZ);
if (styleChanged || rebuildC) {
  if (this.cscanMode === 'composite')
    this._renderCanvas(this.cCanvas, this.cCtx, this.gridComp, this.compGridX, this.compGridY);
  else
    this._renderCanvas(this.cCanvas, this.cCtx, this.gridC, this.gridX, this.gridY);
}
this._lastVersion = this._version;
this._styleKeyCache = styleKey;
this._dirtyB = this._dirtyC = false;
```
   注意渲染条件用 `rebuildX` 而非 `dirtyX`：节流窗口内 grid 是上次重建值，不重渲染（省 ~10ms/帧），重建后才渲染新值。
3. 滑块加 `change`（松手）监听：置对应 dirty + `this._lastRebuildAt = 0`，强制下一次 update 立即重建，保证拖到中间值松手后终值正确。

### P1-2. F2：半精度转换进 Web Worker
**文件**：`web/src/dataset/zstd.worker.js`、`web/src/dataset/tileLoader.js`、`web/src/render/brickRenderer.js`、`web/src/render/volumeScene.js` + **新建 `web/src/dataset/f16.js`**
**问题**：每瓦片 ~30 万值 `toHalfFloatArray`（brickRenderer.js:134，主线程）同步执行；limiter 并发 9 时一次缩放造成主线程长任务卡顿。
**修复**：
1. **新建 `web/src/dataset/f16.js`**：导出 `toHalf(value)`（float32→float16 位模式，纯函数、零依赖，与 `THREE.DataUtils.toHalfFloat` 等价的 Dario Manesku 位操作算法）+ `toHalfArray(f32)` + `i16ToHalfArray(i16, n, scale, offset)`（直接 int16→half，省中间 f32 分配）。
2. **`zstd.worker.js`**：`onmessage` 接收 `wantHalf`；为真时跳过 f32 数组，`for (i) half[i] = toHalf(i16[i] * scale + offset)`，`postMessage({ id, half: half.buffer }, [half.buffer])`；为假走现有 f32 路径。
3. **`tileLoader.js`**：`loadTile` 增加 `half = false` 选项。worker 路径 `decodeInWorker(comp, n, scale, offset, half)`；`half` 时返回 `{ header, half: new Uint16Array(msg.half), coreSize }`，否则返回现有 `{ header, f32, coreSize }`。主线程回退路径（worker 不可用）当 `half` 时用 `f16.js` 的 `i16ToHalfArray`。slice 调用不加 `half`（继续要 f32，CPU stamp 需要）。
4. **`volumeScene.js:627`**：`loadTile(url, { ghost, scale: 1, offset: 0, half: true })`。
5. **`brickRenderer.js:134`**：`const half = tile.half || toHalfFloatArray(tile.f32);`（`tile.half` 缺失时 f32 必存在，回退安全）。`toHalfFloatArray` 保留作回退。

---

## P2 批次 —— 每帧 GC 优化

### P2-1. F3：LOD 每帧字符串/数组洪峰
**文件**：`web/src/render/volumeScene.js`
**问题**：`_inFrustum`（248-254）每 mesh 每帧 `key.split('/')` + idx 模板串；`_ancestorsOf`（257-266）每帧对 desired/toRemove 反复 split + 新建数组（step 3/4/5/6 共 5 处调用）。
**修复**：
1. `createMesh`（648-664）末尾缓存：
   ```js
   const [L, x, y, z] = key.split('/').map(Number);
   mesh.userData.parts = [L, x, y, z];
   mesh.userData.tileRef = this.tilesByLevel.get(L)?.idx.get(`${x}/${y}/${z}`) || null;
   ```
2. `_inFrustum(key)` → `_inFrustum(mesh)`（248-254），只读 userData，零字符串：
   ```js
   _inFrustum(mesh) {
     const t = mesh.userData.tileRef;
     if (!t) return true;
     return this._frustumTest(t.box);
   }
   ```
   步骤 4（417 行）调用点改传 `mesh`。
3. `_ancestorsOf(key)` 记忆化：构造器加 `this._ancCache = new Map()`；函数首行查缓存，未命中才 split/计算并缓存（瓦片空间有界，无需清理）。
4. `computeDesired`（284-320）的 `desired` Set 模板串洪峰**保留不动**（Set 语义所需，收益低风险高，列入 backlog）。

---

## P3 批次 —— 后端健壮性

### P3-1. P2：硬编码 `mingxingroad_` dataset-id 前缀
**文件**：`processing/src/main.cpp:332` + `CliArgs`
**修复**：`CliArgs` 加 `std::string road = "mingxingroad";`，CLI 加 `--road <name>`；`md.datasetId = a.road + "_" + (lineNum.empty() ? "line" : lineNum);`。

### P3-2. P3：硬编码 UTM zone 51/N
**文件**：`processing/src/main.cpp` + `metadata_writer.h:22-23`
**修复**：`CliArgs` 加 `int utmZone = 51; bool utmNorth = true;`，CLI 加 `--utm-zone <N>` / `--utm-north <0|1>`；ParseArgs 后赋给 `md.gps.utmZone`/`md.gps.utmHemisphereN`。

### P3-3. P4：全局 min/max 被零填充污染
**文件**：`processing/src/regularizer.cpp:54-70`
**修复**：放置循环里只对**真实采样**更新 `mn/mx`（`val` 来自 `src` 时），padding 零不计入统计。

### P3-4. P5：`md.lod0` 指针在 move 之后使用
**文件**：`processing/src/metadata_writer.h:29`、`metadata_writer.cpp:27`、`main.cpp:335`
**问题**：`md.lod0 = &vol0`（main.cpp:335）→ `Volume current = std::move(vol0)`（415）→ 末行 `WriteMetadataFile`（475）读 `meta.lod0->nx/ny/nz`（metadata_writer.cpp:27）。moved-from 卷的标量成员靠隐式 move 残留才"偶然"正确。
**修复**：`Metadata`（metadata_writer.h:29）去掉 `Volume* lod0`，改为 `int64_t lod0Nx = 0, lod0Ny = 0, lod0Nz = 0;`；main.cpp:335 改赋 `md.lod0Nx = vol0.nx; md.lod0Ny = vol0.ny; md.lod0Nz = vol0.nz;`（在 move 之前，值语义拷贝）；metadata_writer.cpp:27 用 `meta.lod0Nx/lod0Ny/lod0Nz`。

### P3-5. P6：瓦片 store 尺寸 uint16_t 溢出
**文件**：`processing/src/main.cpp`（ParseArgs 之后、写瓦片之前）+ `gvt_common.h`（已确认 `GvtHeader.width/height/depth` 为 `uint16_t`，gvt_common.h:41-43）
**修复**：main() 里 ParseArgs 后校验 `a.tileW + 2*a.ghost > 65535`（tileH/tileD 同），超限报错退出（当前 `--tile-size 65534,...` 静默溢出为 0）。

### P3-6. P7 小项
- **EnumerateChannels 去重**（`main.cpp:182-208`）：`atoi` 后按 `num` 排序；相邻重复 `num` 报错（如 `A01`/`A1` 同解析为 1）。
- **ParseUtmTrack NaN 校验**（`main.cpp:213-227`）：`sscanf` 得 9 值后 `const double e = (v[0]+v[2]+v[4]+v[6])/4`；加 `if (!(std::isfinite(e) && std::isfinite(nor))) continue;`（坏行如 NaN → 质心 NaN → GPS 地图断裂）。
- **通道元数据一致性**（`regularizer.cpp:83-84`）：遍历 headers 校验 `timeWindowNs`/`soilVelocity` 全通道一致，不一致 `fprintf(stderr, warn)`（仍用 headers[0]，行为不变）。
- **删死代码 `VolumeMinMax`**（`volume.h:31`、`volume.cpp:7-19`，已 grep 确认无调用方）。

---

## 不做（记录为后续 backlog）

- **F3 更深层**：`computeDesired` 内模板字符串 key 洪峰（Set 语义所需，ping-pong 复杂度高收益低）。
- **F5**：`drainQueue` 每帧排序（小）。
- **D3 tFarZ 斜视回归**：无代码改动，需浏览器实测确认 update6.md 2b 修复无亮带副作用 —— 列入验证清单。
- **D4**：B/C-Scan 箱平均已实现，仅回归确认。

## 关键文件清单
- `web/src/render/volumeScene.js` — P0-1、P2-1、F2（loadTile 调用）
- `web/src/render/brickRenderer.js` — P0-2、F2（half 消费）
- `web/src/render/sliceView.js` — P1-1
- `web/src/render/multiLineHost.js` — P0-4
- `web/src/lod/tileCache.js` — P0-4（`trim()` 调用）
- `web/src/dataset/tileLoader.js` — P0-3、F2
- `web/src/dataset/zstd.worker.js` — F2
- `web/src/dataset/f16.js` — **新建**：`toHalf`/`toHalfArray`/`i16ToHalfArray`（F2 共享）
- `processing/src/main.cpp` — P3-1/2/4/5/6
- `processing/src/regularizer.cpp` — P3-3/6
- `processing/src/metadata_writer.{h,cpp}` — P3-2/4
- `processing/src/volume.{h,cpp}` — P3-6
- `processing/src/gvt_common.h` — （已确认 uint16 限制）

## 实施顺序
1. P0 批次（独立小改，先做）
2. P1-2 F2（worker + loader + brickRenderer，全链路受益）
3. P1-1 F1（sliceView 重建拆分）
4. P2-1 F3（GC 优化）
5. P3 批次（C++，需重新编译 + 生成单线 dataset 验证）

## 验证

### 前端
1. `cd web && npm run dev` → `http://localhost:5177/`，12 线加载。
2. **F1**：拖深度滑块 —— 主线程无长任务（Performance 面板）；HUD 帧率不掉；B-Scan 不再随深度重建。拖通道滑块 —— C-Scan 不再重建。松手后最终状态正确。
3. **F2**：放大触发瓦片爆发 —— Performance 面板确认 half 转换在 Worker 线程（主线程无 30 万次循环长任务）；切片视图（CPU f32 路径）不回归。
4. **P0-1**：切色带后旋转视角让瓦片经视锥外→内，确认无陈旧样式瓦片。
5. **P0-2**：单线回退路径（无 manifest）正常渲染，无 320 步回退。
6. **P0-4**：fit-all → 放大 → 回 fit-all，HUD cache 数值回落到 ~1100（修复前钉在放大峰值）。
7. **P0-3**：人工截断一个 .gvt → 干净报错而非静默错数据。
8. **回归**：样式面板全参数（min/max/gain/gamma/threshold/opacity/色带）在 3D 与 B/C-Scan 即时生效；LOD 交叉淡入淡出无黑洞/闪烁；`window.__scene/__slice/__gps` 钩子可用。

### D3 回归（无代码改动）
- viewCube 俯视图 fit-all + 中等缩放 → 拼接痕迹/暗线明显减少；**斜视 45°/侧视**检查 tile X 边界无新亮带（update6.md 第 5 步）。

### 后端
1. 重新编译 `processing/build/gpr2gvt.exe`（cmake --build）。
2. 单线重生成（`--line "data/mingxingroad/明星路_001" --out dataset_test`）：
   - metadata.json：`volume.dimensions` = 45307×14×781（P3-4 后仍正确）；`dataset.id` 默认仍 `mingxingroad_001`；zone 仍 51/N。
   - 瓦片数量/尺寸与旧输出一致；`globalMin/Max` 不变（max 模式无零填充，验证无回归）。
   - `--road testroad --utm-zone 50` → metadata 反映新值。
