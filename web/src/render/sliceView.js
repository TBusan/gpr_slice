// render/sliceView.js —— B-Scan / C-Scan 切片视图（MVP）
//
// 数据源：已加载 mesh 的 Data3DTexture.image（Float32Array），不重复拉取、不加第二套缓存。
// 重建：把已加载瓦片 stamp 进固定分辨率网格（粗→细，细级覆盖粗级；同级的核心区互不重叠，
//       所以单级拼接天然无缝），再按共享 Style（gain → normalize → gamma → threshold → colorMap）
//       映射到 canvas。
// B-Scan：固定通道 Y=k（0..13）→ (x, z) 二维切片。
// C-Scan：固定深度 Z=k（L0 样本序号）→ (x, y) 二维切片。
//
// 注意纹理布局（brickRenderer）：Data3DTexture.image 长度 = storeW*storeH*storeD，x 最快：
//   idx = (sz*storeH + sy)*storeW + sx；store = 核心 + ghost（各维 +2g）。提取用核心坐标。

const MAX_X = 2048; // 沿轨显示分辨率上限（L0 X=45307，canvas 远小于此，显示足够）
const MAX_Z = 1024;

export class SliceView {
  constructor(scene, style, meta) {
    this.scene = scene;
    this.style = style;
    this.meta = meta;

    this.ghost = meta.ghost;
    this.aabb = meta.volumeAABB();
    this.xRange = this.aabb.max[0] - this.aabb.min[0];
    this.zRange = this.aabb.max[2] - this.aabb.min[2];

    const L0 = meta.levelMap.get(0);
    this.zSamples = L0.dims[2];       // 深度样本数（L0，781）
    this.channelCount = L0.dims[1];   // 通道数（14）
    this.channel = 0;                 // B-Scan 通道
    this.depth = Math.floor(this.zSamples / 2); // C-Scan 深度（L0 样本）

    this.gridX = Math.min(L0.dims[0], MAX_X);
    this.gridZ = Math.min(this.zSamples, MAX_Z);
    this.gridY = this.channelCount;
    this.gridB = new Float32Array(this.gridX * this.gridZ);
    this.gridC = new Float32Array(this.gridX * this.gridY);

    // 重建门控：瓦片集合（version）或滑块/样式变化才重算网格，避免每帧全量 stamp。
    // 快速平移/缩放的流式加载会每帧 bump version → 重建用 100ms 节流合并（网格最多滞后 100ms）。
    this._lastVersion = -1;
    this._styleKeyCache = null;
    this._dirty = false;
    this._lastRebuildAt = 0;

    this._buildUI();
  }

  _buildUI() {
    this.chanSlider = document.getElementById('chanSlider');
    this.depthSlider = document.getElementById('depthSlider');
    this.bCap = document.getElementById('bscanCap');
    this.cCap = document.getElementById('cscanCap');
    this.bCanvas = document.getElementById('bscanCanvas');
    this.cCanvas = document.getElementById('cscanCanvas');
    this.bCtx = this.bCanvas.getContext('2d');
    this.cCtx = this.cCanvas.getContext('2d');

    this.chanSlider.max = String(this.channelCount - 1);
    this.depthSlider.max = String(this.zSamples - 1);
    this.depthSlider.value = String(this.depth);

    this.chanSlider.addEventListener('input', () => {
      this.channel = Number(this.chanSlider.value);
      this.bCap.textContent = `B-Scan 通道 ${this.channel}`;
      this._dirty = true;
    });
    this.depthSlider.addEventListener('input', () => {
      this.depth = Number(this.depthSlider.value);
      this.cCap.textContent = `C-Scan 深度 ${this.depth}`;
      this._dirty = true;
    });
  }

