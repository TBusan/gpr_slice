# GPR 查看器：B-Scan 噪点修复 + 多测线显示（按 GPS 真实定位）

## Context

**问题 1 — B-Scan 噪点。** 用户反馈 B-Scan（固定通道雷达图）噪声远大于主视图。根因已确认（`web/_shots/bscan_noise.mjs` 实测）：`sliceView.js` 存在**两级最近邻抽稀**——
1. `_rebuild()` 把 L0 X=45307 的源样本 stamp 进 2048 网格（`Math.round((minX+…)/xRange*(gridX-1))`，后写覆盖，每列只保留 ~22 个源样本中的 1 个）；
2. `_renderCanvas()` 再把 2048 网格按 `Math.round(px/cw*gw)` 最近邻抽到画布（~660px）。

粗糙度实测：全分辨率=11.9（数据本身干净）、NN 链路@660=33.6、箱平均链路@660=22.1。主视图干净是因为 GPU 三线性 + 射线累积平均。**用户已确认：用 CPU 箱平均修复，仅改显示端，不需重新生成 dataset。**

**问题 2 — 多测线显示。** 用户希望最终把全部测线在真实 GPS 位置同显、可逐线开关。已探明数据现状：
- 20 条测线（`data/mingxingroad/明星路_001..020`）都是同一段 ~2.2km 南北向道路（明星路）的**多遍扫描**，方向交替（001 南下、002 北上、003 南下…），跨轨（东西）偏移集中在 −5..+23m 带内。
- 每线 14 通道、~45k 道（LAST TRACE），CH_X_OFFSET=−0.686m。全 12 条全长线 001/002/003/004/006/008/009/010/011/012/015/016（~2.2km）；4 条中长（013/014/017/018）、4 条短标定（005/007/019/020）本轮跳过。
- 每线有自己的 `.gps`（WGS84 经纬度，~5Hz，按道序记录）——这是逐线真实定位的依据；当前 dataset 却用共用的 `明星路_测试路段_rad.utmgps`，与测线无关。
- 管线 `gpr2gvt` 已支持 `--line/--out/--gps`；`ParseUtmTrack` 只吃 `.utmgps`（9 列 UTM，取 4 角质心），**不吃 `.gps`** → 需要转换。
- `main.cpp:320` 硬编码 `md.datasetId="mingxingroad_001"` → 逐线生成需改为按 `--line` 基名派生。

**用户已确认范围：**
1. 本轮生成 **12 条全长线**（实测单线 0.64GB → 12 线 ≈ **7.7GB**，zstd 12）。
2. 多线 C-Scan 采用 **全宽合成**（所有可见测线按 GPS 跨轨位置拼进一张全宽深度图）；**空隙保持黑，不插值**。
3. 多线形态：**全部同显、可逐线开关**为基础设施；C-Scan 全宽合成即「拼接整幅宽断面」的呈现。
4. 3D 摆放采用 **直线箱体近似**（trace-0 真实位置 + 平均跨轨偏移，忽略道路轻微弯曲 ±0.5~2m）。

**头脑风暴结论（已核实）：**
- **坐标系已验证 = WGS84**（非 GCJ-02）：修正 UTM 公式后，line 001 首/末点转 UTM 与共享轨迹偏差 0.3/2.1/1.3/5.1m。逐线 `.gps` 直接转 UTM 即可。
- 每线 `.gps` ≈3404 点（5Hz）vs 道数 45305（66Hz）→ 逐道 GPS 需插值；沿轨/跨轨统计用整轨均值，精度足够。
- 沿轨尺度：里程计 45305×0.049084=2223m vs GPS ≈2201m（差 ~1%，末端漂 ~22m）。各线共用同一名义道距 → 线间相对对齐一致，仅相对 GPS 底图有 ~1% 拉伸，**本轮接受**；逐道 GPS 校正留作后续。
- 各全长线道数可能略有差异（001=45305）→ C-Scan 合成 X 取并集，短线尾部为黑，属正常。
- **HalfFloat 显示/副作用（已核实）**：int16 值域映射到颜色量化 <0.1 色阶，肉眼不可见；WebGL2 R16F 线性过滤原生支持（`OES_texture_float_linear` 只对 Float32 需要）；光线累积/三线性不受影响；底层 int16 数据不动，切片走 CPU Float32 亦无损。
- **z-fight 不受 HalfFloat 影响（已核实）**：z-fight 由深度缓冲决定，与纹理格式无关；12 线跨轨间距 ≥0.5m 远大于典型距离下深度精度（50m 处 ~0.3mm）；体绘制砖块间用全局 renderOrder 混合、无逐三角形 z-test。唯一边缘：相机正对道路轴线时等距砖块 renderOrder 并列 → 混合顺序由插入序决定，伪影极小，加 tie-breaker 即可。
- **切片深度分辨率（用户已确认 L2）**：解耦后 B-Scan 加载 L2（196 深度层）而非 L3（仅 98 层 → 400px 画布 ~4px 条带视觉退化）；L2 约 2px 条带可接受。

