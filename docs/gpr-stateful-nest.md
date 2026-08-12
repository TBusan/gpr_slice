# GPR 查看器 — 视口方向指示器（前/俯/左三视图切换）+ processing 复核

## Context

用户请求两部分：
1. **前端**：主视图右下角增加一个坐标轴指示器，实时指示三轴方向；点击两个轴形成的平面，主视图切换到对应工程视图（类似前视图/俯视图/左视图）。
2. **processing 复核**：重新审查 `processing/` 数据管线处理是否正确。

第一部分是本计划的主要实施内容。第二部分已在上一阶段用**二进制级证据**复核完成，结论为**处理正确、无需改动代码**，证据汇总见 Part B。

## Part A — 视口方向指示器（ViewCube）

### 轴语义（world space，与 metadata/spec 一致）
- X = 沿轨方向（水平），Y = 跨轨/通道方向（水平），Z = 深度（向下，world up = -Z）。
- 三视图：
  - **前视图 front**：沿 -Y 方向看 → 平面 X-Z（即 B-Scan 面），相机 up = (0,0,1)
  - **俯视图 top**：沿 +Z 方向看（相机在体上方）→ 平面 X-Y，相机 up = (0,1,0)
  - **左视图 left**：沿 -X 方向看 → 平面 Y-Z，相机 up = (0,0,1)

### 新增文件 `web/src/render/viewCube.js`

`export class ViewCube { constructor(container, scene) }`，`scene` 为 VolumeScene（提供 `camera`、`controls`、`meta`）。

- 内部建一块 110×110 CSS 像素 `<canvas>`（dpr 自适应），**2D Canvas 渲染**，无需第二个 WebGL 上下文（比 three ViewHelper 更贴合“点击平面”需求，且命中检测可用 2D 平行四边形代数精确求解）。
- **绘制**（每帧 `update()`；先 `camera.updateMatrixWorld()`）：
  - 取 `camera.matrixWorld` 的 right/up 列向量，把世界三轴 X/Y/Z 投影成屏幕向量。
  - 三个半透明平面四边形（共享原点角的“立方体角”）：
    - 前（X-Z 平面，青色）：四角 = 原点、X尖、X+Z尖、Z尖
    - 俯（X-Y 平面，绿色）：四角 = 原点、X尖、X+Y尖、Y尖
    - 左（Y-Z 平面，橙色）：四角 = 原点、Y尖、Y+Z尖、Z尖
  - 每面透明度按 `|dot(planeNormal, viewDir)|` 调制（朝相机的面更亮），标签“前/俯/左”画在四边形中心。
  - 三根轴线画到轴尖 + 字母 X/Y/Z（红/绿/蓝）。
- **点击**（canvas pointerdown，`stopPropagation`，避免穿透旋转）：
  - 屏幕点 → 投影单位空间 `v = ((px-C)/R, (py-C)/R)`。
  - 每面做平行四边形测试：解 2×2 线性方程组 `v = α·a + β·b`（a,b 为该面两轴的投影向量），`α,β ∈ [-0.15, 1.15]` 判中。
  - 多面命中取 `|facing|` 最大者（最朝相机的那一面）。
  - 命中 → `snap(key)`。
- **snap(key)**（标准视图 = 框住整个数据体，类似 CAD 前/俯/左视图）：
  ```js
  const cfg = VIEWS[key]; // axis=相机偏移方向(前=(0,1,0)/俯=(0,0,-1)/左=(1,0,0))、up、plane=[两轴索引]
  const aabb = meta.volumeAABB();
  const dims = [max[0]-min[0], max[1]-min[1], max[2]-min[2]];
  const fit = Math.max(dims[cfg.plane[0]], dims[cfg.plane[1]]); // 面内两轴的更大跨度
  const d = (fit / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25;
  const c = meta.volumeCenter();
  camera.position.set(c[0] + axis[0]*d, c[1] + axis[1]*d, c[2] + axis[2]*d);
  controls.target.set(c[0], c[1], c[2]);
  controls.up.set(...cfg.up);
  controls.update();
  ```
