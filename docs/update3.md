# GPR 查看器：C-Scan 不显示 + LOD 切换体验与性能修复（v2，含自审修正）

## Context

用户报告 `web/` 三个问题：
1. **C-Scan 显示不出来**（多线默认"全宽合成"模式）。
2. **缩放主视图切换 LOD 时**：瓦片加载很慢，且不同 LOD 瓦片显示/隐藏很生硬、无自然过渡。
3. **LOD 靠近相机（较细）时帧率很低**。

已通读 `web/src` 全部文件 + `processing/src`，并核对真实 dataset。**处理端无需改动**（gvt 格式、x-fastest 布局、origin/channelOffsetsY/ghost 语义均与 web 一致）。

用户拍板：**四类问题一次性全改**；**视锥剔除与 zstd 解压进 Web Worker 一起做**；LOD 过渡采用**交叉淡入淡出**。

## 根因与修复（自审后定稿）

### A. C-Scan 合成不显示 — 已端到端验证 ✅
`sliceView.update()`（`sliceView.js:315`）在 `_version > 0` 后每帧调用 `_syncSlabs`。其门控（line 221）`slab.size > 0` 在加载中恒不满足 → `slabGen++`（line 223）→ `_loadKeys` 的 gen 检查（line 242/247/251）作废所有在途结果 → slab 永不完成 → `_rebuildCComposite`（line 519 `slab.size === 0` 跳过）→ 网格全 NaN → 黑屏。B-Scan 因 `_ensureFull` 只调用一次、fullGen 稳定而不受影响。

**修复（`sliceView.js`，~25 行）**：
1. 每线加 `slabLoading` + `slabLoadId`（构造器初始化）。
2. 门控改 `if (line.slabZ === zTile && (line.slab.size > 0 || line.slabLoading)) continue;`。
3. 加载前 `const loadId = ++line.slabLoadId; line.slabLoading = true;`，`_loadKeys(...).then(() => { if (line.slabLoadId === loadId) line.slabLoading = false; });`。
4. `_loadKeys` 改为 `return Promise.all(...)`。
5. `setVisible(false)` 同时 `line.slabZ = -1; line.slabLoading = false;`。

### B. LOD 过渡生硬 + 拉远黑洞 — 双向 fallback + 过渡列表交叉淡入 ✅
`volumeScene.js:294` `if (dl >= h.level) continue` 只做单向 fallback（保留有"未加载细后代"的粗瓦片）：
- **拉远黑洞**：desired 变粗，细瓦片 `need=false` → line 305 立即 `group.remove(mesh)`；粗祖先可能已被 LRU 淘汰 → 黑屏。
- **放大硬切**：细瓦片全部落地那一帧粗瓦片同时移除 → 无过渡。

**修复（`volumeScene.js`，~120 行）**：
1. **双向 fallback，O((M+D)×levels)**：
   - 对每个未加载 desired 瓦片 D，向上走祖先标记 `keepAnc[ancKey]=true`（放大：粗瓦片留作 fallback）。
   - 对每个非 desired 网格 M，向上走祖先，若某祖先在 desired 且未加载 → 保留 M（拉远 fallback，M 覆盖该粗瓦片区域期间不黑屏）。
   - 第二段 desired-add 的 `hasAncestor`（line 312-319）改为向上走祖先查 `fallbackKeys` 集合（O(desired×levels)）。
2. **交叉淡入淡出（200ms，过渡列表）**：
   - 新增 `this._fading = new Map()`，`mesh.userData.fade`（默认 1）。
   - 当一个粗瓦片 C 的"需要移除"条件满足（其细后代全部就绪）时：把就绪的细后代 F 加入场景且 `fade=0`，把 C 登记进 `_fading`（fade 1→0），同一 200ms 内 F fade 0→1。
   - `syncStyle`（line 358）改为 `u.uOpacity.value = s.opacity * (mesh.userData.fade ?? 1)`。
   - `tick()` 每帧推进 `_fading`，`fade` 归 0 后 `group.remove(mesh)` 并移除登记。
   - **关键点**：desired-add 循环里，若 C 在 `_fading`（过渡期）则视为"无祖先阻挡"，允许 F 加入；fallback 扫描跳过 `_fading` 中的 mesh。
   - 预乘混合下线性交叉淡出总不透明度在中点短暂"凹陷"（轻微变暗，视觉如溶解）——符合预期，可接受。
3. **LOD 滞回**（可选）：`computeDesired` 细分用 `th(L)`、合并回粗级用 `th(L)*1.5`，记录各区域当前级，防阈值抖动。交叉淡出已平滑大部分抖动，此项列为可选。

### C. LOD 切换瓦片加载慢 — 过期队列清理 + desired 优先 + 全局 limiter + Worker 解压 ✅（已修正盲点）
**自审修正**：浏览器本就 ~6 连接，JS 侧"全局并发上限"单独用**不能提速**（72 个 fetch 早已排队在 6 条连接上）。真凶：
1. **队列污染**：`drainQueue`（`volumeScene.js:428`）不检查 key 是否仍在 desired → 缩放后过期瓦片仍占连接槽位 + GPU 缓存 → 新 desired 瓦片排队等过期瓦片。
2. **主线程 zstd 解压**：每瓦片 ~5-15ms，几十片到达时阻塞 rAF → 又慢又卡。本批用 Web Worker 解决。