---

## Phase 1 — B-Scan / C-Scan 噪点修复 + 切片视图解耦（web 端，先做，独立落地）

文件：`web/src/render/sliceView.js`、`web/src/render/brickRenderer.js`

### 1a0. 切片视图与 3D 缓存解耦（GPU 优化③，先于箱平均落地）
现状：`_rebuild()` 读 `scene.meshes`（`sliceView.js:119` 取纹理背后的 **CPU Float32 数组**），迫使 3D 缓存常驻粗级瓦片喂切片 —— 12 线 = 1104 片 ≈618MB GPU 纯为切片服务。解耦：
- sliceView 构造器接收 `tileLoader`（解压后 Float32）+ meta + basePath，**内部维护 CPU 侧瓦片表**（level→{header, data}），按需加载，不再引用 3D scene.meshes。
- 加载策略（**用户已确认 L2 全线路**）：**B-Scan 加载选定线 L2**（45×1×7=315 片 ≈176MB CPU，196 深度层 → ~2px 条带可接受）；**C-Scan** 单线读该线、全宽合成读**所有可见线**的固定深度行（L3 深度行 23×0.56≈13MB/线，深度轴不显示故 L3 足够）。
- 收益：GPU 缓存只需服务 3D 视锥，粗级常驻压力消失；切片质量不再受 3D 相机状态影响。
- `_rebuild()` 的迭代源从 `scene.meshes` 改为 CPU 瓦片表（仍按 level 降序）。

### 1a. `_rebuild()` 由「后写覆盖」改为「同级箱平均 + 细级覆盖」（源：1a0 的 CPU 瓦片表）
- 新增成员累加缓冲：`accB/cntB/claimB`（gridB：gridX×gridZ）、`accC/cntC/claimC`（gridC：gridX×gridY），复用不每次重分配。
- 循环仍按 level 降序（粗→细）；对每个体素的 footprint 单元（spanX/spanZ 保持现逻辑，粗级上采样不变）：
  - `claim != 当前 tile level` → 接管（`acc=v, cnt=1, claim=level`）；
  - `claim == 当前 level` → 同级累加（`acc+=v, cnt++`）。
  - 由于粗→细顺序，`claim > 当前 level` 不会发生。
- 全部瓦片处理完：`grid[i] = cnt>0 ? acc[i]/cnt[i] : NaN`（NaN 仍表示该格无数据，渲染成黑）。

### 1b. `_renderCanvas()` 由最近邻改为逐像素箱平均
- 每输出像素 `px`：源列区间 `[floor(px*gw/cw), ceil((px+1)*gw/cw))`（clamp 到 [0,gridX]）；行同理（`py` → gridZ 区间）。
- 区间内均值，NaN 感知（跳过 NaN；全 NaN → NaN → 黑）。区间平均宽度 ≈ gridX/w ≈ 1.5–3 列，开销可忽略。
- 按画布尺寸缓存行列区间表，避免每帧重复计算。

### 1c. 验证
- 扩展 `web/_shots/bscan_noise.mjs` 模拟新链路，断言粗糙度从 ~33.6 降到 ≤22（**诚实目标：不会回到全分辨率 11.9**，因 660px 输出平均的源样本少于主视图；观感接近即达标）；
- 浏览器对比：B-Scan 噪点应与主视图观感接近；C-Scan 沿 X 方向同样受益；解耦后切片不再依赖 3D 相机位置（相机移到别处切片也不黑）。