- 暴露 `snap(key)` 与调试钩子。

### 修改 `web/index.html`
- `#viewport` 内（`<div id="viewport"></div>` 与闭合之间）加：
  ```html
  <div id="viewCube" title="点击平面切换视图"></div>
  ```
- CSS（`#mapPanel` 占 bottom:10..200px，指示器放其上方、互不重叠）：
  ```css
  #viewCube { position: absolute; right: 12px; bottom: 212px; width: 108px; height: 108px;
              background: rgba(15,17,22,0.72); border: 1px solid #333; border-radius: 8px;
              cursor: pointer; user-select: none; overflow: hidden; }
  #viewCube canvas { width: 100%; height: 100%; display: block; }
  ```

### 修改 `web/src/main.js`
- `import { ViewCube } from './render/viewCube.js';`
- 场景创建后：`const viewCube = new ViewCube(document.getElementById('viewCube'), scene);`
- 主 rAF `frame()` 内与 slice/gps 一起调用 `viewCube.update();`（同处 try/catch）。
- 调试钩子：`window.__viewCube = viewCube;`

## Part B — processing 管线复核（已完成，结论：正确）

二进制级证据（已逐项验证通过）：
1. `.gvt` 头与规范逐字节一致：magic `47505256`="GPRV"、dataOffset=52、dims 258×16×34（核心 256×14×32 + ghost×2）、dataType=2(int16)、compression=2(zstd)、zstd 帧魔数 `28b52ffd` —— 与 `gvt_common.h`/`docs` 吻合。
2. stats 块（min/max/mean）：在 3 个瓦片（3/0/0/0、3/22/0/3、0/0/0/0）手工按**核心区**重算，与文件内值完全一致（ghost 不参与统计）。
3. ghost 边界复制：卷边缘 clamp、内部瓦片采样相邻体素 —— 正确（供三线性插值防接缝）。
4. LOD 降采样 `DownsampleMaxAbs` 符合规范 §11；逐级 scale [2,1,2]、累积 [1,1,1],[2,1,2],[4,1,4],[8,1,8]；metadata dims/spacing/origin 与代码一致。
5. metadata.json 全字段与 `regularizer.cpp`/`lod_generator.cpp`/`metadata_writer.cpp` 一致（L0 [45307,14,781]、spacing、origin [0,-0.686,0]、4 级、tile 256×32×32、ghost 1、zstd、int16、channelOffsetsY、49 点 UTM）。
6. 前端 `tileLoader.js` 头解析偏移与 C++ 写入者字节对齐。
7. Y 轴均匀间距 = (末-首)/13 ≈ 0.10554 m，与实测 channelOffsetsY 最大偏差 ≤0.5mm（可忽略）。

备注（非缺陷）：短通道零填充到 nx；Y 方向 AABB 超出最外侧通道中心一格（标准体素惯例）；均属规范内正常行为。

## 验证

**A（前端）**
1. 启动 Vite dev（端口 5177），重载页面。
2. `#viewCube` 出现在视口右下角（mapPanel 上方）；旋转/平移相机 → 指示器三轴实时同步旋转。
3. 程序化断言：`__viewCube.snap('top')` → `camera.position ≈ center + (0,0,-d)`、`controls.up ≈ (0,1,0)`、`controls.target == volumeCenter`；`snap('front')`/`snap('left')` 同理。
4. 向指示器 canvas 派发真实 pointer 事件点击三个平面位置 → 相机切到对应视图；随后自由拖拽正常（指示器区域不吞 OrbitControls）。
5. 切换后 gpsMapView 相机标记随 camera.x 更新；LOD 流式加载无回归（92 块 L3 常驻、切片视图无黑洞）。

**B（processing）**：上述 7 项证据已通过，无需改动代码；可在结论中直接向用户报告。
