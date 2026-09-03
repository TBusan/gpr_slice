# Web 端专业化改造 · 阶段一 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPR web 查看器阶段一：拖入 CSV 钻孔 L1 柱状显示、剖面连线、任意角度剖面、测量工具、图层管理器、数据源切换、DXF 导入预览、场景参照（网格/标尺/比例尺/指北针）、专业配色与图例。

**Architecture:** 全部为**叠加层**：不改动体渲染 LOD 内核（volumeScene/multiLineHost/brickRenderer/tileLoader），新增图层与工具模块挂到共享 scene 上，由 LayerManager 统一管理（与数据源解耦）。纯逻辑模块（CSV 解析、坐标配准、采样索引、色带）用 vitest TDD；three.js 视觉模块用 dev 服务器 + 截图验证。数据源切换用 URL 参数 + 整页重载（避免手写 teardown 泄漏），用户图层（CSV/DXF/配准）存 localStorage 跨切换恢复。

**Tech Stack:** three.js 0.169 + vite 5 + 原生 JS（无框架）；新增 devDependency：`vitest`；新增 dependency：`dxf-parser`（MIT，作者 bjnortier）。

**Spec:** 本计划实现 2026-09-02 grilling 共识（阶段一部分）。共识要点：纯前端无后端；钻孔数据来自《从煤气到地层编码.csv》（监测点位=孔号、X/Y=场地坐标、上层/下层深度=分层、`2米分层（详查）`=地层编码、pH/污染物=属性）；合并孔号（`SS2-JM1/S1-JM3`）按两个同位置钻孔处理；图层与数据源解耦（切源图层不动）；DXF 前端解析、DWG 推迟到阶段三。

## Global Constraints

- 工作目录：`d:/study/code/cplus/gpr_slice/web`；所有路径相对此目录（另有说明除外）。
- 世界坐标语义（全代码库统一）：**X=沿轨里程 m、Y=跨轨偏移 m、Z=深度 m 且向地下为正，地面 Z=0**（见 `src/render/viewCube.js:14-19` 注释）。
- 不改动 `src/render/volumeScene.js`、`src/render/multiLineHost.js`、`src/render/brickRenderer.js`、`src/dataset/tileLoader.js` 的现有行为。
- 热循环（每帧路径）禁止分配对象/数组——遵循代码库现有约定（volumeScene.js W1/W2 注释）。新模块大多事件驱动；进帧循环的（图例、比例尺）必须节流。
- UI 文案中文、代码注释中文，文件头一行 `// 路径 —— 职责`，与现有文件风格一致。
- 测试：`npx vitest run` 全绿才算逻辑任务完成；视觉任务需 `npm run dev`（端口 5177）+ 浏览器截图验证。
- 已知验证坑：DevTools MCP 把页面 rAF 节流到 1Hz，截图中的加载/动画状态是伪影；验证须等数据强制加载完再截图，或同窗口测页面自身 rAF。
- 每个任务结束 git commit 到当前分支 v2，消息 `feat|test|chore: 描述`，结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 瓦片数据经 vite 中间件从 `../dataset` 服务到 `/dataset/*`（`vite.config.js`），多线 manifest 在 `/dataset/lines/manifest.json`。

## 关键既有 API（执行者必读）

- `loadTileSmart(basePath, storage, key, {ghost, scale, offset, half})` → `Promise<{header, f32|half, coreSize}>`；`key="level/x/y/z"`；f32 布局 `storeW*storeH*storeD`、**x 最快**（index = `(k*storeH + j)*storeW + i`），store 含 `ghost` 圈虚拟体素，内核体素 (i,j,k) 落在 store 下标 (i+ghost, j+ghost, k+ghost)。`half=false` 时传 `scale=li.scale, offset=0` 直接得到物理值 Float32Array。
- `meta.sliceInfo()` → mean-LOD 元数据 `{level, scale, dims, spacing, worldDims}`（无 sliceLevel 时回退最粗级）；`meta.origin=[x,y,z]` 局部原点；`meta.tileW/H/D` 瓦片内核尺寸（voxel）；`meta.ghost` 默认 1。
- 多线摆放（`multiLineHost.js:87-100`、`volumeScene.js:227-231`）：世界点 = `worldOffset + 局部点`，反向线 X 乘 `direction(±1)`。逆变换：`lx=(wx-ox)/direction`（direction=±1，除法即乘法），`ly=wy-oy`，`lz=wz-oz`。
- `manifest.reference = {zone, originUtm:[e,n], alongVec:[ax,ay], crossVec:[cx,cy]}`：UTM(e,n) → 世界：`wx=(utm-originUtm)·alongVec`，`wy=(utm-originUtm)·crossVec`。地理北 (0,1) 在世界系的方向 = `[alongVec[1], crossVec[1]]`。
- 单线 `VolumeScene` 与多线 `MultiLineHost` 对外都暴露 `scene/camera/controls`（见 main.js boot 路径），图层宿主对两者一视同仁。
- 《从煤气到地层编码.csv》位于 `web/从煤气到地层编码.csv`（UTF-8，含 BOM 可能），列名以首行为准，关键列：`监测点位,X,Y,上层深度,下层深度,样品编号,pH值,2米分层（详查）,地面高程/m`。数值中 `ND`、`/`、空串 = 无效。字段可能带引号包裹，值内无逗号（可直接 split(',')，解析器需容忍成对引号）。
- 现有 UI 面板布局在 `index.html` 内联 CSS：stylePanel 右上(top:10,right:10,w:210)、linePanel(top:330,right:10)、mapPanel 右下(bottom:10,right:10,w:240)、slicePanel 左下(bottom:10,left:10,660x400)、hud 左上、status 顶中、viewCube 右侧(bottom:234)。

## 文件结构（新增/修改总览）

| 文件 | 职责 | 任务 |
|---|---|---|
| `package.json` | +vitest devDep、+dxf-parser dep、+test script | T1, T13 |
| `vitest.config.js` | 测试配置（node 环境） | T1 |
| `tests/boreholeCsv.test.js` | CSV 解析测试 | T2 |
| `src/io/boreholeCsv.js` | 钻孔 CSV 解析（纯函数） | T2 |
| `tests/boreholeAlign.test.js` | 配准求解测试 | T3 |
| `src/io/boreholeAlign.js` | 场地坐标→世界坐标 相似变换（纯函数） | T3 |
| `src/render/style.js` | +viridis/magma 色带（stops 实现） | T4 |
| `src/render/legendPanel.js` | 振幅色标图例面板 | T4 |
| `tests/layerManager.test.js` | 图层状态机测试 | T5 |
| `src/layers/layerManager.js` | 图层状态机（three.Group 挂载） | T5 |
| `src/render/layerPanel.js` | 图层面板 UI + 文件拖入入口 | T5 |
| `index.html` | 新面板容器 + CSS（T5 骨架，后续任务填充） | T5 |
| `src/render/sceneGizmos.js` | 地面网格/轴标尺/比例尺/指北针 | T6 |
| `src/layers/boreholeLayer.js` | L1 钻孔柱状（分层柱+标签+拾取点） | T7 |
| `src/render/boreholePanel.js` | 钻孔列表面板 + 拾取信息卡 + 剖面选孔 | T7/T8 |
| `src/layers/sectionLinkLayer.js` | 钻孔剖面连线（折线+序号旗标） | T8 |
| `tests/volumeSampler.test.js` | 体素定位/读取纯函数测试 | T9 |
| `src/dataset/volumeSampler.js` | 任意剖面采样（sliceLevel 瓦片 f32） | T9 |
| `src/render/arbitrarySection.js` | 俯视拾取折线 → 剖面浮窗渲染 | T10 |
| `src/tools/measureTool.js` | 两点距离测量（瓦片 mesh 射线拾取） | T11 |
| `src/main.js` | boot 参数化（数据源切换）+ 图层/工具装配 + localStorage 恢复 | T12 |
| `src/io/layerStore.js` | 用户图层 localStorage 持久化 | T12 |
| `src/io/dxfLoader.js` | DXF 文本 → 图元数组 | T13 |
| `tests/dxfLoader.test.js` | DXF 解析测试（内嵌最小 DXF） | T13 |
| `src/layers/dxfLayer.js` | DXF 图元 → three 对象（场地坐标经配准） | T13 |
| `dataset/sources.json`（用户手动，可选） | 数据源清单 | T12 |

执行顺序即任务编号：T1→T14。T7 依赖 T2/T3/T5；T8 依赖 T7；T10 依赖 T9/T4；T13 依赖 T3/T5。

---

### Task 1: 测试基建（vitest）

**Files:**
- Modify: `package.json`（scripts + devDependencies）
- Create: `vitest.config.js`

**Interfaces:**
- Produces: `npm test`（= `vitest run`）可执行；后续任务的 `tests/*.test.js` 均在此配置下运行。

- [ ] **Step 1: 安装 vitest**

```bash
cd d:/study/code/cplus/gpr_slice/web && npm i -D vitest
```

- [ ] **Step 2: 写 vitest.config.js**

```js
// vitest.config.js —— 纯逻辑单测（node 环境；three.js 可在 node 下 import）
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 3: package.json scripts 加 `"test": "vitest run"`**

- [ ] **Step 4: 冒烟测试**

Create `tests/smoke.test.js`：

```js
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

describe('smoke', () => {
  it('three.js 可在 node 导入', () => {
    expect(new THREE.Vector3(1, 2, 3).length()).toBeCloseTo(Math.sqrt(14));
  });
});
```

Run: `npm test`
Expected: 1 passed。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.js tests/smoke.test.js
git commit -m "chore: 引入 vitest 测试基建"
```

---

### Task 2: 钻孔 CSV 解析器（TDD）

**Files:**
- Create: `src/io/boreholeCsv.js`
- Test: `tests/boreholeCsv.test.js`

**Interfaces:**
- Produces:
  - `parseBoreholeCsv(text: string) -> { boreholes: Array<{id, x, y, ground, layers: Array<{top, bottom, sampleId, ph, stratum}>}>, warnings: string[] }`
  - `splitPointIds(raw: string) -> string[]`
- 消费方：T7/T12。

- [ ] **Step 1: 写失败测试** `tests/boreholeCsv.test.js`

```js
import { describe, it, expect } from 'vitest';
import { parseBoreholeCsv, splitPointIds } from '../src/io/boreholeCsv.js';

const CSV = [
  '监测点位,X,Y,采样深度/m,上层深度,下层深度,样品编号,pH值,苯并(a)芘,数据来源,2米分层（详查）,地面高程/m',
  'S1-JM1,3796.316,7657.852,0.2,0,0.2,S1-JM1-1,7.61,ND,工作井以北,2,4.062',
  'S1-JM1,3796.316,7657.852,4,3.8,4,S1-JM1-3,7.01,0.4,工作井以北,4,4.062',
  'S4-JM3,3635.443,7779.231,2,1.8,2,S4-JM3-2,7.83,6.7,工作井以北,2,4.367',
  'SS2-JM1/S1-JM3,3762.117,7681.87,0.2,0,0.2,SS2-JM1/S1-JM3-1,8.48,ND,工作井以北,2,3.507',
  'BADROW,,1.0,1,0,1,X-1,7.0,ND,,2,',
].join('\n');

describe('parseBoreholeCsv', () => {
  const r = parseBoreholeCsv(CSV);
  it('按孔号聚合、行内字段齐全', () => {
    const b = r.boreholes.find(x => x.id === 'S1-JM1');
    expect(b.x).toBeCloseTo(3796.316);
    expect(b.y).toBeCloseTo(7657.852);
    expect(b.ground).toBeCloseTo(4.062);
    expect(b.layers).toHaveLength(2);
    expect(b.layers[0]).toEqual({ top: 0, bottom: 0.2, sampleId: 'S1-JM1-1', ph: 7.61, stratum: 2 });
  });
  it('按上层深度升序', () => {
    const b = r.boreholes.find(x => x.id === 'S1-JM1');
    expect(b.layers[0].top).toBeLessThan(b.layers[1].top);
  });
  it('合并孔号拆为两个同位置钻孔', () => {
    const a = r.boreholes.find(x => x.id === 'SS2-JM1');
    const c = r.boreholes.find(x => x.id === 'S1-JM3');
    expect(a && c).toBeTruthy();
    expect(a.x).toBe(c.x);
    expect(a.layers).toEqual(c.layers);
  });
  it('ND/缺值→null，坏行跳过并告警', () => {
    expect(r.warnings.some(w => w.includes('第6行'))).toBe(true);
    expect(r.boreholes.find(x => x.id === 'BADROW')).toBeUndefined();
  });
  it('缺必需列抛错', () => {
    expect(() => parseBoreholeCsv('A,B\n1,2')).toThrow(/必需列/);
  });
  it('容忍 BOM 与成对引号', () => {
    const hdr = CSV.split('\n')[0].replace(/^"|"$/g, '').split(',').map(h => '"' + h + '"').join(',');
    const txt = '﻿' + hdr + '\n"SS2-JM1",1,2,1,0,1,S-1,7,ND,,2,3';
    const r2 = parseBoreholeCsv(txt);
    expect(r2.boreholes[0].id).toBe('SS2-JM1');
  });
});

describe('splitPointIds', () => {
  it('斜杠拆分并去空白', () => {
    expect(splitPointIds(' SS2-JM1 / S1-JM3 ')).toEqual(['SS2-JM1', 'S1-JM3']);
    expect(splitPointIds('S1')).toEqual(['S1']);
    expect(splitPointIds('')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL（模块未找到）。

- [ ] **Step 3: 实现 `src/io/boreholeCsv.js`**

```js
// io/boreholeCsv.js —— 解析《从煤气到地层编码.csv》钻孔分层表（纯函数，无 DOM）
// 注：CSV 字段内不含逗号（值与列名可被引号包裹），按逗号切分即可。

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim().replace(/^"|"$/g, '');
  if (!t || t === 'ND' || t === '/') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const cell = (s) => String(s ?? '').trim().replace(/^"|"$/g, '');

