# GPR 查看器：C-Scan 不显示 + LOD 切换体验与性能修复

## Context

用户报告 `web/` 三个问题：
1. **C-Scan 显示不出来**（多线默认走"全宽合成"模式）。
2. **缩放主视图切换 LOD 时**：瓦片加载很慢，且不同 LOD 瓦片显示/隐藏很生硬、无自然过渡。
3. **LOD 靠近相机（LOD 较细）时帧率很低**。

我已通读 `web/src`（全部 12 个文件）与 `processing/src`（13 个 C++ 文件），并核对了真实 dataset（`dataset/lines/*/metadata.json`、`manifest.json`、tile 目录）。所有三个问题根因都在 **web 端**；`processing` 端格式/布局正确（gvt header、x-fastest 体素布局、origin/channelOffsetsY/ghost 语义均与 web 一致），无需要修的 bug。

根因结论先行：

| # | 问题 | 根因 | 位置 |
|---|------|------|------|
| A | C-Scan 合成不显示 | `_syncSlabs()` 每帧重启 slab 加载，`slabGen` 递增使所有在途结果被丢弃 → slab 永不加载完成 → 合成网格全 NaN | `web/src/render/sliceView.js:203-234, 237-265` |
| B | LOD 切换生硬 + 缩放拉远时出现黑洞 | fallback 只考虑"细瓦片未加载→保留粗瓦片"，未考虑"粗瓦片未加载→应保留细瓦片"；且切换是单帧硬切、无交叉淡入淡出 | `web/src/render/volumeScene.js:287-321` |
| C | LOD 切换瓦片加载慢 | 每线 `MAX_IN_FLIGHT=6` × 12 线 = 72 并发请求，超出浏览器 ~6 连接/主机上限 → HTTP 排队；主线程 zstd 解压阻塞帧 | `web/src/render/volumeScene.js:25, 423-434` |
| D | 高 LOD 低帧率 | fallback 扫描 O(M×D) 每帧（细 LOD 时 M、D 各数百 → 每线数万次比较 ×12 线）；共享模式关闭视锥剔除 → 相机背后/视野外瓦片仍加载+光追；每帧分配/排序 | `web/src/render/volumeScene.js:287-321`、`web/src/render/multiLineHost.js:124-143` |

---

## 根因 A：C-Scan 全宽合成不显示（bug，最高优先级）

### 机制
多线默认 `cscanMode='composite'`。C-Scan 合成数据源是每条可见线在"当前深度"的 maxLevel 深度片（`line.slab`）。加载由 `_syncSlabs()` 驱动。

`sliceView.update()`（`sliceView.js:314`）每帧调用：
```js
if (this.cscanMode === 'composite') this._syncSlabs();
```
`_syncSlabs()`（`sliceView.js:203`）对每条线的门控是：
```js
if (line.slabZ === zTile && line.slab.size > 0) continue;
line.slabZ = zTile;
line.slabGen++;
line.slab.clear();
...this._loadKeys(line, line.slab, 'slabGen', keys);
```

关键时序：
1. 构造器 `_ensureFull()` 先开始加载**选定线整条 L4**（315 片），占满全局 6 个并发槽；`setCscanMode('composite')` 随后开始 12 线的 slab 加载（`_loadKeys` worker 在 `acquire()` 上排队）。
2. 任一 L4 瓦片落地 → `this._version > 0` → 此后 **每帧** `update()` 都执行 `_syncSlabs()`。
3. 只要 `line.slab.size === 0`（还在加载中），门控不满足 → `slabGen++` + `slab.clear()` + 重新 `_loadKeys`。旧的 in-flight 瓦片在 `_loadKeys` 里 `if (gen !== line[genName]) return;`（`sliceView.js:242,247,251`）全部被丢弃。
4. 由于每次 fetch 耗时 > 一帧（~16ms），没有任何 slab 瓦片能在"同一帧内完成并 store"——所以 `slab.size` 恒为 0，**每帧无限重启，slab 永不加载完成**。
5. `_rebuildCComposite()`（`sliceView.js:512`）遍历 `line.slab.size === 0` 的线直接跳过 → 合成网格 `gridComp` 全 NaN → `_renderCanvas` 渲染纯黑 → **C-Scan 黑屏**。

B-Scan 不受影响：`_ensureFull` 只在构造器/切线时调用一次，`fullGen` 稳定 → L4 瓦片正常落地。这解释了"只有 C-Scan 显示不出来"。