**修复**：
1. **过期清理 + desired 优先（`volumeScene.js` drainQueue，~15 行）**：加载前 `if (!this.desired.has(item.key)) continue;`（`this.desired` 已在 line 323 赋为当前帧）。可选：队列 >200 时 `filter(q => desired.has(q.key))` 压缩。
2. **全局并发 limiter（~30 行）**：模块级信号量（复用 sliceView `acquire/release` 模式），`MultiLineHost` 创建并经 `shared.limiter` 传入各 `VolumeScene`，`loadTileAsync` 在 fetch 前 `await acquire()`、完成后 `release()`。总预算 ~8-10；self 模式用本地 limiter 行为不变。作用：把 12 线在途 stale 请求从 72 压到 ~8，缩放后新瓦片更快拿到连接。
3. **zstd 解压进 Web Worker（新增 `web/src/dataset/zstd.worker.js`，~20 行；改 `tileLoader.js`，~40 行）**：
   - worker 用 Vite 原生模块 worker：`new Worker(new URL('./zstd.worker.js', import.meta.url), { type: 'module' })`，内部 `import { decompress } from 'fzstd'`。
   - `loadTile` 拿到 `buf` 后：`comp = buf.slice(dataOffset, dataOffset+dataLength)`（拷贝压缩区，不动原 buf）→ `postMessage({ id, comp, n, scale, offset }, [comp])`（transferable 零拷贝）→ worker 解压 + 校验 `n*2` + int16→float32（沿用 `scale===1 && offset===0` 快路径）→ `postMessage({ id, f32: f32.buffer }, [f32.buffer])` 转回。
   - 主线程 `tileLoader.js` 维护**模块级单例 worker** + `id→resolve` 路由表；`worker.onerror`/消息内 `error` 字段 → 主线程 `decompress` 回退路径（重新 `buf.slice`，因原 buf 未被 transfer）。
   - 3D 瓦片与 B/C-Scan 共用 `loadTile`，自动同时受益。
4. sliceView 整条 L4 加载（315 片）与 3D LOD 加载共用这 6 条连接——两套 limiter 若后续统一为一个全局信号量可进一步防饿死，本批仅统一 volumeScene 侧。

### D. 高 LOD 帧率低 — 共享模式视锥剔除（主）+ 扫描降复杂度（次） ✅
`computeDesired`（line 262）共享模式 `frustum = null` → **desired 集合本身含大量视野外瓦片**，既白白加载又白白光追。fallback 扫描 O(M×D)，高 LOD 时 M、D 各数百。

**修复**：
1. **共享模式世界视锥剔除（~25 行，P1）**：`computeDesired` 用共享相机构建世界 `Frustum`（`setFromProjectionMatrix`）；测试时把局部 box 转世界 AABB——镜像线 x 取 `[ox+minX*d, ox+maxX*d]` 排序，y/z 平移，复用 `_scratchV` 不分配——`frustum.intersectsBox(worldAabb)`。同时解决"加载多"+"渲染多"。
2. **fallback 降为 O((M+D)×levels)**（与 B 合并实现）。
3. **减少每帧分配（~10 行）**：`desiredParsed` 只在 desired 变化时构建；`renderList` 分配复用；`multiLineHost.tick()` 仅当 mesh 集合/可见性变化时重建+排序 `all`（`multiLineHost.js:124-143`）。
4. **syncStyle 指纹门控（~10 行）**：样式不变跳过 uniform 写入。

---

## 实施顺序（一次全改，按依赖）
1. **A**（`sliceView.js`）——独立，先做。
2. **C-3**（zstd Worker：`tileLoader.js` + 新增 `zstd.worker.js`）——独立，全链路自动受益。
3. **B+D-2**（`volumeScene.js` 双向 fallback + 过渡列表 + fade）——核心重构。
4. **D-1**（`volumeScene.js` 世界视锥剔除）——依赖 B 的 fallback 语义。
5. **C-1/C-2**（`drainQueue` desired 检查 + 全局 limiter + `main.js` 传递）。
6. **D-3/D-4**（分配/排序/syncStyle 门控）。

## 关键文件
- `web/src/render/sliceView.js` — A
- `web/src/render/volumeScene.js` — B/C/D（fallback、fade、剔除、limiter）
- `web/src/dataset/tileLoader.js` + **新增 `web/src/dataset/zstd.worker.js`** — C-3（Worker 解压）
- `web/src/render/multiLineHost.js` — C-2（limiter）/D-3（排序门控）
- `web/src/main.js` — 传递 `shared.limiter`

`processing/` 无需改动。

## 后续项（本批不做）
- sliceView 与 volumeScene 统一全局 limiter（防两套信号量互相饿死）。
- `autoFitWindow` 移到 IdleCallback（一次性采样 ~300ms 阻塞）。
- 若 worker 实测仍卡：`stepsFor` 上限 192→128，或按"瓦片总步数预算"整体限流。

---

## 验证

1. **C-Scan**：`npm run dev` 打开，多线默认"全宽合成"：C-Scan 立即显示（非黑屏）；拖动深度跨 zTile（≈2.5m/片）按片重载；勾掉/勾回某线 → 合成增删正常。B-Scan 不回归。
2. **过渡**：主视图持续放大→缩小：无黑洞（拉远时细瓦片保留到粗瓦片落地）；粗→细有 ~200ms 交叉淡入淡出。HUD `meshes` 过渡期平滑。
3. **加载速度**：放大到细 LOD，HUD `queue`/`inFlight` 不再堆积过期瓦片；`inFlight` ≤ 全局预算（~8-10）；DevTools Performance 面板确认 zstd 解压出现在 Worker 线程（不在主线程长任务），放大过程主线程 rAF 保持流畅。
4. **帧率**：贴近高 LOD，HUD `fps` 提升；旋转相机使瓦片转到背后 → `desired`/`meshes` 明显下降（剔除生效）。
5. **回归**：单线回退路径（无 manifest）B-Scan/C-Scan 正常；`window.__scene/__slice/__gps` 钩子可用。