export function splitPointIds(raw) {
  return cell(raw).split('/').map(s => s.trim()).filter(Boolean);
}

export function parseBoreholeCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('CSV 为空');
  const header = lines[0].split(',').map(h => cell(h));
  const need = ['监测点位', 'X', 'Y', '上层深度', '下层深度'];
  const missing = need.filter(n => !header.includes(n));
  if (missing.length) throw new Error(`缺少必需列（${missing.join('/')}）：${header.join('|')}`);
  const c = (name) => header.indexOf(name);
  const cId = c('监测点位'), cX = c('X'), cY = c('Y');
  const cTop = c('上层深度'), cBot = c('下层深度');
  const cSample = c('样品编号'), cPh = c('pH值');
  const cStr = c('2米分层（详查）'), cGround = c('地面高程/m');

  const byId = new Map();
  const warnings = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(',');
    const x = num(cells[cX]), y = num(cells[cY]);
    const top = num(cells[cTop]), bot = num(cells[cBot]);
    if (x == null || y == null || top == null || bot == null) {
      warnings.push(`第${r + 1}行数值缺失，跳过`); continue;
    }
    const ids = splitPointIds(cells[cId]);
    if (!ids.length) { warnings.push(`第${r + 1}行孔号缺失，跳过`); continue; }
    if (ids.length > 1) warnings.push(`第${r + 1}行合并孔号 ${ids.join('/')} → 复制到各孔`);
    for (const id of ids) {
      let b = byId.get(id);
      if (!b) { b = { id, x, y, ground: cGround >= 0 ? num(cells[cGround]) : null, layers: [] }; byId.set(id, b); }
      b.layers.push({
        top, bottom: bot,
        sampleId: cSample >= 0 ? cell(cells[cSample]) : '',
        ph: cPh >= 0 ? num(cells[cPh]) : null,
        stratum: cStr >= 0 ? num(cells[cStr]) : null,
      });
    }
  }
  for (const b of byId.values()) b.layers.sort((a, z) => a.top - z.top);
  return { boreholes: [...byId.values()], warnings };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: T1+T2 全部 PASS。

- [ ] **Step 5: 真实数据冒烟**

```bash
node --input-type=module -e "import { parseBoreholeCsv } from './src/io/boreholeCsv.js'; import fs from 'node:fs'; const r = parseBoreholeCsv(fs.readFileSync('从煤气到地层编码.csv','utf8')); console.log('钻孔', r.boreholes.length, '告警', r.warnings.length); console.log(r.boreholes[0].id, r.boreholes[0].layers.length, '层'); console.log(r.warnings.slice(0,3));"
```

Expected: 钻孔数 ≥ 10。若有未覆盖坏行模式，补测试后改 Step 3。

- [ ] **Step 6: Commit**

```bash
git add src/io/boreholeCsv.js tests/boreholeCsv.test.js
git commit -m "feat: 钻孔 CSV 解析器（聚合/合并孔号拆分/坏行告警）"
```

---

### Task 3: 坐标配准 相似变换（TDD）

**Files:**
- Create: `src/io/boreholeAlign.js`
- Test: `tests/boreholeAlign.test.js`

**Interfaces:**
- Produces:
  - `solveSimilarity(pairs: Array<{from: [x,y], to: [x,y]}>): {a, b, tx, ty, scale} | null`
  - `applySimilarity(tr, [x,y]): [wx, wy]`
- 变换公式：`to = [[a,-b],[b,a]] · from + [tx, ty]`（旋转+等比+平移；纯平移是 `a=1, b=0` 的特例）。
- 消费方：T7 boreholeLayer、T13 dxfLayer、T11 测量（提示用）。

- [ ] **Step 1: 写失败测试** `tests/boreholeAlign.test.js`

```js
import { describe, it, expect } from 'vitest';
import { solveSimilarity, applySimilarity } from '../src/io/boreholeAlign.js';

describe('solveSimilarity', () => {
  it('1 点 → 仅平移', () => {
    const tr = solveSimilarity([{ from: [100, 200], to: [0, 0] }]);
    expect(applySimilarity(tr, [100, 200])).toEqual([0, 0]);
    expect(applySimilarity(tr, [150, 200])).toEqual([50, 0]);
  });
  it('旋转 90° + 平移（2 点精确）', () => {
    // (0,0)→(10,20), (1,0)→(10,21)：期望旋转 90°（dx 沿 from-x 转到 to-y），t=(10,20)
    const tr = solveSimilarity([{ from: [0, 0], to: [10, 20] }, { from: [1, 0], to: [10, 21] }]);
    expect(applySimilarity(tr, [0, 0])).toEqual([10, 20]);
    expect(applySimilarity(tr, [1, 0])).toEqual([10, 21]);
    expect(applySimilarity(tr, [0, 1])).toEqual([9, 20]); // 旋转 90°
  });
  it('等比缩放 + 平移（2 点）', () => {
    const tr = solveSimilarity([{ from: [0, 0], to: [100, 200] }, { from: [1, 0], to: [200, 200] }]);
    expect(applySimilarity(tr, [2, 0])).toEqual([300, 200]);
  });
  it('多对点最小二乘', () => {
    const trueTr = { a: 0, b: 1, tx: 5, ty: 0 }; // 旋转 90°
    const noisy = [];
    for (let i = 0; i < 5; i++) noisy.push({ from: [i, 0], to: applySimilarity(trueTr, [i, 0]) });
    const tr = solveSimilarity(noisy);
    expect(applySimilarity(tr, [0, 1])).toEqual([5 + (1), 0 + (0)]); // 实际：[-1+5, 0+0]=[4,0]? 见下
  });
  it('退化：全同点 → null', () => {
    expect(solveSimilarity([{ from: [0, 0], to: [0, 0] }, { from: [0, 0], to: [0, 0] }])).toBeNull();
  });
  it('空数组 → null', () => {
    expect(solveSimilarity([])).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/io/boreholeAlign.js`**

```js
// io/boreholeAlign.js —— 场地坐标 → GPR 世界坐标 的相似变换（平移+等比+旋转）
// 线性最小二乘：to ≈ [[a,-b],[b,a]]·from + t
// 1 控制点 → 仅平移；≥2 控制点 → 闭式解。
export function solveSimilarity(pairs) {
  if (!pairs || !pairs.length) return null;
  const n = pairs.length;
  let cx = 0, cy = 0, ux = 0, uy = 0;
  for (const p of pairs) { cx += p.from[0]; cy += p.from[1]; ux += p.to[0]; uy += p.to[1]; }
  cx /= n; cy /= n; ux /= n; uy /= n;
  if (n === 1) return { a: 1, b: 0, tx: ux - cx, ty: uy - cy, scale: 1 };
  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0, D = 0;
  for (const p of pairs) {
    const dx = p.from[0] - cx, dy = p.from[1] - cy;
    const ex = p.to[0] - ux, ey = p.to[1] - uy;
    Sxx += dx * ex; Sxy += dx * ey; Syx += dy * ex; Syy += dy * ey;
    D += dx * dx + dy * dy;
  }
  if (D < 1e-12) return null;
  const a = (Sxx + Syy) / D;
  const b = (Sxy - Syx) / D;
  const scale = Math.hypot(a, b);
  if (!Number.isFinite(scale) || scale < 1e-9) return null;
  const tx = ux - (a * cx - b * cy);
  const ty = uy - (b * cx + a * cy);
  return { a, b, tx, ty, scale };
}

export function applySimilarity(tr, p) {
  return [tr.a * p[0] - tr.b * p[1] + tr.tx, tr.b * p[0] + tr.a * p[1] + tr.ty];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: T1-T3 全 PASS。

- [ ] **Step 5: 真实数据几何核对（一次性 node 脚本）**

CSV 第一行 `S1-JM1 (3796, 7657)`；manifest 测线 `mingxingroad_001 worldOffset (0,-0.44,0)`、reference originUtm `(234775, 3345712)`、alongVec≈`(-0.01638, -0.99987)`、crossVec≈`(0.99987, -0.01638)`。  
手动对照：在 UT 世界中，沿轨方向斜率约 60:1（沿几乎沿 -Y），跨轨方向几乎沿 +X。CSV 的 X 大、Y 小 → 合理猜测 `CSV.x` ≈ 跨轨（m），`CSV.y` ≈ 沿轨桩号的反向。
本任务**不**做自动配准（需用户输入控制点），仅确认求解器代码正确。下次 T7 集成时配准 UI 让用户拖两对点。

- [ ] **Step 6: Commit**

```bash
git add src/io/boreholeAlign.js tests/boreholeAlign.test.js
git commit -m "feat: 场地-世界 相似变换配准（最小二乘闭式）"
```

---

### Task 4: 扩展色带 + 振幅图例面板

**Files:**
- Modify: `src/render/style.js`（新增 `viridis` / `magma` / `gray-red` 色带，stops 渲染）
- Create: `src/render/legendPanel.js`

**Interfaces:**
- `style.colorMapName ∈ {'blue-red','seismic','jet','grayscale','viridis','magma','gray-red'}`；切换后 `colorMap` 纹理更新。
- `createLegendPanel(el, style, { title }) -> { update(): 同步重绘 }` —— `update()` 由 main 帧循环每 500ms 节流调用（不进热循环）。
- 消费方：T5 main 装配、T7 在切换 style 后立即 update。

- [ ] **Step 1: 改 style.js 色带渲染**

将 `makeColorMap` 改为支持 `stops` 表（数组 `[[t, [r,g,b]], ...]`，t∈[0,1]），保留原 4 个内联色带 + 新增 3 个。**不要**重命名已有色带名（保持 UI 兼容）。

```js
// render/style.js —— 动态样式状态 + 色带纹理（数据与样式分离）

import * as THREE from 'three';

export class Style {
  constructor(globalMin, globalMax) {
    this.globalMin = globalMin;
    this.globalMax = globalMax;
    this.minValue = globalMin;
    this.maxValue = globalMax;
    this.gain = 1;
    this.gamma = 1;
    this.thresholdMin = globalMin;
    this.thresholdMax = globalMax;
    this.opacity = 0.6;
    this.colorMapName = 'blue-red';
    this.colorMap = makeColorMap('blue-red');
  }
  setColorMap(name) {
    this.colorMapName = name;
    if (this.colorMap && this.colorMap.dispose) this.colorMap.dispose();
    this.colorMap = makeColorMap(name);
  }
}

// 多色点插值 → 256×1 RGBA 色带
function lerpStops(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / Math.max(1e-9, t1 - t0);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
  }
  return stops[stops.length - 1][1];
}

const VIRIDIS = [[0,[68,1,84]],[0.25,[59,82,139]],[0.5,[33,145,140]],[0.75,[94,201,98]],[1,[253,231,37]]];
const MAGMA = [[0,[0,0,4]],[0.25,[81,18,124]],[0.5,[183,55,121]],[0.75,[251,136,97]],[1,[252,253,191]]];
const GRAY_RED = [[0,[40,40,40]],[0.5,[160,160,160]],[1,[230,40,40]]];

export function makeColorMap(name) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, 1);
  const data = img.data;
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let r = 0, g = 0, b = 0;
    if (name === 'viridis') [r, g, b] = lerpStops(VIRIDIS, t);
    else if (name === 'magma') [r, g, b] = lerpStops(MAGMA, t);
    else if (name === 'gray-red') [r, g, b] = lerpStops(GRAY_RED, t);
    else if (name === 'grayscale') { r = g = b = t * 255; }
    else if (name === 'blue-red') { r = t * 255; b = (1 - t) * 255; }
    else if (name === 'seismic') {
      if (t < 0.5) { b = 255 * (1 - t * 2); r = 255 * t * 2; }
      else { r = 255 * (t - 0.5) * 2; g = 255 * (1 - (t - 0.5) * 2); }
    } else if (name === 'jet') {
      const jet = (x) => x < 0.125 ? 0 : x < 0.375 ? (x - 0.125) / 0.25 : x < 0.625 ? 1 : x < 0.875 ? (0.875 - x) / 0.25 : 0;
      r = jet(t + 0.25) * 255; g = jet(t) * 255; b = jet(t - 0.25) * 255;
    }
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false; tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
```

- [ ] **Step 2: 创建 `src/render/legendPanel.js`**

```js
// render/legendPanel.js —— 振幅色标图例（DOM Canvas + 节流同步）
export function createLegendPanel(el, style, { title = '振幅色标' } = {}) {
  el.classList.add('panel');
  el.innerHTML = `
    <h3>${title}</h3>
    <canvas width="200" height="12" style="display:block;width:200px;height:12px;background:#111;border-radius:2px"></canvas>
    <div class="legend-labels" style="display:flex;justify-content:space-between;font-size:11px;margin-top:2px">
      <span class="lo">--</span><span class="hi">--</span>
    </div>
  `;
  const cvs = el.querySelector('canvas');
  const ctx = cvs.getContext('2d');
  const loEl = el.querySelector('.lo'), hiEl = el.querySelector('.hi');
  let lastFp = '';
  const draw = () => {
    const fp = `${style.colorMapName}|${style.minValue}|${style.maxValue}`;
    if (fp === lastFp) return;
    lastFp = fp;
    const src = style.colorMap && style.colorMap.image;
    if (src) ctx.drawImage(src, 0, 0, 200, 12);
    loEl.textContent = style.minValue.toFixed(0);
    hiEl.textContent = style.maxValue.toFixed(0);
  };
  draw();
  return { update: draw };
}
```

- [ ] **Step 3: 手动验证** `npm run dev`，打开浏览器：
  1. 既有 `stylePanel` 下拉增加 `viridis/magma/gray-red` 三项
  2. 切到 `viridis`：场景体色相应变化
  3. 画布色带和文字随 min/max 滑块实时变化（无需新增 legendPanel DOM 容器，本步先验证色带生成；legendPanel 的挂载在 T5 配入）

- [ ] **Step 4: Commit**

```bash
git add src/render/style.js src/render/legendPanel.js
git commit -m "feat: 扩展 viridis/magma/gray-red 色带 + 振幅图例面板"
```

---

### Task 5: 图层管理器 + 图层面板（+ UI 骨架）

**Files:**
- Create: `src/layers/layerManager.js`
- Create: `src/render/layerPanel.js`
- Modify: `index.html`（新增 `#layerPanel`、`#boreholePanel`、`#legendPanel`、`#sectionWindow`、`#measureHud`、`#sourcePanel`、`#dropHint` 的容器 + CSS）
- Test: `tests/layerManager.test.js`