  // 每帧门控：无数据跳过；瓦片版本/滑块/样式变化才重建或重渲染。
  // 相机移动不改变切片数据，故不在此触发重建。
  update() {
    if (this.scene.loaded.size === 0) return;
    const styleKey = this._styleKey();
    const tilesChanged = this._lastVersion !== this.scene.version;
    const styleChanged = styleKey !== this._styleKeyCache;
    if (!this._dirty && !tilesChanged && !styleChanged) return;

    const now = performance.now();
    const doRebuild = this._dirty || (tilesChanged && now - this._lastRebuildAt > 100);
    if (doRebuild) {
      this._rebuild();
      this._lastRebuildAt = now;
    }
    if (styleChanged || this._dirty || (tilesChanged && doRebuild)) {
      this._renderCanvas(this.bCanvas, this.bCtx, this.gridB, this.gridZ);
      this._renderCanvas(this.cCanvas, this.cCtx, this.gridC, this.gridY);
    }
    this._lastVersion = this.scene.version;
    this._styleKeyCache = styleKey;
    this._dirty = false;
  }

  // 样式指纹：任一渲染参数或色带变化都要重绘 canvas（网格可复用）。
  _styleKey() {
    const s = this.style;
    return `${s.minValue}|${s.maxValue}|${s.gain}|${s.gamma}|` +
      `${s.thresholdMin}|${s.thresholdMax}|${s.opacity}|${s.colorMap ? s.colorMap.uuid : 0}`;
  }

  // 把所有已加载瓦片 stamp 进网格：level 降序（粗→细），细级覆盖粗级。
  // NaN 表示「该格无数据」，渲染时映成黑（空单元不被当成真实值 0）。
  _rebuild() {
    const g = this.ghost;
    const { gridX, gridZ } = this;
    this.gridB.fill(NaN);
    this.gridC.fill(NaN);

    const meshes = [...this.scene.meshes.values()]
      .sort((a, b) => b.userData.header.level - a.userData.header.level);

    for (const mesh of meshes) {
      const u = mesh.material.uniforms.uVolume.value;
      const data = u.image.data; // Float32Array，x 最快（three 的 DataTexture.image 是 {data,w,h,d}）
      const hdr = mesh.userData.header;
      const sw = hdr.width, sh = hdr.height, sd = hdr.depth;
      const L = hdr.level;
      const sp = this.meta.levelInfo(L).spacing;
      const [sx, sy, sz] = sp;
      const cw = hdr.width - 2 * g, ch = hdr.height - 2 * g, cd = hdr.depth - 2 * g;
      const minX = this.aabb.min[0] + hdr.x * this.meta.tileW * sx;
      const minY = this.aabb.min[1] + hdr.y * this.meta.tileH * sy;
      const minZ = this.aabb.min[2] + hdr.z * this.meta.tileD * sz;

      // ---- B-Scan：固定通道这一行 (x, z) ----
      // 粗级瓦片是下采样后的体素，每个体素的世界尺寸覆盖多个网格单元。
      // 按体素足迹填充 spanX×spanZ 块（最近邻上采样），避免网格留黑缝（断断续续）。
      const k = this.channel;
      if (k < ch) {
        const syStore = g + k;
        const spanX = Math.max(1, Math.round(sx / this.xRange * (gridX - 1)));
        const spanZ = Math.max(1, Math.round(sz / this.zRange * (gridZ - 1)));
        const out = this.gridB;
        for (let szc = 0; szc < cd; szc++) {
          const gzBase = Math.round((minZ + szc * sz - this.aabb.min[2]) / this.zRange * (gridZ - 1));
          const rowBase = (g + szc) * sh * sw + syStore * sw + g;
          for (let sxc = 0; sxc < cw; sxc++) {
            const gxBase = Math.round((minX + sxc * sx - this.aabb.min[0]) / this.xRange * (gridX - 1));
            const v = data[rowBase + sxc];
            for (let dzg = 0; dzg < spanZ; dzg++) {
              const gz = gzBase + dzg;
              if (gz < 0 || gz >= gridZ) continue;
              const row = gz * gridX;
              for (let dxg = 0; dxg < spanX; dxg++) {
                const gx = gxBase + dxg;
                if (gx < 0 || gx >= gridX) break;
                out[row + gx] = v;
              }
            }
          }
        }
      }

      // ---- C-Scan：固定深度这一行 (x, y) ----
      const wantZ = this.aabb.min[2] + this.depth * this.meta.levelMap.get(0).spacing[2];
      const szc = Math.round((wantZ - minZ) / sz);
      if (szc >= 0 && szc < cd) {
        const out = this.gridC;
        const spanX = Math.max(1, Math.round(sx / this.xRange * (gridX - 1)));
        for (let syc = 0; syc < ch; syc++) {
          const rowBase = (g + szc) * sh * sw + (g + syc) * sw + g;
          for (let sxc = 0; sxc < cw; sxc++) {
            const gxBase = Math.round((minX + sxc * sx - this.aabb.min[0]) / this.xRange * (gridX - 1));
            const v = data[rowBase + sxc];
            const row = syc * gridX;
            for (let dxg = 0; dxg < spanX; dxg++) {
              const gx = gxBase + dxg;
              if (gx < 0 || gx >= gridX) break;
              out[row + gx] = v;
            }
          }
        }
      }
    }
  }

