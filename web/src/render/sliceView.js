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
    });
    this.depthSlider.addEventListener('input', () => {
      this.depth = Number(this.depthSlider.value);
      this.cCap.textContent = `C-Scan 深度 ${this.depth}`;
    });
  }

  // 每帧：无数据则跳过；有数据则重建网格并渲染两张 canvas
  update() {
    if (this.scene.loaded.size === 0) return;
    this._rebuild();
    this._renderCanvas(this.bCanvas, this.bCtx, this.gridB, this.gridZ);
    this._renderCanvas(this.cCanvas, this.cCtx, this.gridC, this.gridY);
  }

  // 把所有已加载瓦片 stamp 进网格：level 降序（粗→细），细级覆盖粗级。
  _rebuild() {
    const g = this.ghost;
    const { gridX, gridZ } = this;
    this.gridB.fill(0);
    this.gridC.fill(0);

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
      const k = this.channel;
      if (k < ch) {
        const syStore = g + k;
        for (let szc = 0; szc < cd; szc++) {
          const worldZ = minZ + szc * sz;
          const gz = Math.min(gridZ - 1, Math.max(0,
            Math.round((worldZ - this.aabb.min[2]) / this.zRange * (gridZ - 1))));
          const rowBase = (g + szc) * sh * sw + syStore * sw + g;
          const out = this.gridB;
          for (let sxc = 0; sxc < cw; sxc++) {
            const worldX = minX + sxc * sx;
            const gx = Math.min(gridX - 1, Math.max(0,
              Math.round((worldX - this.aabb.min[0]) / this.xRange * (gridX - 1))));
            out[gz * gridX + gx] = data[rowBase + sxc];
          }
        }
      }

      // ---- C-Scan：固定深度这一行 (x, y) ----
      const wantZ = this.aabb.min[2] + this.depth * this.meta.levelMap.get(0).spacing[2];
      const szc = Math.round((wantZ - minZ) / sz);
      if (szc >= 0 && szc < cd) {
        const out = this.gridC;
        for (let syc = 0; syc < ch; syc++) {
          const rowBase = (g + szc) * sh * sw + (g + syc) * sw + g;
          for (let sxc = 0; sxc < cw; sxc++) {
            const worldX = minX + sxc * sx;
            const gx = Math.min(gridX - 1, Math.max(0,
              Math.round((worldX - this.aabb.min[0]) / this.xRange * (gridX - 1))));
            out[syc * gridX + gx] = data[rowBase + sxc];
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
  _cmapData() {
    const cm = this.style.colorMap;
    if (cm === this._cmTex) return this._cmData;
    this._cmTex = cm;
    const src = cm.image;
    if (src && src.getContext) {
      this._cmData = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    } else {
      this._cmData = (src && src.data) || null;
    }
    return this._cmData;
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