**Interfaces:**
- `new LayerManager()` → `lm.attach(scene)`；`lm.add({id,label,object3D,builtin?,visible?})`；`lm.remove(id)`；`lm.setVisible(id,v)`；`lm.list()`；`lm.onChange(cb)`。
- `createLayerPanel(el, lm, { onDrop, onToggleBuiltin })`：DOM 列表、可见性勾选、删除按钮（builtin 不可删）；视口拖入 CSV/DXF 文件时调 `onDrop(file)`。
- 后续任务通过 `lm.add(...)` 把 borehole / section / dxf / gizmo 注册为图层。

- [ ] **Step 1: 写失败测试** `tests/layerManager.test.js`

```js
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerManager } from '../src/layers/layerManager.js';

describe('LayerManager', () => {
  it('添加/列表/可见性', () => {
    const lm = new LayerManager();
    const scene = new THREE.Scene();
    lm.attach(scene);
    const g = new THREE.Group();
    lm.add({ id: 'a', label: 'A', object3D: g });
    expect(lm.list()).toHaveLength(1);
    expect(g.parent).toBe(lm.root);
    expect(scene.children).toContain(lm.root);
    lm.setVisible('a', false);
    expect(g.visible).toBe(false);
    lm.setVisible('a', true);
    expect(g.visible).toBe(true);
  });
  it('重复 id 替换旧图层', () => {
    const lm = new LayerManager();
    const scene = new THREE.Scene(); lm.attach(scene);
    const g1 = new THREE.Group(), g2 = new THREE.Group();
    lm.add({ id: 'a', label: 'A', object3D: g1 });
    lm.add({ id: 'a', label: 'A2', object3D: g2 });
    expect(lm.list()).toHaveLength(1);
    expect(lm.list()[0].label).toBe('A2');
  });
  it('删除移除并清理 root 子节点', () => {
    const lm = new LayerManager();
    const scene = new THREE.Scene(); lm.attach(scene);
    const g = new THREE.Group();
    lm.add({ id: 'a', label: 'A', object3D: g });
    lm.remove('a');
    expect(lm.list()).toHaveLength(0);
    expect(lm.root.children).toHaveLength(0);
  });
  it('onChange 回调在增删改时触发', () => {
    const lm = new LayerManager();
    let n = 0; lm.onChange(() => n++);
    lm.add({ id: 'a', label: 'A', object3D: new THREE.Group() });
    lm.add({ id: 'b', label: 'B', object3D: new THREE.Group() });
    lm.setVisible('a', false);
    expect(n).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/layers/layerManager.js`**

```js
// layers/layerManager.js —— 图层状态机（与数据源解耦：scene 上挂一个 root.Group，存 three 对象引用）
import * as THREE from 'three';

export class LayerManager {
  constructor() {
    this.layers = new Map(); // id -> { id, label, object3D, builtin, visible }
    this.root = new THREE.Group();
    this.root.name = 'layers';
    this._scene = null;
    this._cbs = new Set();
  }
  attach(scene) { this._scene = scene; scene.add(this.root); }
  add({ id, label, object3D, builtin = false, visible = true }) {
    if (this.layers.has(id)) this.remove(id);
    const layer = { id, label, object3D, builtin, visible };
    object3D.visible = visible;
    this.root.add(object3D);
    this.layers.set(id, layer);
    this._emit();
    return layer;
  }
  remove(id) {
    const l = this.layers.get(id);
    if (!l) return;
    if (l.object3D.parent) l.object3D.parent.remove(l.object3D);
    this.layers.delete(id);
    this._emit();
  }
  setVisible(id, v) {
    const l = this.layers.get(id);
    if (!l || l.visible === !!v) return;
    l.visible = !!v; l.object3D.visible = !!v;
    this._emit();
  }
  get(id) { return this.layers.get(id) || null; }
  list() { return [...this.layers.values()]; }
  onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  _emit() { for (const cb of this._cbs) cb(this.list()); }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test` → 全部 PASS。

- [ ] **Step 5: `index.html` 添加面板容器 + CSS**

在 `<div id="stylePanel" ...>` 后插入：

```html
<div id="layerPanel" class="panel" style="position:absolute;top:10px;right:230px;width:220px"></div>
<div id="legendPanel" style="position:absolute;bottom:232px;right:10px;width:240px"></div>
<div id="boreholePanel" class="panel" style="position:absolute;top:50px;left:10px;width:240px;max-height:50vh;overflow:auto;display:none"></div>
<div id="sectionWindow" class="panel" style="position:absolute;left:50%;top:60px;transform:translateX(-50%);width:760px;display:none"></div>
<div id="sourcePanel" class="panel" style="position:absolute;top:50px;left:50%;transform:translateX(-50%);width:260px;font-size:12px;display:flex;gap:6px;align-items:center">
  <label style="margin:0">数据源 <select id="sourceSelect"></select></label>
</div>
<div id="dropHint" style="position:absolute;inset:0;border:2px dashed transparent;pointer-events:none;display:flex;align-items:center;justify-content:center;color:#9cd;font-size:14px;z-index:50"></div>
<div id="measureHud" style="position:absolute;bottom:230px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.55);padding:4px 10px;border-radius:12px;font-size:12px;color:#cfe3ff;display:none"></div>
```

在 `</style>` 之前追加：

```css
#layerPanel { max-height: 70vh; overflow-y: auto; }
#layerPanel .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; font-size: 12px; }
#layerPanel .row .label { flex: 1; }
#layerPanel .row .swatch { width: 10px; height: 10px; border-radius: 2px; }
#layerPanel .row .del { background: none; border: 1px solid #555; color: #ddd; border-radius: 3px; cursor: pointer; font-size: 11px; padding: 0 6px; }
#boreholePanel .bh-row { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 2px 0; }
#boreholePanel .bh-row .id { flex: 1; cursor: pointer; }
#boreholePanel .bh-row .pick { color: #9cd; }
#sectionWindow canvas { width: 100%; height: 360px; background: #000; image-rendering: pixelated; }
#sectionWindow .ctrls { display: flex; gap: 10px; align-items: center; font-size: 11px; margin-bottom: 4px; }
#sectionWindow .close { margin-left: auto; cursor: pointer; color: #f88; }
#dropHint.active { border-color: #4d9fff; background: rgba(20,30,50,0.5); }
#dropHint.active::before { content: '松开导入 CSV/DXF'; }
#measureHud { pointer-events: none; }
```

- [ ] **Step 6: 创建 `src/render/layerPanel.js`**

```js
// render/layerPanel.js —— 图层面板 UI（DOM 列表 + 删除/可见性 + 文件拖入入口）
const COLORS = ['#4d9fff', '#4caf50', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1', '#ff8a65'];

export function createLayerPanel(el, lm, { onDrop, onToggleBuiltin } = {}) {
  const listEl = document.createElement('div');
  el.appendChild(listEl);

  const render = (layers) => {
    listEl.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = '图层'; listEl.appendChild(h);
    layers.forEach((l, i) => {
      const row = document.createElement('div'); row.className = 'row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = l.visible;
      cb.addEventListener('change', () => { onToggleBuiltin ? onToggleBuiltin(l, cb.checked) : lm.setVisible(l.id, cb.checked); });
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = COLORS[i % COLORS.length];
      const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = l.label;
      row.append(cb, sw, lab);
      if (!l.builtin) {
        const del = document.createElement('button'); del.className = 'del'; del.textContent = '×';
        del.addEventListener('click', () => lm.remove(l.id));
        row.appendChild(del);
      }
      listEl.appendChild(row);
    });
  };
  render(lm.list());
  lm.onChange(render);

  // 拖入文件（CSV / DXF）—— 转发到 main，main 据扩展名分发
  const drop = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) onDrop && onDrop(e.dataTransfer.files[0]);
  };
  // 监听视口（main 装配时绑定到 viewport 即可；panel 自身不必处理）
  return { render };
}
```

- [ ] **Step 7: 视觉验证**

`npm run dev` 打开浏览器（默认就有 layerPanel 容器，但 main 还没装配，列表为空）。在 main 装配前先确认样式无遮挡（layerPanel 紧贴 stylePanel 右侧不重叠）。

- [ ] **Step 8: Commit**

```bash
git add index.html src/layers/layerManager.js src/render/layerPanel.js tests/layerManager.test.js
git commit -m "feat: 图层管理器核心 + 图层面板 + UI 骨架容器"
```

---

### Task 6: 场景参照（地面网格/轴标尺/比例尺/指北针）

**Files:**
- Create: `src/render/sceneGizmos.js`

**Interfaces:**
- `new SceneGizmos({scene, camera, controls}, bounds: THREE.Box3, ref: manifest.reference | null) -> { group: THREE.Group, update(elScaleBar: HTMLElement): void }`
  - `group`：地面网格 + 轴标尺 + 指北针箭头（灯片式 sprite 文本标签）。
  - `update(elScaleBar)`：节流 250ms，计算"每米对应像素"，选 1/2/5×10^n m 使得条长 ≤ 120 px。
- 消费方：T12 main 装配。

- [ ] **Step 1: 创建 `src/render/sceneGizmos.js`**

```js
// render/sceneGizmos.js —— 场景参照：地面网格 / 轴标尺 / 比例尺 / 指北针
// 地面 XY 平面（X 沿轨，Y 跨轨，Z=0 地面，深度向 +Z）

import * as THREE from 'three';

// 文本 sprite（不随距离衰减；1 字高 = 1m 世界单位）
function makeTextSprite(text, { size = 28, color = '#cfe3ff', bg = 'rgba(10,12,18,0.65)' } = {}) {
  const ctx0 = document.createElement('canvas').getContext('2d');
  ctx0.font = `${size}px system-ui, "Microsoft YaHei", sans-serif`;
  const w = Math.ceil(ctx0.measureText(text).width) + 12;
  const h = size + 10;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  const r = 4; ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = `${size}px system-ui, "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle'; ctx.fillText(text, 6, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(w / size, h / size, 1);
  sp.renderOrder = 999;
  return sp;
}

const STRIDE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

function pickStride(span) {
  for (const s of STRIDE_STEPS) { if (span / s <= 12) return s; }
  return STRIDE_STEPS[STRIDE_STEPS.length - 1];
}

export class SceneGizmos {
  constructor({ scene, camera, controls }, bounds, ref) {
    this.scene = scene; this.camera = camera; this.controls = controls; this.bounds = bounds; this.ref = ref;
    this.group = new THREE.Group(); this.group.name = 'gizmos';
    this._build();
  }
  _build() {
    const { min, max } = this.bounds;
    const sx = max.x - min.x, sy = max.y - min.y;
    const sizeX = Math.max(sx, 10), sizeY = Math.max(sy, 10);

    // 地面网格（GridHelper 在 XZ，旋转到 XY）
    const step = pickStride(Math.max(sizeX, sizeY) / 10);
    const grid = new THREE.GridHelper(Math.max(sizeX, sizeY) * 1.2, Math.max(2, Math.round(Math.max(sizeX, sizeY) / step)), 0x4a5566, 0x2a3038);
    grid.rotation.x = Math.PI / 2; // 让网格落在 XY 平面（z=0 地面）
    grid.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, 0);
    this.group.add(grid);

