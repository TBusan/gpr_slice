# 主视图两个问题修复 —— 动态样式无效 + 俯视图瓦片拼接痕迹

## Context

用户报两个问题（均在浏览器实测定位到根因）：

1. **动态样式的调整对主视图中已经渲染好的瓦片无效，只有缩放层级、瓦片重新加载时才有效果。**
2. **主视图中从俯视图看瓦片，瓦片直接的拼接痕迹太多。**

两者都命中 `web/src/render/volumeScene.js` / `brickRenderer.js`，互相独立，分别修复。

---

## Issue 1 —— 动态样式对已渲染瓦片无效

### 根因（已确认）

`volumeScene.js` `syncStyle()` 的样式指纹门控（528 行）：
```js
const fp = `${s.colorMap}|${s.minValue}|...`;
```
`s.colorMap` 是 **THREE.CanvasTexture 对象**（`style.js:17`），模板字符串恒等于 `"[object Object]"`。因此只要不碰数值参数，`colorMapName` 变化后 `fp` **不变** → `styleChanged === false` → 跳过 `u.uColorMap.value = s.colorMap`（537 行）→ 已渲染瓦片的颜色贴图永不更新，只有新建瓦片（创建时用当前 style）才生效。

对照：`sliceView.js:364` 的指纹用的是 `s.colorMap.uuid`（稳定字符串），所以 C-Scan 切片换色图是即时生效的——3D 体积是唯一漏改的路径。数值参数（minValue/maxValue/gain/gamma/threshold/opacity）走同一指纹，本来就是对的，无需动。

### 修复（一行）

`volumeScene.js:528` 把 `s.colorMap` 换成 `s.colorMapName`（稳定字符串 `'blue-red'/'seismic'/...`，见 `style.js:16`）：
```js
const fp = `${s.colorMapName}|${s.minValue}|${s.maxValue}|${s.gain}|${s.gamma}|${s.thresholdMin}|${s.thresholdMax}|${s.opacity}`;
```
其余不动：换色图时 `styleChanged=true` → 写入 `uColorMap`（新的 texture 对象），同时数值参数一并重写（幂等）。

---

## Issue 2 —— 俯视图瓦片拼接痕迹

### 根因 2a（已确认）：采样步数 uSteps 不一致

`volumeScene.js` `stepsFor(tile)`（674-684 行）按 **瓦片实际宽度** 和 **创建时刻相机距离** 算步数：
- partial 瓦片（核心宽 32 体素 vs 满宽 256）→ `worldX` 小 → 步数低。实测相邻瓦片 **3/21=16 步 / 3/22=8 步**。
- 缩放过程中不同时刻创建的瓦片 → 相机距离不同 → 同一层级步数混杂。
- 采样密度跳变 → 邻接瓦片亮度不连续 → **俯视图可见拼缝**（尤其体积 X/Z 边缘的 partial 瓦片）。

### 修复 2a：步数统一（每瓦片恒 16）

`volumeScene.js:674` 改为返回常量 16。同一层级所有瓦片步数一致，partial/满宽、创建时刻差异全部消失。
```js
// 步数统一为 16：partial 瓦片与满宽瓦片、不同创建时刻的瓦片步数一致，
// 消除邻接瓦片采样密度跳变（拼缝）。16 是既有安全上限——下方注释已实测：
// 持续 16 步 → 12 线全载 1104 片后 166 FPS，不会触发核显粘滞卡死。
stepsFor(_tile) {
  return 16;
}
```
副作用：`tileWorldCenter`（686-698 行）只被旧 `stepsFor` 用，改后成死代码——保留不删（最小改动，后续可清理）。

> 不改 `brickRenderer.js:113` 的兜底 `stepsFor`：`createBrickMesh` 只有 `volumeScene.js:653` 一个调用方且**总是**传 `opts.steps`，兜底路径在本应用内不可达。

### 根因 2b（已定位）：盒剪影边缘的"楔形积分"细暗线

俯视图中沿 X 的瓦片拼接实测**没有**明显横线（1200m 读取平滑），但**垂直剖面**在每条测线 Y 边缘有 5~18 单位的暗线（67 vs 85）。成因：

