# 主视图其它测线瓦片"不全/转动后闪现"修复 —— shader 坐标框架混用

## Context

用户报：主视图中**其它测线的瓦片显示不全**，有些瓦片**鼠标转动视角后又能显示**。怀疑相机裁剪问题。

**浏览器实测结论（本会话 eval 证据链）**：视锥剔除是正确的（`_frustumTest` 已正确交换镜像线 min/max）。真正的根因是 **brickRenderer.js 的光追 shader 把「局部坐标的盒」和「世界坐标的相机/片元」混在一起算**：

- 顶点着色器：`vWorldPos = modelMatrix * position` → **世界坐标**（含 group 的 worldOffset 平移 + direction 镜像）。
- 片元着色器（66-68 行）：
  ```glsl
  vec3 ro = (cameraPosition - uBoxMin) / uBoxSize;   // cameraPosition 世界
  vec3 rd = (vWorldPos - uBoxMin) / uBoxSize - ro;   // vWorldPos 世界
  ```
  但 `uBoxMin`/`uBoxSize`（`createBrickMesh` 130-135 行）是用 **meta.origin 局部坐标**算的 → 坐标系不匹配 → 射线起点/方向偏出单位立方体 [0,1]³ → 片元级 `tFar <= tNear` 直接丢弃 → 瓦片透明。
- 误差随相机 X 变化 → 转到某个角度射线恰好扫过立方体 → 瓦片"闪现"。

### 证据（每线首片 uBoxMin vs 几何真实世界 AABB min，单位 m）

| 线 | dir | worldOffset | uBoxMin.x | worldMin.x | X 误差 |
|---|---|---|---|---|---|
| 001 | +1 | [0, -0.44, 0] | 2211.53 | 2211.53 | **0**（仅 Y 误差 0.44 → 能渲染） |
| 002 | -1 | [2200.95, 1.25, 0] | 0.00 | 2100.43 | **-2100.43** → 不可见 |
| 003 | +1 | [-14.14, -1.53, 0] | 2211.53 | 2197.39 | **+14.14** → 不可见 |
| 004/008/010/012/015 | -1 | ≈2200 | 0.00 | ≈2100 | ≈-2100 → 不可见 |
| 006/009/011/016 | +1 | x≈-1~-22 | 2211.53 | 2190~2210 | 13~22 → 不可见 |

只有 line 001（worldOffset.x=0、dir=+1）X 对齐、Y 误差仅 0.44m（< 盒高 1.37m）→ 是唯一"看起来完整"的线。与用户现象完全吻合。

> 为什么不能简单把 `uBoxMin` 换成世界 AABB：反向线（dir=-1）数据是**采集顺序**（trace-0=调查起点，南端），世界摆放靠 `group.scale.x=-1` 镜像。若用世界 AABB 直接做采样，lp 的 x 轴会相对体局部 x 反向 → 反向线沿轨数据整体镜像错位。**正确做法是把世界坐标逆变换回局部体坐标系再算射线**，采样顺序天然保持。

## 根因

`web/src/render/brickRenderer.js`：
- 66-68 行 ro/rd 计算：`uBoxMin`/`uBoxSize`（局部）与 `cameraPosition`/`vWorldPos`（世界）混用。
- 41 行注释错误声称 `uBoxMin` 是"世界最小角"（实际是局部）。

已知正确的世界→局部逆变换（`volumeScene.js _toWorld` 224-231 的反函数，group 只有平移 + x 镜像）：
```
local = (world - worldOffset) * (direction, 1, 1)
```
group 设置见 `volumeScene.js` 96-98 行：`group.position = worldOffset`、`group.scale.x = direction`。

## 修复（Approach 2：shader 内世界→局部逆变换）

### 1. `web/src/render/brickRenderer.js`

**片元着色器**（FRAG 66-68 行）新增两个 uniform + 逆变换，ro/rd 全部回到局部空间：
```glsl
uniform vec3  uWorldOffset;   // 测线 worldOffset（世界平移）
uniform float uMirrorX;       // 测线 direction（±1，反向线 x 镜像）
...
void main() {
  vec3 lCam  = vec3((cameraPosition.x - uWorldOffset.x) * uMirrorX,
                    cameraPosition.y - uWorldOffset.y,
                    cameraPosition.z - uWorldOffset.z);
  vec3 lFrag = vec3((vWorldPos.x - uWorldOffset.x) * uMirrorX,
                    vWorldPos.y - uWorldOffset.y,
                    vWorldPos.z - uWorldOffset.z);
  vec3 ro = (lCam  - uBoxMin) / uBoxSize;   // 局部坐标射线
  vec3 rd = (lFrag - uBoxMin) / uBoxSize - ro;
  // 其余不变：lp = ro + rd*t ∈ [0,1]³ 局部盒，tc = (lp*uCoreSize + uGhost)/uStoreSize
  // 采样方向对 dir=±1 均正确（lFrag 已含镜像还原）。
}
```
顶点着色器 VERT 不动（`vWorldPos` 保持世界坐标，供逆变换）。

**`createBrickMesh`**（uniforms 146-147 行附近）新增：
```js
uWorldOffset: { value: new THREE.Vector3(...(opts.worldOffset || [0, 0, 0])) },
uMirrorX:     { value: opts.direction ?? 1 },
```
同时把 41 行注释 `// 核心区世界最小角` 改为 `// 核心区【局部】最小角（世界→局部由 uWorldOffset/uMirrorX 还原）`，防止后人再混用。

`wmin`/`size`、`mesh.position`/`mesh.scale` 保持局部坐标不变（group 负责世界摆放）。

### 2. `web/src/render/volumeScene.js`

`createMesh`（653-657 行）给 `createBrickMesh` 的 opts 传入当前线的摆放参数：
```js
const { mesh } = createBrickMesh(tile, this.meta, style, {
  linear: this.linearOK,
  geometry: this.sharedGeo,
  steps: this.stepsFor(tile),
  worldOffset: this.worldOffset,   // 新增
  direction: this.direction,       // 新增
});
```
单线回退无需改：`this.worldOffset` 默认 `[0,0,0]`、`this.direction` 默认 `1`（volumeScene.js 53-54 行）→ 新 uniform 为恒等，行为与修复前单线一致。

## 验证

1. **重启 dev server**（若未在跑：`cd web && npm run dev`），浏览器打开 `http://localhost:5177/`。
2. **每线首片一致性 eval**（用 `window.__THREE__`）：
   - 取每线任一在场景中的 mesh，算其世界 AABB min，套用 `l = (w - worldOffset)*(direction,1,1)`，断言 **l == mesh.material.uniforms.uBoxMin.value**（每个分量 < 1e-3）。
   - 修复前该断言对 002/003 等线误差达数十~数千米；修复后应全部通过。
3. **视觉**：12 条测线瓦片全部显示；隐藏 001 后其余各线连续完整；旋转/缩放视角不再有"闪现"的瓦片。
4. **反向线沿轨方向**：对比 C-Scan 全宽合成（已按 road 参考系正确反转 X）与 3D 中同一条反向线（002/004/008/010/012/015）的特征走向一致（修复采用世界→局部还原，采样顺序自动正确，无额外镜像）。
5. **回归**：单线回退路径（删/改 manifest 或直接访问单线 dataset）正常渲染；FPS 不受影响（无额外每帧开销，仅两个 uniform）。

## 关键文件
- `web/src/render/brickRenderer.js` — 片元着色器 ro/rd 世界→局部逆变换 + 新增 `uWorldOffset`/`uMirrorX` uniform + 注释修正
- `web/src/render/volumeScene.js` — `createMesh` 传 `worldOffset`/`direction`