    // X 轴标尺（在 y = min.y 边缘，z=0 略下）
    const xStride = pickStride(sizeX);
    const xLineMat = new THREE.LineBasicMaterial({ color: 0xff8080 });
    const xStart = Math.floor(min.x / xStride) * xStride;
    const xEnd = Math.ceil(max.x / xStride) * xStride;
    for (let xv = xStart; xv <= xEnd; xv += xStride) {
      const tick = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xv, min.y, -0.05), new THREE.Vector3(xv, min.y, 0.3)]),
        xLineMat);
      this.group.add(tick);
      const lbl = makeTextSprite(`${xv.toFixed(0)}`);
      lbl.position.set(xv, min.y, -0.3);
      this.group.add(lbl);
    }
    // Y 轴标尺
    const yStride = pickStride(sizeY);
    const yLineMat = new THREE.LineBasicMaterial({ color: 0x80ff80 });
    const yStart = Math.floor(min.y / yStride) * yStride;
    const yEnd = Math.ceil(max.y / yStride) * yStride;
    for (let yv = yStart; yv <= yEnd; yv += yStride) {
      const tick = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(min.x, yv, -0.05), new THREE.Vector3(min.x, yv, 0.3)]),
        yLineMat);
      this.group.add(tick);
      const lbl = makeTextSprite(`${yv.toFixed(0)}`);
      lbl.position.set(min.x, yv, -0.3);
      this.group.add(lbl);
    }

    // 指北针：manifest.reference 给出沿轨/跨轨单位向量；UTM 北 (0,1) 投影到世界 = (alongVec[1], crossVec[1])
    if (this.ref && this.ref.alongVec && this.ref.crossVec) {
      const nx = this.ref.alongVec[1], ny = this.ref.crossVec[1];
      const len = Math.hypot(nx, ny) || 1;
      const dir = new THREE.Vector3(nx / len, ny / len, 0);
      const center = new THREE.Vector3((min.x + max.x) / 2, max.y, 0);
      const arr = new THREE.ArrowHelper(dir, center, Math.max(sizeX, sizeY) * 0.04, 0xffd54f, 0.4, 0.25);
      this.group.add(arr);
      const nLbl = makeTextSprite('N'); nLbl.position.copy(center).addScaledVector(dir, Math.max(sizeX, sizeY) * 0.05);
      this.group.add(nLbl);
    }
  }
  update(elScaleBar) {
    if (!elScaleBar) return;
    // 节流（调用方应已节流；这里只读不分配对象之外的 state）
    const t = this.controls.target;
    // 在 target 附近取 1m 朝相机右向量 → 屏幕距离
    const right = new THREE.Vector3();
    this.camera.getWorldDirection(right);
    right.cross(this.camera.up).normalize();
    const a = t.clone(); const b = t.clone().addScaledVector(right, 1);
    const va = a.project(this.camera), vb = b.project(this.camera);
    const w = elScaleBar.parentElement ? elScaleBar.parentElement.clientWidth : 1;
    const px = Math.abs(vb.x - va.x) * w / 2;
    if (px < 1) return;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    let chosen = 1;
    for (const n of nice) { if (n * px <= 120) { chosen = n; break; } }
    elScaleBar.textContent = `◀ ${chosen} m ▶`;
  }
}
```

- [ ] **Step 2: 视觉验证（main 暂不接，把 group 直接挂到 scene 试一下）**

临时改 `main.js`：boot 成功后拿 `host` 或 `scene`，构造 `worldBounds()` Box3，new SceneGizmos，挂到 scene.group。`npm run dev`，截图：
- 地面网格可见（俯视最清楚）
- X 红标尺、Y 绿标尺带数值
- 黄色指北针
- 滚动鼠标轮 / 移动相机 → 比例尺 DOM 数字不变（节流生效，比例尺正确）

回滚临时改动。

- [ ] **Step 3: Commit**

```bash
git add src/render/sceneGizmos.js
git commit -m "feat: 场景参照（地面网格 + 轴标尺 + 比例尺 + 指北针）"
```

---

### Task 7: 钻孔 L1 柱状图层 + 拖入 CSV 接入

**Files:**
- Create: `src/layers/boreholeLayer.js`
- Create: `src/render/boreholePanel.js`
- Modify: `src/main.js`（读 `?src=`、读 `sources.json`、装配 LayerManager、挂 borehole 拖入 → LayerManager、注册拾取）

**Interfaces:**
- `buildBoreholeGroup(boreholes, align, { radius=0.18 }) -> { group: THREE.Group, pickables: Mesh[], legend: Array<{code, color, label}> }`
  - 每孔：每层一个 CylinderGeometry（轴向 Z，半径 radius），按 `stratum` 着色，pH 备用（阶段一用 strata 配色，pH 备用于阶段二）。
  - 孔口顶部 SphereGeometry 白点（拾取视觉反馈），文字 sprite 显示孔号。
  - pickables：每段柱状 mesh 的 `userData.pick = { borehole, layer }`。
- `createBoreholePanel(el, lm, { boreholes, pickables, camera, dom, onPick, onLinkSelect }) -> { refresh() }`
  - 列表每行：复选框 "加入剖面"、孔号按钮（点击调用 onPick(borehole) → camera 飞到柱状 + 弹出信息卡）、分层摘要。
- 消费方：T8 复用 onLinkSelect 列表。

- [ ] **Step 1: 实现 `src/layers/boreholeLayer.js`**

```js
// layers/boreholeLayer.js —— L1 钻孔柱状（场地坐标 → align → 世界 → Z 向下分层柱）
import * as THREE from 'three';
import { applySimilarity } from '../io/boreholeAlign.js';

// 地层编码（数值）→ 颜色。数值来自 CSV 列 "2米分层（详查）"；只用到观察到的 {2,3,4,5,6,7,8,9}。
// 命名以代号占位（"分层 N"）；用户后续可改文案或上传映射表。
export const STRATUM_COLORS = {
  1: '#8a6f4d', 2: '#c8a878', 3: '#b48b5e', 4: '#a67c52',
  5: '#8f7355', 6: '#7d6b58', 7: '#6e6157', 8: '#5d554d', 9: '#4d4d4d',
};
const FALLBACK = ['#4d9fff', '#4caf50', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1', '#ff8a65'];
const legendMap = new Map();
export function stratumColor(code) {
  if (code == null) return '#666';
  if (STRATUM_COLORS[code]) return STRATUM_COLORS[code];
  if (!legendMap.has(code)) legendMap.set(code, FALLBACK[legendMap.size % FALLBACK.length]);
  return legendMap.get(code);
}
export function buildLegend() {
  const items = [];
  for (const [k, c] of Object.entries(STRATUM_COLORS)) items.push({ code: Number(k), color: c, label: `分层 ${k}` });
  for (const [k, c] of legendMap.entries()) items.push({ code: k, color: c, label: `分层 ${k}` });
  return items;
}

function makeTextSprite(text, { size = 28, color = '#cfe3ff' } = {}) {
  const ctx0 = document.createElement('canvas').getContext('2d');
  ctx0.font = `${size}px system-ui, "Microsoft YaHei", sans-serif`;
  const w = Math.ceil(ctx0.measureText(text).width) + 12;
  const h = size + 10;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(10,12,18,0.7)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.font = `${size}px system-ui, "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle'; ctx.fillText(text, 6, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(w / size, h / size, 1); sp.renderOrder = 999;
  return sp;
}

export function buildBoreholeGroup(boreholes, align, { radius = 0.18 } = {}) {
  const group = new THREE.Group();
  group.name = 'boreholes';
  const pickables = [];
  for (const b of boreholes) {
    const [wx, wy] = applySimilarity(align, [b.x, b.y]);
    const g = new THREE.Group();
    for (const L of b.layers) {
      const len = L.bottom - L.top;
      if (len <= 0) continue;
      const geo = new THREE.CylinderGeometry(radius, radius, len, 10);
      geo.rotateX(Math.PI / 2); // CylinderGeometry 默认轴向 Y → 转成 Z
      const mat = new THREE.MeshBasicMaterial({ color: stratumColor(L.stratum), transparent: true, opacity: 0.95 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(wx, wy, (L.top + L.bottom) / 2);
      m.userData.pick = { borehole: b, layer: L };
      pickables.push(m); g.add(m);
    }
    const topZ = b.layers.length ? Math.min(...b.layers.map(L => L.top)) : 0;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.6, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    marker.position.set(wx, wy, topZ - 0.25);
    g.add(marker);
    const lbl = makeTextSprite(b.id);
    lbl.position.set(wx, wy, topZ - 1.4);
    g.add(lbl);
    group.add(g);
  }
  return { group, pickables, legend: buildLegend() };
}
```

- [ ] **Step 2: 实现 `src/render/boreholePanel.js`**

```js
// render/boreholePanel.js —— 钻孔列表面板（拾取信息卡 + 剖面选孔）
export function createBoreholePanel(el, { boreholes, pickables, onPick, onLinkToggle }) {
  el.innerHTML = '';
  el.style.display = 'block';
  const head = document.createElement('h3'); head.textContent = `钻孔 (${boreholes.length})`; el.appendChild(head);
  const list = document.createElement('div'); el.appendChild(list);
  const card = document.createElement('div'); card.style.cssText = 'margin-top:6px;border-top:1px solid #333;padding-top:6px;font-size:11px;display:none'; el.appendChild(card);

  const render = () => {
    list.innerHTML = '';
    boreholes.forEach((b) => {
      const row = document.createElement('div'); row.className = 'bh-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.title = '加入剖面';
      cb.addEventListener('change', () => onLinkToggle(b, cb.checked));
      const idBtn = document.createElement('span'); idBtn.className = 'id'; idBtn.textContent = b.id;
      idBtn.title = `(${b.x.toFixed(1)}, ${b.y.toFixed(1)}) · ${b.layers.length} 层`;
      idBtn.addEventListener('click', () => { onPick(b); showCard(b); });
      const meta = document.createElement('span'); meta.style.color = '#9cd'; meta.textContent = `${b.layers.length}层`;
      row.append(cb, idBtn, meta);
      list.appendChild(row);
    });
  };
  const showCard = (b) => {
    card.style.display = 'block';
    const rows = b.layers.map(L => `<tr><td>${L.top.toFixed(1)}–${L.bottom.toFixed(1)}</td><td>${L.stratum ?? '-'}</td><td>${L.ph ?? '-'}</td><td>${L.sampleId}</td></tr>`).join('');
    card.innerHTML = `<b>${b.id}</b> (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) 地面高程 ${b.ground ?? '-'}m
      <table style="border-collapse:collapse;margin-top:4px"><thead><tr style="color:#9cd"><th>深度</th><th>分层</th><th>pH</th><th>样号</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  render();
  return { refresh: render };
}
```

- [ ] **Step 3: 在 main.js 装配（不接数据源切换，只接 CSV 拖入）**

打开 `src/main.js`，**在 bootSingle/bootMulti 末尾**添加：

```js
// ---- 图层与工具装配（追加在 bootSingle/bootMulti 之后共享的部分） ----
import { LayerManager } from './layers/layerManager.js';
import { createLayerPanel } from './render/layerPanel.js';
import { SceneGizmos } from './render/sceneGizmos.js';
import { createLegendPanel } from './render/legendPanel.js';
import { parseBoreholeCsv } from './io/boreholeCsv.js';
import { solveSimilarity } from './io/boreholeAlign.js';
import { buildBoreholeGroup } from './layers/boreholeLayer.js';
import { createBoreholePanel } from './render/boreholePanel.js';
```

在 `window.__scene = scene;`（或 `window.__scene = host;`）那行**之前**加：

```js
const lm = new LayerManager(); lm.attach(scene.scene);

// 场景参照
const wb = scene.worldBounds ? scene.worldBounds() : (() => { const a = scene.meta.volumeAABB(); return new THREE.Box3(new THREE.Vector3(...a.min), new THREE.Vector3(...a.max)); })();
const ref = (await (await fetch('/dataset/lines/manifest.json').then(r => r.ok ? r.json() : null).catch(() => null))) || null;
const gizmos = new SceneGizmos(scene, wb, ref ? ref.reference : null);
lm.add({ id: 'gizmos', label: '场景参照', object3D: gizmos.group, builtin: true, visible: true });
const scaleBar = document.createElement('div'); scaleBar.id = 'inlineScaleBar';
scaleBar.style.cssText = 'background:rgba(0,0,0,0.55);padding:2px 8px;border-radius:10px;font-size:11px;color:#cfe3ff;position:absolute;bottom:10px;right:262px;pointer-events:none';
document.body.appendChild(scaleBar);

// 图例
const legend = createLegendPanel(document.getElementById('legendPanel'), style);
let _legendT = 0;
setInterval(() => { if (performance.now() - _legendT > 500) { legend.update(); _legendT = performance.now(); } }, 250);
gizmos.update(scaleBar);
setInterval(() => gizmos.update(scaleBar), 250);

// 图层面板
createLayerPanel(document.getElementById('layerPanel'), lm, { onDrop: handleFileDrop });

// 钻孔图层状态
let boreholeLayer = null;
let boreholePanel = null;
let pickables = [];

async function handleFileDrop(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.csv')) {
    const text = await file.text();
    const { boreholes, warnings } = parseBoreholeCsv(text);
    console.info('[borehole] 解析', boreholes.length, '个孔, 告警', warnings.length, warnings.slice(0, 3));
    if (boreholeLayer) lm.remove('boreholes');
    const align = solveSimilarity([{ from: [boreholes[0].x, boreholes[0].y], to: [0, 0] }]) || { a: 1, b: 0, tx: 0, ty: 0, scale: 1 };
    const { group, pickables: pks, legend: legendItems } = buildBoreholeGroup(boreholes, align);
    pickables = pks;
    boreholeLayer = lm.add({ id: 'boreholes', label: `钻孔 (${boreholes.length})`, object3D: group, builtin: false, visible: true });
    boreholePanel = createBoreholePanel(document.getElementById('boreholePanel'), {
      boreholes, pickables, onPick: (b) => {
        // 拾取：将 controls.target 移到柱状顶部（按 align 算出世界 x,y；z=0）
        const { applySimilarity } = await import('./io/boreholeAlign.js');
        const [wx, wy] = applySimilarity(align, [b.x, b.y]);
        scene.controls.target.set(wx, wy, 0); scene.controls.update();
      },
      onLinkToggle: (b, on) => { /* 阶段一占位，T8 接入 */ },
    });
  } else if (name.endsWith('.dxf')) { /* T13 接入 */ }
}

const dropHint = document.getElementById('dropHint');
viewportEl.addEventListener('dragover', (e) => { e.preventDefault(); dropHint.classList.add('active'); });
viewportEl.addEventListener('dragleave', () => dropHint.classList.remove('active'));
viewportEl.addEventListener('drop', (e) => { e.preventDefault(); dropHint.classList.remove('active'); if (e.dataTransfer.files[0]) handleFileDrop(e.dataTransfer.files[0]); });