- 每条测线体是独立 Box，Y 向只有 1 个瓦片（ny=1），Y 边缘是**体积剪影**。
- 片元落在盒的 X/Y 侧面时（剪影像素），射线在到达远 Z 面**之前**就从侧面退出 → `tFar` 提前 → ray-march 只积分一个**楔形**（缺失整列下半段）→ 比邻近整列积分积累少 → 细暗线。
- 俯视图相机垂直看，侧面几何投影成 1~2px 细条；12 条测线各两条边缘 → "太多拼接痕迹"。
- 相邻测线 cross-track 还重叠 ~0.228m（001 Y∈[-0.686,0.792]、002 Y∈[0.564,2.042]），暗线落在重叠区更显眼。

### 修复 2b：shader 内把积分延伸到盒的远 Z 面（钳位补全整列）

`brickRenderer.js` FRAG，在 `tFar = tb.y` 之后加延伸：
```glsl
vec2 tb = rayBox(ro, rd);
float tNear = max(tb.x, 0.0);
float tFar = tb.y;
if (tFar <= tNear) { gl_FragColor = vec4(0.0); return; }

// 俯视图拼缝修复：片元在盒的 X/Y 侧面（剪影）时，射线未到远 Z 面就侧面退出，
// 积分只覆盖楔形 → 比整列少 → 细暗线。把积分延伸到远 Z 面；t>盒退出的采样点
// tc 越界被 ClampToEdge 钳到边缘体素（最后一行/列），用边缘数据补全整列积分，
// 使剪影列与内部一致，暗线消失。限制：仅当缺失 Z 列较短时延伸（俯视/斜视剪影），
// 近水平侧视（tFarZ 巨大）不延伸，避免侧面采样爆掉。
float tFarZ = rd.z >= 0.0 ? (1.0 - ro.z) / rd.z : (0.0 - ro.z) / rd.z;
if (tFarZ > tFar && tFarZ - tFar < 2.0) tFar = tFarZ;
```
原理：顶部看到的内部射线 rd.z 主导，`tFarZ≈tFar` 不触发；只有剪影/边界像素触发，且钳位数据连续（边缘行 ≈ 内部），补全后与内部一致。**风险与护栏**：近水平侧视 `tFarZ` 巨大被 `<2.0` 挡住；45° 斜视下 `tFarZ≈tFar` 不触发。验证时重点查斜视 X 边界有无新亮带，若有则调小 2.0 或撤掉 2b 只留 2a。

---

## 关键文件

- `web/src/render/volumeScene.js` — `syncStyle()` 指纹（528 行）换 `colorMapName`；`stepsFor()`（674 行）返回 16。
- `web/src/render/brickRenderer.js` — FRAG 增加 `tFarZ` 延伸（81-84 行 `tFar` 之后）。

## 验证

1. 重启 dev server（`cd web && npm run dev`），开 `http://localhost:5177/`，等 12 线瓦片加载完。
2. **Issue 1**：样式面板换色图（blue-red → seismic）→ 已渲染瓦片**立即**变色（修复前只有重新加载的瓦片变）；再拖 min/max/gain 滑块确认数值路径不受影响。
3. **Issue 2 视觉**：viewCube 俯视图 fit-all + 中等缩放 → 瓦片拼接/测线边缘细暗线明显减少或消失；X/Z 体积边缘 partial 瓦片处无步数跳变。
4. **Issue 2 读数**（沿用已跑通的同任务 readPixels 路径 `h.controls.update(); h.tick(); ren.render(h.scene, h.camera); gl.finish(); gl.readPixels(...)`）：固定高度下水平/垂直剖面，记录暗线谷值 vs 基线差值，修复后应显著收窄。
5. **2b 回归**：斜视/侧视检查 tile X 边界无新亮带（延伸过冲）；若出现，调低 MAX_TAIL（2.0）或移除 2b。
6. **性能**：fit-all 12 线全载后 FPS 应 ≥ 100（16 步是实测 166 FPS 的安全档）。
7. **回归**：单线回退路径（manifest 不可用时）正常渲染。

## 清理

删除本次调试遗留文件：`web/.diag-*.png`、`docs/update4.md`。
