# GPR 查看器：主视图其它测线"不全/断开" + GPS 地图单轨迹修复

## Context

用户新报两个问题（本会话浏览器实测定位，证据链完整）：

1. **主视图只有明星路1完整显示**，隐藏 001 后其它测线"要么看起来不全，要么看起来线路不连贯是断开的"。
2. **GPS/UTM 轨迹地图只看到一条轨迹**。

实测结论：
- 12 条测线的瓦片**其实全部能加载**（每线 92/88/69 片，desired=loaded），但 FPS 被永久卡死在 1Hz → 交互/旋转时 LOD 重载跟不上（~9片/秒）→ 线路永远停在残缺状态。**根因是默认光追步数过高卡死弱核显 GPU。**
- GPS 地图 12 条轨迹在跨轨方向只铺 ~3px，全部叠成一条。**根因是统一 fit 缩放把窄轴压扁。**

用户已确认：修复后**保持真实跨轨间距**（线间缝隙为真实测绘结果，不做合并）。

---

## 根因 A：主视图 FPS 永久卡死 → 其它测线"不全/断开"

### 证据链
- `stepsFor()`（`volumeScene.js:667-677`）默认返回 `Math.max(16, Math.min(192, Math.round(proj * 1.5)))`。fit-all 时 12 线 L3 共 1104 片，proj≈55px → 每片 37-82 步。
- 高步数下 Intel UHD 核显 GPU 进程在渲染启动后 **<1s 内卡到 1Hz，且粘滞**：之后即便把 `uSteps` 调回 16 也保持 1Hz，只能整页重载。
- 加载吞吐被 FPS 门控（`drainQueue` 每帧一次，1 FPS 时 limiter 空位 ~9/秒）→ 旋转/缩放后新 desired 瓦片永远补不上 → 线路残缺/断开。
- 决定性对照：持续压 `uSteps=16` 时 12 线全部加载后 **166 FPS**；默认步数 → 粘滞 1Hz。**根因锁定。**

### 修复
- **A1（主）`volumeScene.js stepsFor()`（667-677 行）**：降低步数曲线 + 硬上限：
  ```js
  return Math.max(8, Math.min(STEP_CAP, Math.round(proj * 0.4)));
  ```
  `STEP_CAP` 初值 **32**。
  - **实施时须经验定标**：在 12 线全载状态下逐一试 16/24/32，取能稳定 >60 FPS 的最高值再回落一级留裕量（卡死粘滞，宁低勿高）。实测 16→166FPS，24/32 预计安全。
  - 质量权衡：fit-all 时瓦片亚像素，16-24 步足够；近景被 32 步封顶，深度方向略粗但可接受（GPR 深度薄、表面反射主导）。注释里说明卡死粘滞这一坑，防后人改回。
- **A2（余量）`multiLineHost.js:31` DPR 上限**：`setPixelRatio(Math.min(window.devicePixelRatio, 2))` → `Math.min(window.devicePixelRatio, 1)`。当前 dpr=1.25 → 渲染像素降 ~36%，为弱核显多留余量，fit-all 视觉无损。（可选，若近景锐度敏感可后续放宽。）

> 无需其它改动：fit-all 已用最粗 L3（每线 92 片）；视锥剔除在 fit-all 全可见时不减片数。

---

## 根因 B：GPS 地图只有一条轨迹

### 根因
`gpsMapView.js draw()`（128-132 行）统一 fit：`s = Math.min((cw-2pad)/dE, (ch-2pad)/dN)`。实测轨迹并集 dE=50m（跨轨）、dN=2227m（沿轨）→ s≈0.068 → 50m 跨轨压成 ~3px → 12 条平行轨迹全部叠成一条。

### 修复（`gpsMapView.js draw()` 119-132 行）
把统一 `s` 换成逐轴缩放，并对**窄轴（跨轨）夸大**到图幅短边约 70%：
```js
const dE = e1 - e0 || 1, dN = n1 - n0 || 1;
const base = Math.min((cw - 2*pad) / dE, (ch - 2*pad) / dN);
let sE = base, sN = base;
if (dE < dN * 0.25)      sE = Math.max(sE, (ch * 0.7) / dE); // E 为跨轨（道路近南北向）
else if (dN < dE * 0.25) sN = Math.max(sN, (ch * 0.7) / dN); // N 为跨轨（道路近东西向）
const ox = (cw - dE * sE) / 2, oy = (ch - dN * sN) / 2;
const X = (e) => ox + (e - e0) * sE;
const Y = (n) => ch - (oy + (n - n0) * sN);
```
- 本数据集：dE=50 < dN*0.25 → sE≈0.7*ch/50 → 50m 跨轨铺满图幅短边 ~70% → 12 条线按真实跨轨相对间隔分开（~10px 级）。
- 相机黄色标记经参考线弧长→UTM→(X,Y)，跨轨夸大后仍落在对应轨迹上，无需改动。
- 夸大生效时图上加注 `跨轨 ×N`（N=round(窄轴夸大倍数)），标注为示意性夸大。
- `main.js` 无需改动（自包含启发式：窄轴即跨轨，对近直道路成立）。

---

## 关键文件
- `web/src/render/volumeScene.js` — A1 `stepsFor()`（667-677）
- `web/src/render/multiLineHost.js` — A2 DPR 上限（31 行）
- `web/src/render/gpsMapView.js` — B 跨轨夸大 `draw()`（119-132）

---

## 验证

1. **主视图**：`npm run dev` 打开 → HUD `fps` 全程 >30；12 线各自 desired=loaded（92/线）数秒内完成；隐藏 001 后其余线路各自完整连续；旋转/缩放流畅，无 1Hz 冻结。
2. **GPS 地图**：12 条平行彩色轨迹清晰分开，相机标记沿 001 移动，图上有 `跨轨 ×N` 标注；图例正常。
3. **步数定标**：12 线全载状态下依次试 STEP_CAP=16/24/32，确认最高稳定 >60 FPS 的值，回落一级留裕量。
4. **回归**：单线回退路径（无 manifest）正常；B/C-Scan 不受影响（低步数仅降低远距光追细节，无崩溃风险）；`window.__scene/__gps` 钩子可用。