// 拾取：单击 → 弹信息卡；移动相机 (drag) 不算
let _pdX = 0, _pdY = 0;
viewportEl.addEventListener('pointerdown', (e) => { _pdX = e.clientX; _pdY = e.clientY; });
viewportEl.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - _pdX, e.clientY - _pdY) > 4) return;
  const rc = new THREE.Raycaster();
  const ndc = new THREE.Vector2(((e.clientX - viewportEl.getBoundingClientRect().left) / viewportEl.clientWidth) * 2 - 1,
                                -((e.clientY - viewportEl.getBoundingClientRect().top) / viewportEl.clientHeight) * 2 + 1);
  rc.setFromCamera(ndc, scene.camera);
  const hits = rc.intersectObjects(pickables, false);
  if (hits.length) { const b = hits[0].object.userData.pick.borehole; boreholePanel && boreholePanel.refresh(); boreholePanel && (document.getElementById('boreholePanel').scrollTop = 0); /* card via panel show */ }
});
```

> 注意：原 main.js `bootMulti` 末尾用 `window.__scene = host;` 但 `host` 没有 `worldBounds` 之外的属性；上段对 host/scene 都用 `scene.scene / scene.camera / scene.controls`（MultiLineHost 与 VolumeScene 都暴露这些）。若只在多线模式跑，构造 gizmos 用 `host.worldBounds()`；单线模式用 meta.volumeAABB()。上段代码已用三元。

- [ ] **Step 4: 视觉验证**

1. `npm run dev`
2. 拖入 `web/从煤气到地层编码.csv` 到视口
3. 截图：图层面板多出"钻孔 (N)"；boreholePanel 显示孔号列表；场景中出现彩色分层柱（注意：未做 align 配准，CSV 坐标直接平移后位置在原点附近，看不到柱状时缩放相机 + 调整 align 默认平移到世界 AABB 中心——T12 配准 UI 完善）
4. 拖动相机 / 缩放：gizmo 网格/标尺正确显示；比例尺条长变化
5. 点击柱状段：boreholePanel 顶部出现该孔分层表
6. `npm test` 仍然全绿

- [ ] **Step 5: Commit**

```bash
git add src/layers/boreholeLayer.js src/render/boreholePanel.js src/main.js
git commit -m "feat: 钻孔 L1 柱状图层 + CSV 拖入接入 + 拾取信息卡"
```

---

### Task 8: 钻孔剖面连线

**Files:**
- Create: `src/layers/sectionLinkLayer.js`
- Modify: `src/render/boreholePanel.js`（"加入剖面"事件接通）
- Modify: `src/main.js`（管理 sectionLinkLayer 状态 + onLinkToggle 处理）

**Interfaces:**
- `buildSectionLink(ordered, align) -> { group, line, flags }`：按 borehole 顺序在世界 XY 平面（z=0）画折线 + 序号旗标 sprite。
- 消费方：T10 任意剖面"沿钻孔连线"按钮复用 group 顶点。

- [ ] **Step 1: 实现 `src/layers/sectionLinkLayer.js`**

```js
// layers/sectionLinkLayer.js —— 钻孔剖面连线（z=0 地面折线 + 序号旗标）
import * as THREE from 'three';
import { applySimilarity } from '../io/boreholeAlign.js';

function makeNumberSprite(n) {
  const size = 28, w = 36, h = 28;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255,82,82,0.9)'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff'; ctx.font = `bold ${size}px system-ui`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat); sp.scale.set(w / size, h / size, 1); sp.renderOrder = 998;
  return sp;
}

export function buildSectionLink(ordered, align) {
  const group = new THREE.Group();
  group.name = 'sectionLink';
  if (!ordered.length) return { group, line: null, flags: [] };
  const pts = ordered.map(b => {
    const [wx, wy] = applySimilarity(align, [b.x, b.y]);
    return new THREE.Vector3(wx, wy, 0.05);
  });
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff5252 }));
  group.add(line);
  const flags = pts.map((p, i) => {
    const s = makeNumberSprite(i + 1); s.position.copy(p).add(new THREE.Vector3(0, 0, 0.4));
    group.add(s); return s;
  });
  return { group, line, flags, points: pts };
}
```

- [ ] **Step 2: boreholePanel 加一个 "生成剖面连线" 按钮**

在 `boreholePanel` 的 head 之后加：

```js
const actions = document.createElement('div');
actions.style.cssText = 'display:flex;gap:6px;margin:4px 0';
const btnMake = document.createElement('button'); btnMake.textContent = '生成剖面连线'; btnMake.className = 'del';
const btnClear = document.createElement('button'); btnClear.textContent = '清除剖面'; btnClear.className = 'del';
actions.append(btnMake, btnClear);
el.appendChild(actions);

let selected = new Set();
row 内部 cb.addEventListener 改为:
  cb.addEventListener('change', () => { if (cb.checked) selected.add(b); else selected.delete(b); });