### 修复（`web/src/render/sliceView.js`）
1. 给每条线加 `line.slabLoading` 标志与 `line.slabLoadId` 令牌（构造器 `this.lines.forEach` 处初始化）。
2. 门控改为：`if (line.slabZ === zTile && (line.slab.size > 0 || line.slabLoading)) continue;`
3. 开始加载前 `const loadId = ++line.slabLoadId; line.slabLoading = true;`，`_loadKeys(...).then(() => { if (line.slabLoadId === loadId) line.slabLoading = false; });`
4. `_loadKeys` 改为 `return Promise.all(...)`（现在不返回，`.then` 拿不到）。
5. `setVisible(false)` 里顺带 `line.slabZ = -1; line.slabLoading = false;`，保证"隐藏→再显示"会重新加载（否则 gate 的 `slabZ===zTile && size===0` 因 loading=false 会每帧重启，回归原 bug）。

深度滑块变化仍触发重载：`zTile` 变 → gate 的 `slabZ===zTile` 为 false → 走重载分支。旧批次 worker 的 `.then` 由 `slabLoadId` 令牌保护，不会误清新批次的 `slabLoading`。

---

## 根因 B：LOD 切换生硬 + 拉远黑洞（bug）

### 机制
`volumeScene.tick()`（`volumeScene.js:287-307`）的 fallback 扫描只保留"有未加载的 **细** 后代"的非 desired 粗瓦片：
```js
for (const [dl, dx, dy, dz] of desiredParsed) {
  if (dl >= h.level) continue;          // 只检查比自己更细的 desired
  ...
  if (!this.loaded.has(kkey(dl, dx, dy, dz))) { need = true; break; }
}
```
- **放大**：粗瓦片保留到所有细后代加载完 → 最后一帧细瓦片一次性出现、粗瓦片同帧移除 → 硬切（无过渡）。放大期间粗瓦片"久等"慢的瓦片 → 感觉加载慢（叠加根因 C）。
- **拉远**：desired 变为粗瓦片，细瓦片不在 desired → `dl >= h.level` 全部跳过 → `need=false` → 细瓦片**立即移除**，而其粗祖先若已不在缓存（放大时被细瓦片挤出 LRU）→ 需重新 fetch → 出现**黑洞**，直到粗瓦片落地才突然弹出。这正是用户看到的"生硬"。

### 修复
1. **双向 fallback**：把非 desired 网格 M 的保留条件改成——存在一个与 M 区域重叠且**未加载**的 desired 瓦片 D，其中 M 是 D 的祖先 **或** 后代。实现改为 O((M+D)×levels)：
   - 对每个未加载的 desired 瓦片 D，向上走祖先，标记 `keepAnc[ancKey]=true`（放大 fallback）。
   - 对每个非 desired 网格 M，向上走祖先，若任一祖先 key 出现在 `desired` 且 `!loaded` → 保留 M（拉远 fallback）。
   - 其余未命中的非 desired 网格才移除。
   - 第二段"给 desired 加 mesh 时检查 hasAncestor"也改为向上走祖先查 `fallbackKeys` 集合（O(desired×levels) 替代 O(desired×fallbackKeys)）。
2. **交叉淡入淡出（150–250ms）**，消除硬切：
   - 网格增加 `mesh.userData.fade`（默认 1）；`syncStyle()`（`volumeScene.js:358`）里 `u.uOpacity.value = s.opacity * (mesh.userData.fade ?? 1)`。
   - 当某个粗瓦片从"fallback 保留"变为"全部细后代已加载、应移除"时，不直接 `group.remove`，而是启动淡出：记 `fading=true` + `fadeStart=now`，每帧在 `tick()` 更新 `fade` 至 0 后移除。被替换的细瓦片加入时 `fade` 从 0 淡入到 1。
   - `tick()` 的主循环跳过 `fading` 网格，避免重复增删。
3. **LOD 阈值滞回**（可选，防相机停在阈值附近时抖动/反复重载）：`computeDesired`（`volumeScene.js:209`）用两个阈值——细分用 `thresholds.get(L)`，合并回粗级用 `thresholds.get(L) * k`（k≈1.5），并记录每个 region 当前级别。

---

## 根因 C：LOD 切换瓦片加载慢（性能）

### 机制
- 每个 `VolumeScene` 独立 `MAX_IN_FLIGHT=6`（`volumeScene.js:25`），12 线可见时最多 **72 个并发 fetch**；浏览器对同一 origin 的并发连接上限 ~6 → 大部分请求在 HTTP 层排队，瓦片到达慢。
- 每次 fetch 完成后在主线程 `fzstd` 解压 ~0.5MB（`tileLoader.js:47`），12 线同时涌瓦片时主线程被解压占满 → 帧率骤降 + 加载变慢（叠加根因 D）。