  _renderCanvas(canvas, ctx, grid, gridH) {
    this._sizeCanvas(canvas);
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;

    let img = canvas._img;
    if (!img || img.width !== w || img.height !== h) {
      img = canvas._img = ctx.createImageData(w, h);
    }
    const out = img.data;
    const style = this.style;
    const cm = style.colorMap;
    const cmData = this._cmapData();
    // 色带数据不可用时（理论上不会）：跳过绘制，保留上一帧内容，避免画布被清成黑。
    if (!cmData) return;
    const { gridX } = this;
    const gw = gridX - 1, gh = gridH - 1, cw = w - 1, chh = h - 1;

    let p = 0;
    for (let py = 0; py < h; py++) {
      const gz = Math.round(py / chh * gh);
      const row = gz * gridX;
      for (let px = 0; px < w; px++) {
        const gx = Math.round(px / cw * gw);
        const c = shade(style, cmData, grid[row + gx]);
        out[p++] = c[0];
        out[p++] = c[1];
        out[p++] = c[2];
        out[p++] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    canvas.style.opacity = String(style.opacity);
  }

  // 色带像素数据：three CanvasTexture.image 是 canvas，不是 ImageData；
  // 首次或色带更换时用 2D 上下文取 RGBA。缓存 Uint8ClampedArray。
  // 兜底：读不到任何像素时用内置灰阶（黑→白），保证 _renderCanvas 永不因空数据中断。
  _cmapData() {
    const cm = this.style.colorMap;
    if (cm === this._cmTex) return this._cmData;
    this._cmTex = cm;
    const src = cm.image;
    let data = null;
    if (src && src.getContext) {
      data = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    } else if (src && src.data) {
      data = src.data;
    }
    if (!data || data.length < 1024) {
      data = new Uint8ClampedArray(1024);
      for (let i = 0; i < 256; i++) {
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = i;
        data[i * 4 + 3] = 255;
      }
    }
    this._cmData = data;
    return data;
  }

  _sizeCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || 100;
    const ch = canvas.clientHeight || 100;
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
}

// 与 fragment shader 一致的标量→颜色映射（threshold 在 gain 之前判断）
function shade(style, cmData, val) {
  if (!(val >= style.thresholdMin && val <= style.thresholdMax)) return [0, 0, 0];
  let n = (val * style.gain - style.minValue) / (style.maxValue - style.minValue);
  n = Math.max(0, Math.min(1, n));
  n = Math.pow(n, style.gamma);
  return colorAt(cmData, n);
}

// 线性采样 256×1 色带（与 GPU LinearFilter + ClampToEdge 一致）
function colorAt(cmData, n) {
  const f = n * 255;
  const i0 = Math.min(255, Math.max(0, Math.floor(f)));
  const i1 = Math.min(255, i0 + 1);
  const fr = f - i0;
  const o0 = i0 * 4, o1 = i1 * 4;
  return [
    Math.round(cmData[o0] * (1 - fr) + cmData[o1] * fr),
    Math.round(cmData[o0 + 1] * (1 - fr) + cmData[o1 + 1] * fr),
    Math.round(cmData[o0 + 2] * (1 - fr) + cmData[o1 + 2] * fr),
  ];
}