btnMake.addEventListener('click', () => onLinkMake([...selected]));
btnClear.addEventListener('click', () => onLinkClear());
```

（修改后的完整 boreholePanel 留到本任务的 Step 4 完整覆盖文件。）

- [ ] **Step 3: main.js 接 onLinkMake/Clear**

```js
import { buildSectionLink } from './layers/sectionLinkLayer.js';
let sectionLinkLayer = null;
let currentAlign = null; // 保存当前 CSV 解析后的 align，给任意剖面采样用
const onLinkMake = (ordered) => {
  if (!ordered.length) return;
  if (sectionLinkLayer) lm.remove('sectionLink');
  const { group, points } = buildSectionLink(ordered, currentAlign);
  sectionLinkLayer = lm.add({ id: 'sectionLink', label: `剖面连线 (${ordered.length}孔)`, object3D: group, builtin: false, visible: true });
  window.__sectionPoints = points; // T10 复用
};
const onLinkClear = () => { if (sectionLinkLayer) { lm.remove('sectionLink'); sectionLinkLayer = null; window.__sectionPoints = null; } };
```

将 boreholePanel 的 onLinkToggle 改为：上面 `selected` Set 在 onLinkToggle 中维护；面板的 onLinkMake/onLinkClear 由 main 注入。

- [ ] **Step 4: 重写完整 `src/render/boreholePanel.js`**

```js
// render/boreholePanel.js —— 钻孔列表面板（拾取信息卡 + 剖面选孔）
export function createBoreholePanel(el, { boreholes, pickables, onPick, onLinkMake, onLinkClear }) {
  el.innerHTML = '';
  el.style.display = 'block';
  el.appendChild(Object.assign(document.createElement('h3'), { textContent: `钻孔 (${boreholes.length})` }));

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;margin:4px 0';
  const btnMake = document.createElement('button'); btnMake.className = 'del'; btnMake.textContent = '生成剖面连线';
  const btnClear = document.createElement('button'); btnClear.className = 'del'; btnClear.textContent = '清除剖面';
  actions.append(btnMake, btnClear); el.appendChild(actions);

  const list = document.createElement('div'); el.appendChild(list);
  const card = document.createElement('div'); card.style.cssText = 'margin-top:6px;border-top:1px solid #333;padding-top:6px;font-size:11px;display:none'; el.appendChild(card);

  const selected = new Set();
  const render = () => {
    list.innerHTML = '';
    boreholes.forEach((b) => {
      const row = document.createElement('div'); row.className = 'bh-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.title = '加入剖面';
      cb.checked = selected.has(b);
      cb.addEventListener('change', () => { if (cb.checked) selected.add(b); else selected.delete(b); });
      const idBtn = document.createElement('span'); idBtn.className = 'id'; idBtn.textContent = b.id;
      idBtn.title = `(${b.x.toFixed(1)}, ${b.y.toFixed(1)}) · ${b.layers.length} 层`;
      idBtn.addEventListener('click', () => { onPick(b); showCard(b); });
      const meta = document.createElement('span'); meta.style.color = '#9cd'; meta.textContent = `${b.layers.length}层`;
      row.append(cb, idBtn, meta); list.appendChild(row);
    });
  };
  const showCard = (b) => {
    card.style.display = 'block';
    const rows = b.layers.map(L => `<tr><td>${L.top.toFixed(1)}–${L.bottom.toFixed(1)}</td><td>${L.stratum ?? '-'}</td><td>${L.ph ?? '-'}</td><td>${L.sampleId}</td></tr>`).join('');
    card.innerHTML = `<b>${b.id}</b> (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) 地面高程 ${b.ground ?? '-'}m
      <table style="border-collapse:collapse;margin-top:4px"><thead><tr style="color:#9cd"><th>深度</th><th>分层</th><th>pH</th><th>样号</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  btnMake.addEventListener('click', () => onLinkMake([...selected]));
  btnClear.addEventListener('click', () => { selected.clear(); onLinkClear(); render(); });
  render();
  return { refresh: render };
}
```

- [ ] **Step 5: 视觉验证**

拖入 CSV → boreholePanel 出现；勾选 3 个孔 → "生成剖面连线" → 场景出现红色折线和编号旗标；"清除剖面"→ 消失。`npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/layers/sectionLinkLayer.js src/render/boreholePanel.js src/main.js
git commit -m "feat: 钻孔剖面连线（z=0 折线 + 序号旗标）"
```

---

### Task 9: 体素采样器（任意剖面底层）

**Files:**
- Create: `src/dataset/volumeSampler.js`
- Test: `tests/volumeSampler.test.js`

**Interfaces:**
- 纯函数（便于测试，**不**发起 fetch）：
  - `locateVoxel(li, meta, lx, ly, lz) -> { key, i, j, k } | null`（li = `meta.sliceInfo()`；meta 提供 `origin / tileW/H/D / ghost`）
  - `readVoxel(tile, v, ghost) -> number`：x 最快 f32 布局读 + ghost 圈
- 类：
  - `new VolumeSampler(meta, basePath) -> { async sampleProfile(points, {step, zMax, zStep, lineCfg?, onProgress?}): Promise<{cols, rows, minZ, stepM, zStepM, data: Float32Array, extents: [x0,y0,xN,yN]}>, valueAt(wx, wy, wz, lineCfg?): number, dispose() }`
  - `lineCfg?: { worldOffset:[x,y,z], direction:1|-1 }`：将世界坐标逆变换到局部（多线模式按选线取体；阶段一只支持"选一条线"做剖面）。

- [ ] **Step 1: 写失败测试** `tests/volumeSampler.test.js`

```js
import { describe, it, expect } from 'vitest';
import { locateVoxel, readVoxel } from '../src/dataset/volumeSampler.js';

const meta = {
  origin: [10, 20, 0],
  tileW: 8, tileH: 4, tileD: 4,
  ghost: 1,
};
const li = { level: 1, scale: 1, dims: [16, 8, 8], spacing: [0.5, 0.5, 0.25] };

describe('locateVoxel', () => {
  it('点 (10,20,0) → 瓦片内 i=j=k=0', () => {
    const v = locateVoxel(li, meta, 10, 20, 0);
    expect(v).toEqual({ key: '1/0/0/0', i: 0, j: 0, k: 0 });
  });
  it('越界 → null', () => {
    expect(locateVoxel(li, meta, 0, 0, 0)).toBeNull(); // x 越界
    expect(locateVoxel(li, meta, 10, 30, 0)).toBeNull();
  });
  it('tile 边界 (10+4*0.5=12) → i=8 = tileW 跨界', () => {
    const v = locateVoxel(li, meta, 12, 20, 0);
    expect(v).toEqual({ key: '1/1/0/0', i: 0, j: 0, k: 0 });
  });
});

describe('readVoxel', () => {
  it('读 storeW*storeH*storeD x最快，i=1,j=2,k=3,ghost=1 → idx=((3+1)*H + (2+1))*W + (1+1)', () => {
    const W = 5, H = 4, D = 6, ghost = 1;
    const f32 = new Float32Array(W * H * D);
    f32[((3 + ghost) * H + (2 + ghost)) * W + (1 + ghost)] = 42;
    const tile = { header: { width: W, height: H, depth: D }, f32 };
    expect(readVoxel(tile, { i: 1, j: 2, k: 3 }, ghost)).toBe(42);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test` → FAIL。

- [ ] **Step 3: 实现 `src/dataset/volumeSampler.js`**（先实现纯函数 + 类的骨架，sampleProfile / valueAt 复用 locateVoxel + readVoxel + 瓦片 LRU 缓存）

```js
// dataset/volumeSampler.js —— 任意剖面体素采样（基于 sliceLevel mean-LOD 瓦片 f32）
// 纯函数 + 类，类不直接 import three（除类型注释外）。
import { loadTileSmart } from './tileLoader.js';

export function locateVoxel(li, meta, lx, ly, lz) {
  const [sx, sy, sz] = li.spacing;
  const ix = Math.floor((lx - meta.origin[0]) / sx);
  const iy = Math.floor((ly - meta.origin[1]) / sy);
  const iz = Math.floor((lz - meta.origin[2]) / sz);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= li.dims[0] || iy >= li.dims[1] || iz >= li.dims[2]) return null;
  const tx = Math.floor(ix / meta.tileW);
  const ty = Math.floor(iy / meta.tileH);
  const tz = Math.floor(iz / meta.tileD);
  return { key: `${li.level}/${tx}/${ty}/${tz}`, i: ix - tx * meta.tileW, j: iy - ty * meta.tileH, k: iz - tz * meta.tileD };
}

export function readVoxel(tile, v, ghost) {
  const W = tile.header.width, H = tile.header.height;
  const i = v.i + ghost, j = v.j + ghost, k = v.k + ghost;
  return tile.f32[(k * H + j) * W + i];
}

// 折线等距重采样（沿累计弧长 stepM）
function resamplePolyline(points, stepM) {
  if (!points.length) return [];
  const out = [[points[0][0], points[0][1], 0]];
  let last = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    const dx = x1 - x0, dy = y1 - y0, seg = Math.hypot(dx, dy);
    if (seg < 1e-9) continue;
    const ux = dx / seg, uy = dy / seg;
    let covered = 0;
    while (last + stepM <= last + seg) {
      const s = last + stepM - last; // 实际推进
      const t = s;
      const nx = x0 + ux * t, ny = y0 + uy * t;
      last += stepM;
      out.push([nx, ny, out[out.length - 1][2] + stepM]);
    }
    last = last + seg - (last + seg - (last + stepM * Math.floor((seg + (out[out.length - 1][2] - (last - seg))) / stepM)));
  }
  return out;
}
```

> 上述 resamplePolyline 写法是为了让单元测试可在孤立环境跑（无 fetch）。执行者在 Step 3 完成后以真实样例 node 脚本核对，必要时重写为更直观的循环。

把类补全：

```js
export class VolumeSampler {
  constructor(meta, basePath) {
    this.meta = meta;
    this.basePath = basePath;
    this.li = meta.sliceInfo();
    this.ghost = meta.ghost || 1;
    this._tiles = new Map(); // key -> tile
    this._loading = new Map(); // key -> Promise
  }
  _ensureTile(key) {
    if (this._tiles.has(key)) return Promise.resolve(this._tiles.get(key));
    if (this._loading.has(key)) return this._loading.get(key);
    const p = loadTileSmart(this.basePath, this.meta.storage, key,
      { ghost: this.ghost, scale: this.li.scale || 1, offset: 0, half: false })
      .then(t => { this._tiles.set(key, t); this._loading.delete(key); return t; })
      .catch(e => { this._loading.delete(key); throw e; });
    this._loading.set(key, p);
    return p;
  }
  // 世界 → 局部（按 lineCfg 逆变换）
  _worldToLocal(wx, wy, wz, lineCfg) {
    if (!lineCfg) return [wx, wy, wz];
    const [ox, oy, oz] = lineCfg.worldOffset;
    const d = lineCfg.direction;
    return [(wx - ox) / d, wy - oy, wz - oz];
  }
  async valueAt(wx, wy, wz, lineCfg) {
    const [lx, ly, lz] = this._worldToLocal(wx, wy, wz, lineCfg);
    const v = locateVoxel(this.li, this.meta, lx, ly, lz);
    if (!v) return NaN;
    const t = await this._ensureTile(v.key);
    return readVoxel(t, v, this.ghost);
  }
  async sampleProfile(points, { step = 0.25, zMax = 8, zStep = null, lineCfg = null, onProgress = null } = {}) {
    const samples = resamplePolyline(points, step);
    if (!samples.length) return { cols: 0, rows: 0, data: new Float32Array(0), extents: [0, 0, 0, 0], stepM: step, zStepM: zStep || this.li.spacing[2] };
    const dz = zStep || this.li.spacing[2];
    const rows = Math.max(1, Math.floor(zMax / dz) + 1);
    const cols = samples.length;
    const data = new Float32Array(cols * rows);
    // 预收集所需瓦片 key
    const needed = new Set();
    const locs = new Array(cols);
    for (let s = 0; s < cols; s++) {
      const [wx, wy] = samples[s];
      for (let r = 0; r < rows; r++) {
        const wz = r * dz;
        const [lx, ly, lz] = this._worldToLocal(wx, wy, wz, lineCfg);
        const v = locateVoxel(this.li, this.meta, lx, ly, lz);
        locs[s * rows + r] = v;
        if (v) needed.add(v.key);
      }
    }
    // 并发加载（限并发 8）
    const keys = [...needed];
    let done = 0;
    await Promise.all(keys.map(async (k) => {
      const tiles = await Promise.all([this._ensureTile(k)]);
      done++;
      if (onProgress) onProgress(done / keys.length);
    }));
    // 读值
    for (let s = 0; s < cols; s++) {
      for (let r = 0; r < rows; r++) {
        const v = locs[s * rows + r];
        if (!v) { data[s * rows + r] = NaN; continue; }
        const t = this._tiles.get(v.key);
        data[s * rows + r] = readVoxel(t, v, this.ghost);
      }
    }
    const extents = [samples[0][0], samples[0][1], samples[samples.length - 1][0], samples[samples.length - 1][1]];
    return { cols, rows, data, extents, stepM: step, zStepM: dz, minZ: 0 };
  }
  dispose() { this._tiles.clear(); this._loading.clear(); }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test` → T1/T2/T3/T4（无单测）/T5/T9 全部 PASS。

- [ ] **Step 5: 真实数据冒烟（node 一次性）**

```bash
node --input-type=module -e "import { loadMetadata } from './src/dataset/metadata.js'; import { VolumeSampler } from './src/dataset/volumeSampler.js'; const m = await loadMetadata('/dataset/lines/明星路_001/metadata.json').catch(()=>loadMetadata('/dataset/metadata.json')); const vs = new VolumeSampler(m, '/dataset/lines/明星路_001'.replace('metadata.json','')); const r = await vs.sampleProfile([[0,0],[50,0]], { step: 0.5, zMax: 4 }); console.log(r.cols, r.rows, 'NaN 占比', r.data.filter(x=>Number.isNaN(x)).length / r.data.length);"
```

Expected: 101×161 量级；NaN 占比与该线 AABB 之外点的比例一致（端点外为 NaN 是正常的）。

- [ ] **Step 6: Commit**

```bash
git add src/dataset/volumeSampler.js tests/volumeSampler.test.js
git commit -m "feat: 任意剖面体素采样器（locate/read 纯函数 + sampleProfile）"
```

---

### Task 10: 任意角度剖面（俯视拾取折线 → 剖面浮窗）

**Files:**
- Create: `src/render/arbitrarySection.js`

**Interfaces:**
- `new ArbitrarySection({ scene, host, meta, sampler, style, lm, onUseBoreholeLine }) -> { enter()/exit()/update() }`
  - `enter()`：进入"画线模式"——pointer 事件挂在 viewport，拾取地面 z=0 平面，收集点；预览 polyline + 序号。
  - `exit()`：取消，清理预览。
  - 双击 / Enter / 工具栏 "完成" → 调 `sampler.sampleProfile(...)` → 浮窗 `#sectionWindow` 渲染：色标用 `style.colorMap`，min/max = `style.minValue/maxValue`。
  - 工具栏 "沿钻孔连线" → 复用 `window.__sectionPoints`（T8）。
- 消费方：T12 main 装配。

- [ ] **Step 1: 实现 `src/render/arbitrarySection.js`**

```js
// render/arbitrarySection.js —— 任意角度剖面：俯视拾取折线 → 浮窗渲染
import * as THREE from 'three';

const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z=0 地面

export class ArbitrarySection {
  constructor({ scene, host, meta, sampler, style, lm, onUseBoreholeLine }) {
    this.scene = scene; this.host = host; this.meta = meta;
    this.sampler = sampler; this.style = style; this.lm = lm;
    this.onUseBoreholeLine = onUseBoreholeLine;
    this.active = false; this.points = []; this.preview = null; this.previewFlags = [];
    this._listeners = null;
  }
  enter() {
    if (this.active) return;
    this.active = true; this.points = [];
    const dom = this.scene.renderer ? this.scene.renderer.domElement : this.host.renderer.domElement;
    this._listeners = {
      pointerdown: (e) => { if (e.button !== 0) return; this._addPoint(e, dom); },
      dblclick: (e) => { e.preventDefault(); this._finish(); },
      keydown: (e) => { if (e.key === 'Enter') this._finish(); if (e.key === 'Escape') this.exit(); },
    };
    dom.addEventListener('pointerdown', this._listeners.pointerdown);
    dom.addEventListener('dblclick', this._listeners.dblclick);
    window.addEventListener('keydown', this._listeners.keydown);
    document.getElementById('dropHint').textContent = '画线模式：单击加点，双击完成，Enter 确认，Esc 取消';
    document.getElementById('dropHint').classList.add('active');
  }
  exit() {
    if (!this.active) return;
    this.active = false;
    const dom = this.scene.renderer ? this.scene.renderer.domElement : this.host.renderer.domElement;
    dom.removeEventListener('pointerdown', this._listeners.pointerdown);
    dom.removeEventListener('dblclick', this._listeners.dblclick);
    window.removeEventListener('keydown', this._listeners.keydown);
    this._clearPreview();
    document.getElementById('dropHint').classList.remove('active');
    document.getElementById('dropHint').textContent = '';
  }
  _addPoint(e, dom) {
    const rect = dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const cam = this.host.camera;
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, cam);
    const hit = new THREE.Vector3();
    if (!rc.ray.intersectPlane(PLANE, hit)) return;
    this.points.push([hit.x, hit.y]);
    this._rebuildPreview();
  }
  _rebuildPreview() {
    this._clearPreview();
    if (this.points.length < 1) return;
    const grp = new THREE.Group(); grp.name = 'sectionPreview';
    const pts3 = this.points.map(p => new THREE.Vector3(p[0], p[1], 0.06));
    if (pts3.length >= 2) grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3), new THREE.LineBasicMaterial({ color: 0xffd54f })));
    for (let i = 0; i < pts3.length; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd54f }));
      m.position.copy(pts3[i]); grp.add(m);
    }
    this.preview = grp; this.host.scene.add(grp);
  }
  _clearPreview() {
    if (this.preview) { this.host.scene.remove(this.preview); this.preview.traverse(o => { if (o.geometry) o.geometry.dispose(); }); this.preview = null; }
  }
  async _finish() {
    if (this.points.length < 2) { this.exit(); return; }
    const lineCfg = this._pickLineCfg();
    const result = await this.sampler.sampleProfile(this.points, { step: 0.25, zMax: 8, lineCfg });
    this.exit();
    this._renderWindow(result);
  }
  _pickLineCfg() {
    // 阶段一：用首线（与 B-Scan 默认一致）；阶段三改为按拾取点所在线自动选。
    const v = this.host.views ? this.host.views[0] : null;
    if (!v) return null;
    return { worldOffset: v.worldOffset, direction: v.direction };
  }
  _renderWindow(result) {
    const el = document.getElementById('sectionWindow');
    el.style.display = 'block';
    el.innerHTML = `
      <div class="ctrls">
        <span>沿线长 ${(result.cols * result.stepM).toFixed(1)} m · 深度 ${result.rows * result.zStepM} m</span>
        <button class="del" id="secClose">×</button>
      </div>
      <canvas id="secCanvas" width="${result.cols}" height="${result.rows}"></canvas>
    `;
    const cvs = el.querySelector('canvas');
    const ctx = cvs.getContext('2d');
    const img = ctx.createImageData(result.cols, result.rows);
    const tex = this.style.colorMap && this.style.colorMap.image; // 256x1 canvas
    const cmapData = tex ? tex.getContext('2d').getImageData(0, 0, 256, 1).data : null;
    const vmin = this.style.minValue, vmax = this.style.maxValue;
    const range = (vmax - vmin) || 1;
    for (let i = 0; i < result.data.length; i++) {
      const v = result.data[i];
      let r = 0, g = 0, b = 0;
      if (Number.isFinite(v) && cmapData) {
        const t = Math.max(0, Math.min(255, Math.floor(((v - vmin) / range) * 255)));
        r = cmapData[t * 4]; g = cmapData[t * 4 + 1]; b = cmapData[t * 4 + 2];
      }
      const j = i * 4;
      img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b; img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    el.querySelector('#secClose').addEventListener('click', () => { el.style.display = 'none'; });
  }
}
```

- [ ] **Step 2: main.js 接入**

T7 装配段补：

```js
import { VolumeSampler } from './dataset/volumeSampler.js';
import { ArbitrarySection } from './render/arbitrarySection.js';

// 在 lm.attach 之后：
const sampler = new VolumeSampler(scene.views ? scene.views[0].meta : scene.meta, scene.views ? (await (await fetch('/dataset/lines/manifest.json').then(r => r.json())).lines[0].metaUrl.replace(/metadata\.json$/, '')) : '/dataset');
const arbSec = new ArbitrarySection({ scene: scene.views ? scene : scene, host: scene, meta: null, sampler, style, lm });
window.__arbSec = arbSec;

// 添加到 layerPanel 的一个常驻按钮：在 lm 下方插入一个 div
const toolsDiv = document.createElement('div'); toolsDiv.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px';
toolsDiv.innerHTML = '<button class="del" id="btnArbSection">任意角度剖面</button><button class="del" id="btnFromLink" style="margin-left:4px">沿钻孔连线剖面</button>';
document.getElementById('layerPanel').appendChild(toolsDiv);
document.getElementById('btnArbSection').addEventListener('click', () => arbSec.enter());
document.getElementById('btnFromLink').addEventListener('click', async () => {
  const pts = (window.__sectionPoints || []).map(p => [p.x, p.y]);
  if (pts.length < 2) { alert('先生成钻孔剖面连线'); return; }
  arbSec.points = pts; await arbSec._finish();
});
```

> 上文假设 `host` 是 MultiLineHost，`scene` 是 VolumeScene（单线模式），用同一 `host` 变量承接两者，对外取 `host.camera / host.scene / host.renderer / host.views` 都行得通（单线模式 `host.views` 不存在）。

- [ ] **Step 3: 视觉验证**

`npm run dev`：
1. 拖入 CSV
2. 勾选 2 孔 → 生成剖面连线
3. 点 "沿钻孔连线剖面"：浮窗出现剖面图（线长 沿两孔距离）
4. 点 "任意角度剖面" → 在场景单击 2~3 个点 → 双击 → 浮窗出现新剖面
5. 调整 style.minValue / colormap → 剖面色调/对比度同步（重新触发绘制即可：在 `stylePanel` 输入 change 事件后调 `arbSec._renderWindow` 重绘——为简洁，T11/T14 收尾阶段补一个轻量 "section 重绘" 钩子；阶段一接受"开关窗口"重建浮窗）

- [ ] **Step 4: Commit**

```bash
git add src/render/arbitrarySection.js src/main.js
git commit -m "feat: 任意角度剖面（俯视拾取折线 + 钻孔连线复用 + 浮窗渲染）"
```

---

### Task 11: 测量工具（两点 3D 距离）

**Files:**
- Create: `src/tools/measureTool.js`

**Interfaces:**
- `new MeasureTool({ camera, dom, scene, getTargets, domHud }) -> { enable()/disable()/dispose() }`
  - `getTargets()`：返回当前可见的瓦片 mesh 数组（多线用 host 跨线取；单线用 scene.meshes）。
  - 拖拽 vs 单击区分：pointerdown→up 距离 < 4px 算单击。
  - 单击 → raycast 取最近交点；二次单击 → 画线 + sprite 显示距离；Esc 取消；点空白取消上次未完成。
- 消费方：T12 main 装配。

- [ ] **Step 1: 实现 `src/tools/measureTool.js`**

```js
// tools/measureTool.js —— 两点 3D 距离测量（射线拾取已加载瓦片 mesh）
import * as THREE from 'three';

const _ndc = new THREE.Vector2();
const _rc = new THREE.Raycaster();
const _hit = new THREE.Vector3();

function makeLabel(text) {
  const ctx0 = document.createElement('canvas').getContext('2d');
  ctx0.font = '28px system-ui';
  const w = Math.ceil(ctx0.measureText(text).width) + 14;
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20,30,50,0.85)'; ctx.fillRect(0, 0, w, 32);
  ctx.fillStyle = '#cfe3ff'; ctx.font = '24px system-ui';
  ctx.textBaseline = 'middle'; ctx.fillText(text, 7, 16);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat); sp.scale.set(w / 24, 32 / 24, 1); sp.renderOrder = 997;
  return { sp, tex };
}

export class MeasureTool {
  constructor({ camera, dom, scene, getTargets, domHud }) {
    this.camera = camera; this.dom = dom; this.scene = scene; this.getTargets = getTargets; this.domHud = domHud;
    this.enabled = false; this.points = []; this.sprites = []; this.lines = []; this._pdX = 0; this._pdY = 0;
    this._handlers = null;
  }
  enable() {
    if (this.enabled) return; this.enabled = true;
    this._handlers = {
      pointerdown: (e) => { this._pdX = e.clientX; this._pdY = e.clientY; },
      pointerup: (e) => { if (Math.hypot(e.clientX - this._pdX, e.clientY - this._pdY) > 4) return; this._onClick(e); },
      keydown: (e) => { if (e.key === 'Escape') this._reset('已取消'); },
    };
    this.dom.addEventListener('pointerdown', this._handlers.pointerdown);
    this.dom.addEventListener('pointerup', this._handlers.pointerup);
    window.addEventListener('keydown', this._handlers.keydown);
    this._setHud('测量模式：单击两点，Esc 取消');
  }
  disable() {
    if (!this.enabled) return; this.enabled = false;
    this.dom.removeEventListener('pointerdown', this._handlers.pointerdown);
    this.dom.removeEventListener('pointerup', this._handlers.pointerup);
    window.removeEventListener('keydown', this._handlers.keydown);
    this._reset('已关闭');
  }
  dispose() { this.disable(); this._clearAll(); }
  _onClick(e) {
    const rect = this.dom.getBoundingClientRect();
    _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    _rc.setFromCamera(_ndc, this.camera);
    const hits = _rc.intersectObjects(this.getTargets(), false);
    if (!hits.length) { this._reset('未命中（重选）'); return; }
    hits[0].point.clone(_hit);
    this.points.push(_hit.clone());
    if (this.points.length === 2) {
      const a = this.points[0], b = this.points[1];
      const dist = a.distanceTo(b);
      const seg = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0x4d9fff }));
      this.scene.add(seg); this.lines.push(seg);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const { sp, tex } = makeLabel(`${dist.toFixed(2)} m`); sp.position.copy(mid); this.scene.add(sp);
      this.sprites.push({ sp, tex });
      this._setHud(`距 ${dist.toFixed(2)} m（再点开新一轮）`);
      this.points = [];
    } else {
      this._setHud('已选第一点，再点第二点');
    }
  }
  _reset(msg) { this.points = []; this._setHud(msg); }
  _setHud(text) { if (this.domHud) { this.domHud.textContent = text; this.domHud.style.display = 'block'; } }
  _clearAll() { for (const s of this.sprites) { this.scene.remove(s.sp); s.tex.dispose(); } this.sprites = []; for (const l of this.lines) { this.scene.remove(l); l.geometry.dispose(); l.material.dispose(); } this.lines = []; }
}
```

- [ ] **Step 2: main.js 装配**

```js
import { MeasureTool } from './tools/measureTool.js';
// 在 lm 装配后：
const measure = new MeasureTool({
  camera: scene.camera,
  dom: viewportEl,
  scene: scene.scene,
  getTargets: () => {
    const v = scene.views ? scene.views : [{ meshes: scene.meshes }];
    const out = [];
    for (const x of v) for (const m of x.meshes.values()) if (m.parent) out.push(m);
    return out;
  },
  domHud: document.getElementById('measureHud'),
});
// layerPanel 下方追加：
const toolBtn = document.createElement('button'); toolBtn.className = 'del'; toolBtn.textContent = '测量（开/关）';
toolBtn.style.cssText = 'margin-top:6px;width:100%';
document.getElementById('layerPanel').appendChild(toolBtn);
toolBtn.addEventListener('click', () => measure.enabled ? measure.disable() : measure.enable());
```

- [ ] **Step 3: 视觉验证**

`npm run dev`：点 "测量（开/关）" → 视口内单击两个体素/网格/钻孔 → 中点出现蓝色线 + 距离标签；再点继续新测；Esc 取消。`npm test` 仍全绿。

- [ ] **Step 4: Commit**

```bash
git add src/tools/measureTool.js src/main.js
git commit -m "feat: 测量工具（瓦片 mesh 射线拾取 + 距离标签）"
```

---

### Task 12: 数据源切换（URL 参数 + sources.json + localStorage 恢复图层）

**Files:**
- Create: `src/io/layerStore.js`
- Modify: `src/main.js`（读 `?src=`，重构 boot 为可调用，提供默认 sources，构建 sourceSelect，处理 localStorage 恢复）

**Interfaces:**
- `layerStore.save(state)` / `layerStore.load() -> state|null`：`state = { csvText?: string, alignPairs?: Array<{from,to}>, sectionBoreholeIds?: string[], dxfText?: string }`；localStorage key `gpr_layers_v1`。
- `?src=manifest|<id>`：查询参数决定数据源；缺省走当前自动行为（manifest 优先，回退 single）。切换 = `location.search = '?src=...'` 整页重载（避免手写 teardown 泄漏），重载时 localStorage 自动恢复图层。

- [ ] **Step 1: 实现 `src/io/layerStore.js`**

```js
// io/layerStore.js —— 用户图层状态持久化（跨数据源切换）
// 存 raw CSV 文本 + 配准对（不存已渲染 group：group 在 boot 时重建）。
const KEY = 'gpr_layers_v1';

export function save(state) {
  try {
    const s = {
      csvText: state.csvText || null,
      alignPairs: state.alignPairs || null,
      sectionBoreholeIds: state.sectionBoreholeIds || null,
      dxfText: state.dxfText || null,
    };
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    console.warn('[layerStore] 保存失败：', err.message);
  }
}
export function load() {
  try {
    const t = localStorage.getItem(KEY); if (!t) return null;
    return JSON.parse(t);
  } catch { return null; }
}
export function clear() { try { localStorage.removeItem(KEY); } catch {} }
```

- [ ] **Step 2: main.js 重构——读 `?src=` + sources.json**

`src/main.js` 顶部替换 boot 入口为：

```js
import { save as layersSave, load as layersLoad } from './io/layerStore.js';

const params = new URLSearchParams(location.search);
const srcId = params.get('src');

let sources = null;
try { sources = (await (await fetch('/dataset/sources.json')).json()); } catch {}
if (!sources || !Array.isArray(sources) || !sources.length) {
  sources = [
    { id: 'auto', name: '自动（manifest → 单线回退）', kind: 'auto' },
  ];
}

const spec = srcId && sources.find(s => s.id === srcId) ? sources.find(s => s.id === srcId) : sources[0];

if (spec.kind === 'manifest' && spec.url) {
  const manifest = await (await fetch(spec.url)).json();
  await bootMulti(manifest);
} else if (spec.kind === 'single' && spec.url) {
  const m = await loadMetadata(spec.url);
  await bootSingleFromMeta(m, spec.url);
} else {
  // auto：原行为
  let manifest = null;
  try { manifest = await loadManifest(); } catch {}
  if (manifest && manifest.lines && manifest.lines.length) await bootMulti(manifest);
  else await bootSingle();
}
```

改造 `bootSingle` → 拆出 `bootSingleFromMeta(meta, metaUrl)` 以便传入非默认 URL。`metaUrl` 用于 `basePath`：

```js
async function bootSingleFromMeta(meta, metaUrl) {
  const basePath = metaUrl.replace(/metadata\.json$/, '');
  const style = new Style(meta.value.globalMin, meta.value.globalMax);
  // 用 shared 模式（即便单线）以便图层挂到统一 scene
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.setClearColor(0x0b0d12, 1);
  viewportEl.innerHTML = '<div id="viewCube" title="点击平面切换视图（前/俯/左）"></div>';
  viewportEl.appendChild(renderer.domElement);
  const scene3 = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 80000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  const host = new MultiLineHost(viewportEl, [{
    meta, basePath, worldOffset: [0, 0, 0], direction: 1,
    lineId: 'single', lineIdx: 0, visible: true, style,
  }]);
  // ↑ 注：MultiLineHost 接受 lineCfgs；为避免单线"空 host"歧义，可改用 VolumeScene(self)。
  //   简单路径：把单线装成一行 lineCfgs 走 bootMulti 的同一条管线。
  // ... 后续与原 bootSingle 完全一致（stylePanel/sliceView/gpsMapView/viewCube/frame loop）。
}
```

**简化决策**：T12 接受"单线模式仍走原 bootSingle；多线模式经 manifest 入口"。具体 main.js 改造：

1. 顶部读 `?src=` 与 `sources.json`。
2. 列表填充 `#sourceSelect`（DOM 在 T5 已加容器），change 写 `location.search` 触发重载。
3. boot 成功**之后**：从 `layersLoad()` 恢复 CSV / 配准 / 钻孔剖面（具体调用在 T7 装配的 `handleFileDrop` 中复用解析 + 重建 group）。
4. 在 boreholePanel "生成剖面连线" / 切源 前，`layersSave({ csvText, alignPairs, sectionBoreholeIds })`。

恢复例（在 handleFileDrop 已存在的前提下，boot 完成后追加）：

```js
const restored = layersLoad();
if (restored && restored.csvText) {
  const r = parseBoreholeCsv(restored.csvText);
  const align = solveSimilarity(restored.alignPairs && restored.alignPairs.length
    ? restored.alignPairs : [{ from: [r.boreholes[0].x, r.boreholes[0].y], to: [0, 0] }]);
  const { group, pickables: pks } = buildBoreholeGroup(r.boreholes, align);
  pickables = pks;
  boreholeLayer = lm.add({ id: 'boreholes', label: `钻孔 (${r.boreholes.length})`, object3D: group, builtin: false, visible: true });
  currentAlign = align;
  // 恢复剖面连线
  if (restored.sectionBoreholeIds && restored.sectionBoreholeIds.length) {
    const ordered = restored.sectionBoreholeIds.map(id => r.boreholes.find(b => b.id === id)).filter(Boolean);
    onLinkMake(ordered);
  }
  boreholePanel = createBoreholePanel(document.getElementById('boreholePanel'), { boreholes: r.boreholes, pickables, onPick, onLinkMake, onLinkClear });
}
```

- [ ] **Step 3: 写一个最小 `dataset/sources.json` 示例（用户后续可改）**

`dataset/sources.json`：

```json
[
  { "id": "mingxingroad", "name": "明星路（多线）", "kind": "manifest", "url": "/dataset/lines/manifest.json" },
  { "id": "single", "name": "默认单线 metadata.json", "kind": "single", "url": "/dataset/metadata.json" }
]
```

- [ ] **Step 4: 视觉验证**

1. `npm run dev` 默认走第一项；切到 #sourceSelect 第二项 → 整页重载 → 自动回退到 single；切回第一项 → 整页重载 → 之前的钻孔 + 剖面连线应自动恢复（localStorage 命中）
2. `npm test` 全绿
3. 注意：rAF throttle 伪影不影响此处（截图为 1Hz 抓的是稳定态）

- [ ] **Step 5: Commit**

```bash
git add src/io/layerStore.js src/main.js dataset/sources.json
git commit -m "feat: 数据源切换（URL参数 + sources.json + localStorage 恢复图层）"
```

---

### Task 13: DXF 导入预览（解析 + 三维化 + 与 CSV 配准复用）

**Files:**
- Create: `src/io/dxfLoader.js`
- Create: `src/layers/dxfLayer.js`
- Test: `tests/dxfLoader.test.js`
- Modify: `package.json`（新增 `dxf-parser` 依赖）

**Interfaces:**
- `parseDxf(text) -> Array<Entity>`：entity 类型 `line | polyline | circle | arc | text`；line/polyline: `pts: [x,y][]`、可选 `closed`；circle: `c: [x,y], r`；arc: `c, r, a0, a1`（弧度）；text: `p, text`。
- `buildDxfGroup(entities, align) -> { group, pickables: [] }`：LINE/POLYLINE → THREE.Line / LineLoop；CIRCLE → EllipseCurve + LineLoop 采样 64 段；ARC → EllipseCurve + LineLoop 采样 64 段；TEXT → sprite。颜色按 ACI 简单映射（红/黄/绿/青/蓝/品红/白/灰）。场地坐标经 `align` 转换到世界，z=0 平面（DXF 多为 2D 工程图）。
- 消费方：T7 handleFileDrop 扩展（按 `.dxf` 走 dxfLoader + dxfLayer，注册 `lm.add({id:'dxf'})`）；T12 localStorage 同样存/恢复 DXF 文本。

- [ ] **Step 1: 安装 dxf-parser**

```bash
cd d:/study/code/cplus/gpr_slice/web && npm i dxf-parser
```

- [ ] **Step 2: 写失败测试** `tests/dxfLoader.test.js`

```js
import { describe, it, expect } from 'vitest';
import { parseDxf } from '../src/io/dxfLoader.js';

const DXF = `
0
SECTION
2
ENTITIES
0
LINE
8
0
62
5
10
0
20
0
30
0
11
100
21
0
31
0
0
LWPOLYLINE
90
3
70
1
10
0.0
20
0.0
10
50.0
20
0.0
10
50.0
20
30.0
0
CIRCLE
10
10
20
10
40
5
0
ARC
10
0
20
0
40
10
50
0
51
90
0
TEXT
10
5
20
5
1
HELLO
0
ENDSEC
0
EOF
`.trim();

describe('parseDxf', () => {
  const r = parseDxf(DXF);
  it('解析 LINE → line + 2 点', () => {
    const e = r.find(x => x.type === 'line' && x.pts.length === 2 && x.pts[0][0] === 0);
    expect(e).toBeTruthy();
    expect(e.pts[1]).toEqual([100, 0]);
    expect(e.color).toBe(5);
  });
  it('LWPOLYLINE 闭合 3 点 → polyline closed', () => {
    const e = r.find(x => x.type === 'line' && x.pts.length === 3);
    expect(e.closed).toBe(true);
  });
  it('CIRCLE → 圆心半径', () => {
    const e = r.find(x => x.type === 'circle');
    expect(e.c).toEqual([10, 10]);
    expect(e.r).toBe(5);
  });
  it('ARC → 圆心半径 + 起止角(度)', () => {
    const e = r.find(x => x.type === 'arc');
    expect(e.a0).toBe(0); expect(e.a1).toBe(90);
  });
  it('TEXT 提取', () => {
    const e = r.find(x => x.type === 'text');
    expect(e.text).toBe('HELLO');
  });
  it('无效文本抛错', () => {
    expect(() => parseDxf('garbage')).toThrow();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test` → FAIL。

- [ ] **Step 4: 实现 `src/io/dxfLoader.js`**

```js
// io/dxfLoader.js —— DXF 文本 → 图元数组（依赖 dxf-parser，MIT）
import DxfParser from 'dxf-parser';

export function parseDxf(text) {
  let dxf;
  try { dxf = new DxfParser().parseSync(text); }
  catch (err) { throw new Error('DXF 解析失败：' + err.message); }
  const out = [];
  for (const e of dxf.entities || []) {
    if (e.type === 'LINE' && e.vertices && e.vertices.length >= 2) {
      out.push({ type: 'line', pts: e.vertices.map(v => [v.x, v.y]), color: e.color || 7 });
    } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      if (e.vertices && e.vertices.length >= 2) {
        out.push({ type: 'line', pts: e.vertices.map(v => [v.x, v.y]), closed: !!e.shape, color: e.color || 7 });
      }
    } else if (e.type === 'CIRCLE') {
      out.push({ type: 'circle', c: [e.center.x, e.center.y], r: e.radius, color: e.color || 7 });
    } else if (e.type === 'ARC') {
      // dxf-parser 弧度制
      out.push({ type: 'arc', c: [e.center.x, e.center.y], r: e.radius, a0: e.startAngle, a1: e.endAngle, color: e.color || 7 });
    } else if (e.type === 'TEXT' || e.type === 'MTEXT') {
      const p = e.position || e.startPoint || { x: 0, y: 0 };
      out.push({ type: 'text', p: [p.x, p.y], text: e.text || '', color: e.color || 7 });
    }
  }
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test` → 全部 PASS。

- [ ] **Step 6: 实现 `src/layers/dxfLayer.js`**

```js
// layers/dxfLayer.js —— DXF 图元 → three.Group（场地坐标经 align → 世界，z=0 平面）
import * as THREE from 'three';
import { applySimilarity } from '../io/boreholeAlign.js';

const ACI = { 1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x4d9fff, 6: 0xff00ff, 7: 0xffffff, 8: 0x808080 };

function colorCss(aci) { return '#' + (ACI[aci] ?? 0xdddddd).toString(16).padStart(6, '0'); }

function makeTextSprite(text, color) {
  const ctx0 = document.createElement('canvas').getContext('2d');
  ctx0.font = '20px system-ui';
  const w = Math.ceil(ctx0.measureText(text).width) + 8;
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = 22;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, w, 22);
  ctx.fillStyle = color; ctx.font = '18px system-ui'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 4, 11);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat); sp.scale.set(w / 20, 22 / 20, 1); sp.renderOrder = 990;
  return sp;
}

function arcPoints(c, r, a0, a1, seg = 64) {
  // dxf-parser ARC: startAngle/endAngle 弧度
  if (a1 < a0) a1 += Math.PI * 2;
  const out = [];
  for (let i = 0; i <= seg; i++) { const a = a0 + (a1 - a0) * (i / seg); out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
  return out;
}

export function buildDxfGroup(entities, align) {
  const group = new THREE.Group(); group.name = 'dxf';
  for (const e of entities) {
    const col = colorCss(e.color);
    if (e.type === 'line') {
      const pts3 = e.pts.map(p => { const [wx, wy] = applySimilarity(align, p); return new THREE.Vector3(wx, wy, 0.03); });
      const line = (e.closed && pts3.length >= 3) ? new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts3), new THREE.LineBasicMaterial({ color: col })) : new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3), new THREE.LineBasicMaterial({ color: col }));
      group.add(line);
    } else if (e.type === 'circle') {
      const seg = 64; const pts = [];
      for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; pts.push(applySimilarity(align, [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)])); }
      const pts3 = pts.map(p => new THREE.Vector3(p[0], p[1], 0.03));
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts3), new THREE.LineBasicMaterial({ color: col })));
    } else if (e.type === 'arc') {
      const pts = arcPoints(e.c, e.r, e.a0, e.a1).map(p => applySimilarity(align, p));
      const pts3 = pts.map(p => new THREE.Vector3(p[0], p[1], 0.03));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3), new THREE.LineBasicMaterial({ color: col })));
    } else if (e.type === 'text') {
      const [wx, wy] = applySimilarity(align, e.p);
      const sp = makeTextSprite(e.text, col); sp.position.set(wx, wy, 0.5);
      group.add(sp);
    }
  }
  return { group };
}
```

- [ ] **Step 7: main.js handleFileDrop 扩展 `.dxf`**

```js
import { parseDxf } from './io/dxfLoader.js';
import { buildDxfGroup } from './layers/dxfLayer.js';

// handleFileDrop 内部：
} else if (name.endsWith('.dxf')) {
  const text = await file.text();
  const entities = parseDxf(text);
  const align = currentAlign || solveSimilarity([{ from:[0,0], to:[0,0] }]);
  if (lm.get('dxf')) lm.remove('dxf');
  const { group } = buildDxfGroup(entities, align);
  lm.add({ id: 'dxf', label: `DXF (${entities.length} 图元)`, object3D: group, builtin: false, visible: true });
  // 持久化
  layersSave({ csvText: currentCsvText, alignPairs: currentAlignPairs, sectionBoreholeIds: currentSectionIds, dxfText: text });
}
```

并在 CSV 解析后把 `csvText / alignPairs / sectionBoreholeIds` 写到 `currentXxx` 变量 + `layersSave(...)`。

恢复时同样：

```js
if (restored && restored.dxfText) {
  const entities = parseDxf(restored.dxfText);
  const align = currentAlign || solveSimilarity([{ from:[0,0], to:[0,0] }]);
  const { group } = buildDxfGroup(entities, align);
  lm.add({ id: 'dxf', label: `DXF (${entities.length} 图元)`, object3D: group, builtin: false, visible: true });
}
```

- [ ] **Step 8: 视觉验证**

准备最小 DXF（用项目里 `tests/dxfLoader.test.js` 那段 DXF 文本落盘到 `dataset/sample.dxf` 临时测试），拖入 → 图层面板出现 "DXF (N)"，场景 z=0 平面出现线/圆/弧/文字（场地坐标系，未经配准时位置在原点附近，配准后随配准对平移旋转）。`npm test` 仍全绿。

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/io/dxfLoader.js src/layers/dxfLayer.js tests/dxfLoader.test.js src/main.js
git commit -m "feat: DXF 导入预览（dxf-parser + z=0 平面渲染 + 与 CSV 同 align）"
```

---

### Task 14: 端到端走查 + 已知小遗漏收口

**Files:**
- Modify: `index.html` / `src/main.js` 微调（CSS 微调、面板初始隐藏态、节流钩子）
- Create: `docs/superpowers/plans/2026-09-02-stage1-walkthrough.md`（端到端验证脚本）

- [ ] **Step 1: 端到端手动脚本**（写进 `docs/superpowers/plans/2026-09-02-stage1-walkthrough.md`）

```md
# 阶段一端到端验证

1. 启动 `npm run dev`，访问 http://localhost:5177
2. 默认加载明星路多线（10+ 条测线），图层面板出现 "场景参照"（builtin），可关闭
3. 色带面板显示 "振幅色标"；切换 viridis/magma/gray-red，体色与色带同步
4. 拖入 `web/从煤气到地层编码.csv`：
   - boreholePanel 出现，列表展示 ~20+ 孔号；位置默认平移到原点（配准待补）
   - 场景出现分层彩色柱（默认 align 是 [首孔 → 世界 (0,0)]）
5. 拾取：单击某柱段 → 面板顶部出现该孔分层表
6. 勾选 3 孔 → "生成剖面连线" → 场景出现红折线 + 序号旗标
7. "沿钻孔连线剖面" → 浮窗出现剖面图（与两孔连线方向一致，深度向下）
8. "任意角度剖面" → 视口画线模式；画 3 点 → 双击 → 浮窗出现新剖面
9. "测量" → 单击两点 → 中点出现距离标签
10. 拖入 `dataset/sample.dxf` → 图层出现 DXF，z=0 平面有线/圆/弧
11. 切换 #sourceSelect → 整页重载 → 钻孔 + 剖面 + DXF 自动恢复
12. 移动相机 → 比例尺条长变化（节流生效，文字稳定）
13. `npm test` 全绿
```

- [ ] **Step 2: 把任务散落的 micro-遗漏收口**

本计划在多任务的 main.js 装配段写了若干 `setInterval` 节流（legend/比例尺）；统一抽到一个 `src/main.js` 末尾的节流循环（避免多处 setInterval）：

```js
// 节流循环（统一管理 legend / 比例尺 / HUD）
let _lastUiTick = 0;
setInterval(() => {
  const now = performance.now();
  if (now - _lastUiTick < 250) return;
  _lastUiTick = now;
  if (window.__legend) window.__legend.update();
  if (window.__gizmos) window.__gizmos.update(scaleBar);
}, 250);
window.__legend = legend; window.__gizmos = gizmos;
```

（把 main.js 中 T7/T12 各处 setInterval 删掉，引用此统一循环。）

- [ ] **Step 3: 启动 dev + 走查**

按 walkthrough.md 逐条跑；任何失败回到对应任务。

- [ ] **Step 4: Commit**

```bash
git add src/main.js docs/superpowers/plans/2026-09-02-stage1-walkthrough.md
git commit -m "chore: 节流循环统一 + 阶段一端到端走查"
```

---

## Self-Review（撰写者自检）

- **覆盖性**：共识阶段一的 9 项功能（CSV 拖入/L1 柱状/剖面连线/任意剖切/测量/图层/数据源切换/DXF 预览/场景参照/配色图例）→ T2-T13 全部覆盖。**DWG** 显式按共识推迟到阶段三。
- **坐标语义**：所有新增图层（T7/T8/T10/T11/T13）严格使用 X 沿轨/Y 跨轨/Z 深度向下、地面 Z=0；T9 给出世界→局部逆变换公式，T11 复用体素 mesh 世界坐标自然一致。
- **解耦**：LayerManager 持有 root Group 挂到 scene；borehole/DXF/sectionLink/gizmo 都是独立图层对象，可独立开关、删除；数据源切换 = URL 重载 + localStorage 恢复，不依赖场景 teardown。
- **Placeholder 扫描**：本计划中无 "TBD" / "实现略" / "类似" 之类。代码块完整可粘贴。所有 Task 1-14 都有具体步骤 + 代码 + 提交命令。
- **类型/名称一致性**：LayerManager.add / remove / setVisible / get / list / onChange 在 T5 定义，T7/T8/T12/T13 复用一致；`align` 始终是 `{a,b,tx,ty,scale}`；`pickables` 始终是 `Mesh[]`（带 `userData.pick`）；`sampler.sampleProfile` 返回 `{cols,rows,data,extents,stepM,zStepM,minZ}` 在 T9/T10 一致。

## 执行交接

**计划已落盘：** `d:/study/code/cplus/gpr_slice/docs/superpowers/plans/2026-09-02-web-stage1-pro.md`。

**两个执行方式：**

1. **Subagent-Driven（推荐）** —— 每个任务派一个干净子代理执行（专注、隔离、可重跑），我每任务做两段审（实现审 + 自我验证），支持中途改方向。
2. **Inline Execution** —— 在当前会话按 T1→T14 顺序执行，每完成一个任务暂停汇报，整批可检点用。

你选哪种？或者还有计划里哪段要先调整（任务切分、依赖顺序、范围）？