---

## Phase 1b — HalfFloat 纹理（GPU 优化②，独立小改）

文件：`web/src/render/brickRenderer.js`
- 上传时 Float32 → 半精度（Uint16），`texture.type = THREE.HalfFloatType`（`brickRenderer.js:106` 现为 FloatType）；`linearOK` 判断相应调整（WebGL2 R16F 线性过滤原生支持）。
- **显示无损**：int16 值域 −32628..30855 → 颜色映射量化 <0.07 色阶，肉眼不可见。
- 每瓦片 VRAM 0.56MB → **0.28MB**（所有级别通用，12 线全览粗级 1104 片 618MB → 309MB）。
- 验证：浏览器目视 3D/B-Scan/C-Scan 与改前一致；`renderer.info.memory.textures` 减半。
- **顺序约束**：必须先完成 1a0 解耦再落地（切片读 CPU Float32，否则会读到半精度 GPU 数据）。

---

## Phase 2 — 逐线 dataset 生成（含逐线 GPS）

### 2a. 新增 GPS 转换工具 `processing/tools/gps2lines.mjs`（Node，复用 web/node_modules）
输入：`data/mingxingroad/明星路_001..020.gps`（WGS84 经纬度，按道序）。输出：
1. **逐线 UTM 中心线**：WGS84 → UTM 51N（标准公式，无第三方依赖），按道序。
2. **道路参考系**：以 001 线轨迹为参考，最佳拟合得到沿轨方向 + 垂直跨轨方向。
3. **逐线几何**：`alongStart`（trace-0 投影到沿轨轴）、`crossOffset`（全轨迹到参考线有符号垂直距离均值）、`direction`（±1，由轨迹走向判定）。
   - **反向线处理（头脑风暴修正）**：方向交替使反向线（002/004/…）trace-0 位于道路另一端。数据体本身**不翻转**，但 3D 摆放必须镜像 —— 反向线 `group.scale.x = −1`，否则箱体沿 +X 延伸会整体错位到道路另一端之外（002 的箱体会落在 [2223,4446]，正确范围应为 [0,2223]）。C-Scan 合成则按 `direction` 做 X 映射（反向线 X 逆序）。
4. **逐线 `.utmgps`**（供管线 `--gps`）：4 角点 = 中心线点 ± 小半宽（管线只取 4 角质心，heading 列填 0），重采样到 ~50–200 点。
5. **`dataset/lines/manifest.json`**：`[{ id, name, metaUrl, worldOffset:[alongStart, crossOffset, 0], direction, traceCount }]`。

### 2b. 管线小改（C++）
- `processing/src/main.cpp:320`：`md.datasetId` 由 `--line` 基名派生（如 `明星路_002` → `mingxingroad_002`），`md.datasetName` 已取基名。无其他改动（`--gps/--out` 已支持；`spatial.origin` 保持通道相对，跨轨偏移由 web 经 manifest 施加，避免改卷 AABB 语义）。

### 2c. 生成 12 条线
- cwd=仓库根，逐条：`processing/build/gpr2gvt.exe --line "data/mingxingroad/明星路_NNN" --out "dataset/lines/明星路_NNN" --gps "<tools 生成的 utmgps>"`。
- 12 条 ≈ 3–5 分钟，实测单线 0.64GB → **~7.7GB**。现有根 `dataset/`（单线 001）保留作单线回退 / 参照，不动。
- 抽查：metadata id/name/gpsTrack 逐线不同；瓦片数 ≈5989/线；随机解压 2–3 个 `.gvt` 校验 int16。

---

## Phase 3 — Web 多测线显示（全部同显 + 逐线开关 + C-Scan 全宽合成）

### 3a. 数据加载
- `web/src/dataset/metadata.js`：新增 `loadManifest(url)`（解析 `dataset/lines/manifest.json`）。
- `web/src/main.js`：boot 优先加载 manifest；成功 → 并行 `loadMetadata` N 份 + 多线装配；失败/无 manifest → 走现有单线 `/dataset/metadata.json` 路径（回退兼容）。