### 修复
1. **全局并发上限**：新增模块级共享信号量（复用 sliceView 的 `acquire()/release()` 模式，`sliceView.js:24-37`），由 `MultiLineHost` 持有并通过 `shared.limiter` 传给各 `VolumeScene`；`loadTileAsync` 在 fetch 前 `await limiter.acquire()`，完成后 release。总预算 ~8–10（覆盖浏览器 ~6 连接 + 少量余量），self 模式用本地 limiter 保持行为不变。
2. **可选：Web Worker 解压**：把 `loadTile` 的 `decompress` 移到 Worker，避免阻塞主线程（改动较大，列为后续项）。

---

## 根因 D：高 LOD（相机贴近）时帧率低（性能）

### 机制
1. **O(M×D) fallback 扫描**（`volumeScene.js:287-307`）：每帧对每个非 desired 网格 × 全部 desired 做包含判断。高 LOD 时 M、D 各数百 → 每线数万次比较，12 线 ≈ 百万级/帧，纯 CPU 开销。`desiredParsed` 每帧 `map/split` 分配也产生 GC。
2. **共享模式关闭视锥剔除**（`volumeScene.js:262` 注释）：多线共享相机时瓦片 box 是局部坐标，与全局视锥比较会误剔除 → 直接全关。后果：相机背后的瓦片仍加载+光追渲染，高 LOD 时浪费巨大。
3. **`multiLineHost.tick()`**（`multiLineHost.js:124-143`）每帧对所有可见 mesh 做 `all.push({m,dsq})` 分配 + 全量排序（n log n）。
4. `syncStyle()` 每帧对每个可见 mesh 写 8 个 uniform。

### 修复
1. **fallback 扫描降为 O((M+D)×levels)**（见根因 B 的 1，一并解决）。
2. **共享模式启用视锥剔除**：`computeDesired` 用共享相机构建世界视锥，测试时把每个局部 box 转成世界 AABB（镜像线 x 方向取 min/max，y/z 直接平移，复用 `_scratchV` 不分配），`frustum.intersectsBox(worldAabb)`。
3. **`multiLineHost.tick()`**：仅当 mesh 集合变化（`version` 变化）时才重建+排序 `all`；或预分配数组。优先用"version 门控"。
4. **`syncStyle()` 用样式指纹门控**：样式不变时跳过 uniform 写入（样式变化极少）。
5. 可选：`stepsFor` 上限 192 → 128，且按"瓦片总步数预算"整体限流（复杂，列为后续）。

---

## 实施顺序（按风险/收益）

1. **修复 A（C-Scan）**：`sliceView.js` 的 slabLoading/slabLoadId + `_loadKeys` 返回 Promise。改动 ~25 行。
2. **修复 B（过渡）**：`volumeScene.js` 双向 fallback + 淡入淡出 + `syncStyle` 乘 fade。改动 ~120 行。
3. **修复 C（全局并发）**：共享 limiter。改动 ~40 行 + `main.js` 传递。
4. **修复 D（帧率）**：fallback O((M+D)×levels)（与 2 合并）、世界视锥剔除、`multiLineHost` version 门控、`syncStyle` 指纹。改动 ~80 行。

## 关键文件
- `web/src/render/sliceView.js` — A
- `web/src/render/volumeScene.js` — B/C/D（fallback、剔除、并发、fade）
- `web/src/render/multiLineHost.js` — C（共享 limiter）/D（排序门控）
- `web/src/main.js` — 传递 shared.limiter

`processing/` **无需改动**（格式/布局已核对一致）。

---

## 验证

1. **C-Scan**：`npm run dev` 打开，多线默认"全宽合成"：C-Scan 应立即显示（不是黑屏）；拖动深度滑块跨 zTile（≈2.5m/片）时按片重载；勾掉某线 → 该线从合成中消失；再勾回 → 恢复（不再黑屏）。B-Scan 不回归。
2. **过渡**：主视图持续放大→缩小：不再有黑洞（拉远时细瓦片保留到粗瓦片落地）；放大时粗→细有 ~200ms 淡入淡出，无硬切。HUD `meshes` 数在过渡期平滑变化。
3. **加载速度**：放大到细 LOD，观察 HUD `inFlight` ≤ 全局预算（~8–10），不再 72 并发；瓦片到达更快。
4. **帧率**：贴近高 LOD，HUD `fps` 明显提升；旋转相机使瓦片转到背后 → `meshes`/渲染量下降（剔除生效）。
5. **回归**：单线回退路径（删除/改名 `dataset/lines/manifest.json`）B-Scan/C-Scan 单线正常；`window.__scene/__slice/__gps` 调试钩子可用。