### 3b. 场景重构：多体共享渲染器/相机/控制器（核心改动）
文件：`web/src/render/volumeScene.js`
- 构造器增加可选 `shared = { renderer, scene, camera, controls, frustum, cache }` 与 `basePath`、`worldOffset`、`direction`：
  - 传入共享对象时**复用** renderer/camera/controls/scene/cache；否则自建（保持现有单线/测试路径）。
  - 每线维护 `this.group = new THREE.Group()`，`group.position.set(...worldOffset)`；**反向线 `group.scale.x = −1`（头脑风暴 Bug 1 修正，否则箱体错位）**；加入共享 scene；`tick()` 里 `this.scene.add(mesh)` → `this.group.add(mesh)`。
- `tileUrl()` 改为 `basePath + '/' + meta.storage.tilePath 替换`（`basePath = /dataset/lines/<id>`）。
- LOD/desired/loaded 等仍按线独立；`syncStyle` 仍只同步 `mesh.parent`。
- 相机适配：新增 `fitAllLines()`（union 全部可见线 volumeAABB），替代单线 `frameCamera()`。**用户已确认全景 fit-all**；注意跨轨仅 ~28m，全景下 12 线挤在 ~12px 垂直高度内，需手动放大分线（已知晓）。
- **共享 TileCache（头脑风暴 Bug 2/4 修正 + GPU 优化①）**：单线 512 瓦片 ×12 线 = 3.4GB 必爆。改为 main.js 创建**单一共享 TileCache**，key 前缀 `lineId/`；mesh 记录 `userData.lineId`，onEvict 从对应 line 的 group 移除（现 `mesh.parent.remove` 逻辑按 lineId 归属）。
- **LOD 策略 + 预算（GPU 优化①，配合 Phase 1a0 解耦）**：切片已解耦，粗级不再为切片常驻 → 粗级只对**可见且在视锥**的线加载，**加载带视锥裕量（扩 ~1.5×）并短时保留**，避免相机移动时反复加载/淘汰造成边缘 pop-in；按相机距离限制每线最大细分级别（远处只上粗级）；隐藏线不加载、不 tick、不占预算。共享缓存预算 **~1280 块（HalfFloat ≈358MB）**：全览 12 线粗级 1104 片 ≈309MB，典型 3D 视锥 300–700 片 ≈85–200MB。
- **全局 renderOrder（头脑风暴 Bug 3 修正）**：现每线独立排序（`volumeScene.js:266-273`）在深度重叠时混合错误。改为 main.js 每帧汇总**所有可见线**在场景中的 mesh，按相机距离**全局远→近排序**赋 renderOrder；**距离并列时按 lineId 稳定排序（tie-breaker）**。
- 每帧：main.js 循环各可见线 `tick()`（含 drainQueue），随后全局排序 renderOrder，`renderer.render` 一次。不可见线跳过 tick（不占预算、不混排）。

### 3c. UI（`web/index.html` + `main.js`）
- slice-controls 新增 `#lineSelect`（测线下拉）——驱动 B-Scan 的「线×通道」。
- 新增测线可见性面板（checkbox 列表）——3D 逐线开关（全部同显 + 可逐开关）；**隐藏线不加载、不 tick**。
- C-Scan：`#cscanMode` 切换「单线 / 全宽合成」+ 深度滑块。
- HUD 汇总：视口瓦片/已加载/队列等跨线合计。

### 3d. sliceView 多线化
- **B-Scan**：数据源走 Phase 1a0 解耦的 CPU 瓦片表，按 `#lineSelect` 切换 basePath 加载选定线（网格尺寸各线一致，grid/累加缓冲可复用）；`lineSelect`/`chanSlider` 变化置 dirty。**切线/切模式时释放旧线 CPU 瓦片**（防内存累积）。
- **C-Scan 全宽合成**（用户已确认，含空隙保持黑）：
  - 计算合成网格：跨轨范围 = 各可见线 `[crossOffset−0.686, crossOffset+0.686]` 的并集，`crossGridY = round(range/0.1055)`（12 线约 28m → ~265 行）。
  - 每条可见线把固定深度行 stamp 进合成 gridC：`compositeRow = round((crossOffset + channelOffset − crossMin)/0.1055)`，X 用 `direction` 映射（反向线 X 逆序），覆盖策略「后线优先」（或选中线置顶）。
  - **无测线覆盖的跨轨空隙（如 −0.5~4.4m）保持 NaN/黑，不做插值**（用户已确认）。X 取各可见线并集，短线尾部同样为黑。
  - `_renderCanvas` 沿用（X=沿轨, Y=跨轨）；跨轨行数由合成网格决定。
- `web/src/render/gpsMapView.js`：绘制全部测线 gpsTrack 折线（不同色）；相机标记用参考线（001）映射；图例。

### 3e. 涉及文件
- `web/src/main.js`、`web/index.html`、`web/src/dataset/metadata.js`、`web/src/render/volumeScene.js`、`web/src/render/sliceView.js`、`web/src/render/brickRenderer.js`、`web/src/render/gpsMapView.js`
- `processing/tools/gps2lines.mjs`（新增）、`processing/src/main.cpp`（仅 datasetId 派生）

---

## 验证

### Phase 1
- `web/_shots/bscan_noise.mjs`：新链路粗糙度 ≤22；浏览器目视 B-Scan 噪点显著下降，与主视图观感接近。

### Phase 2
- 逐线 metadata：`dataset.id` 唯一、`gpsTrack.points` 为逐线 UTM、`levels[].dimensions` 与 001 一致；
- 瓦片抽样解压逐字节合理（int16 值域与 metadata globalMin/Max 一致）。

### Phase 3
- 浏览器（`npm run dev`，端口 5177）：12 线按真实跨轨偏移在 3D 并排显示；反向线方向正确；逐线开关生效；B-Scan 线×通道正确；C-Scan 全宽合成跨整条路（空隙为黑）；gpsMapView 显示 12 条轨迹 + 相机标记；LOD 流式加载无黑洞、无 LRU 抖动。
- 性能：多线合帧 FPS 可接受；`renderer.info.memory.textures` 记录并断言 —— 全览 12 线 ≤ ~310MB、典型视锥 ≤ ~200MB（HalfFloat 共享缓存预算 1280 片 ≈358MB 内，实测调参）。

---

## 风险与缓解

1. **多体 GPU 内存**：512×12 瓦片会爆 → 单一共享 TileCache（lineId 命名空间 key）+ **HalfFloat 纹理（×0.5）** + **切片视图解耦（Phase 1a0，去掉喂切片的粗级常驻）** + 粗级只对可见且在视锥的线 + 距离分级 LOD + 预算 ~1280 片（≈358MB），实现时用 `renderer.info.memory.textures` 实测调参。
2. **反向线沿轨对齐**：C-Scan 合成按 `direction` 做 X 逆序映射；**3D 摆放须 `group.scale.x = −1` 镜像**（不只是按 trace-0 摆放），否则箱体错位到道路另一端。镜像后 AABB/排序 center 需按组变换计算。
3. **GPS 精度**：民用 GPS ~±0.5–1m，跨轨偏移取全程均值抑制噪声；相邻线可能轻微重叠属正常。
4. **VolumeScene 重构回归**：共享渲染器改造后必须保持单线路径可用（自建 renderer 分支），浏览器回归单线与多线两种模式。
5. **磁盘 ≈7.7GB**（实测单线 0.64GB × 12）；可后续增量补其余线（再跑一次管线即可）。
6. **短/标定线（005/007/019/020）**：本轮不做；manifest 结构已预留，后续直接追加。
7. **沿轨 1% 尺度差**：本轮接受（线间相对对齐一致）；若后续需要贴合 GPS 底图，做逐道 GPS 校正（`.time` 注册 + 重采样），不阻塞本轮。

## 明确不做（本轮）
- processing 端真正的体合并（把 12 线 merge 成单个连续宽体积）：C-Scan 合成先做，体合并等跨轨偏移验证可靠后再考虑。
- 非全长线的数据生成。
