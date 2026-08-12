// render/sliceView.js —— B-Scan / C-Scan 切片视图（与 3D 缓存解耦）
//
// 数据源：独立的 CPU 侧瓦片表。
//   单线模式：选定线整条 sliceLevel（mean 核，L4：45×1×7=315 片）。
//   多线模式：
//     B-Scan：选定线整条 sliceLevel（同上）。
//     C-Scan 单线：选定线（同 B-Scan 表）。
//     C-Scan 全宽合成：所有可见线在「当前深度」的粗级深度片（maxLevel 的 z 片，
//       每线 23 片 ≈13MB），按真实 GPS 跨轨位置拼接进全宽 cross-track 网格；
//       无测线覆盖的跨轨空隙保持 NaN（黑），短线尾部无数据也保持黑。
// 重建：粗→细 stamp，同级箱平均 + 细级覆盖；合成跨线「后线优先」。NaN = 无数据 → 黑。
// 渲染：逐像素箱平均 + 共享 Style。
//
// 注意纹理布局（brickRenderer）：Data3DTexture.image 长度 = storeW*storeH*storeD，x 最快：
//   idx = (sz*storeH + sy)*storeW + sx；store = 核心 + ghost（各维 +2g）。提取用核心坐标。

import { loadTile } from '../dataset/tileLoader.js';

const MAX_X = 2048;      // 沿轨显示分辨率上限（L0 X=45307，canvas 远小于此，显示足够）
const MAX_Z = 1024;
const MAX_CROSS_Y = 1024; // 全宽合成跨轨行数上限（12 线约 157 行，余量充足）
const CONCURRENT = 6;

// 全局加载并发限流：sliceView 各线 full/slab 共用，避免 12 线一次性拉起 72 个请求。
let _active = 0;
const _waiters = [];
function acquire() {
  return new Promise((res) => {
    if (_active < CONCURRENT) { _active++; res(); }
    else _waiters.push(res);
  });
}
function release() {
  _active--;
  const next = _waiters.shift();
  if (next) { _active++; next(); }
}

export class SliceView {
  // 单线模式：{ meta, style, basePath, loadTileFn }
  // 多线模式：lines = [{ id, name, meta, basePath, worldOffset, direction, visible }]
  constructor({ meta, style, basePath = '/dataset', loadTileFn = loadTile, lines = null }) {
    this.style = style;
    this.loadTileFn = loadTileFn;

    if (Array.isArray(lines) && lines.length) {
      this.multi = true;
      this.lines = lines;
    } else {
      this.multi = false;
      this.lines = [{
        id: null, name: 'single', meta, basePath,
        worldOffset: [0, 0, 0], direction: 1, visible: true,
      }];
    }
    this.lines.forEach((line, i) => {
      line.lineIdx = i;
      line.aabb = line.meta.volumeAABB();
      line.full = new Map(); // 整条 sliceLevel（仅选定线加载）
      line.slab = new Map(); // 当前深度粗级深度片（可见线）
      line.slabZ = -1;
      line.fullGen = 0;
      line.slabGen = 0;
      line.version = 0;
    });

    this.selected = 0;
    this.channel = 0;
    this.depth = Math.floor(this.zSamples() / 2);
    this.cscanMode = 'single'; // 多线可由 UI 切 'composite'；单线模式锁定 single

    const m0 = this.lines[0].meta;
    this.ghost = m0.ghost;
    this._version = 0; // 全局版本：任一线的瓦片增删/切源 bump，update() 据此重算
    this._loadGen = 0;

    // 兼容字段（浏览器检查脚本读 __slice.tiles / .slice / .grid*）
    this.tiles = this.selLine().full;
    this.slice = this.selLine().meta.sliceInfo();
    this.gridX = MAX_X;
    this.gridY = this.channelCount(); // 单线 C-Scan 行 = 通道
    this.gridZ = 0;
    this._allocB();

    // 单线 C-Scan 网格
    this.gridC = new Float32Array(this.gridX * this.gridY);
    this.accC = new Float32Array(this.gridX * this.gridY);
    this.cntC = new Int32Array(this.gridX * this.gridY);
    this.claimC = new Int8Array(this.gridX * this.gridY);

    // 全宽合成网格（跨轨行数按可见线并集动态算）
    this.gridComp = new Float32Array(0);
    this.accComp = new Float32Array(0);
    this.cntComp = new Int32Array(0);
    this.claimComp = new Int8Array(0);
    this.compGridX = 0;
    this.compGridY = 0;
    this.compXMin = 0; this.compXRange = 1;
    this.crossMin = 0; this.crossRange = 1;
    this._computeComposite();

    // 重建门控：瓦片集合（version）或滑块/样式变化才重算网格
    this._lastVersion = -1;
    this._styleKeyCache = null;
    this._dirty = false;
    this._lastRebuildAt = 0;

    // 画布→网格 区间表缓存（box-average 用）
    this._rangeCache = new Map();

    this._buildUI();
    this._ensureFull(this.selLine());
    this._updateCaps();
  }

  selLine() { return this.lines[this.selected]; }
  zSamples() { return this.selLine().meta.levelMap.get(0).dims[2]; }
  channelCount() { return this.selLine().meta.levelMap.get(0).dims[1]; }

  // ---- 多线 API ----
  setSelected(idx) {
    idx = Math.max(0, Math.min(this.lines.length - 1, idx));
    if (idx === this.selected) return;
    // 释放旧线整条表（省 176MB），重载新线
    const old = this.lines[this.selected];
    old.fullGen++; old.full.clear(); old.version++;
    this.selected = idx;
    const line = this.selLine();
    line.fullGen++; line.full.clear();
    this.tiles = line.full;
    this.slice = line.meta.sliceInfo();
    this._allocB();
    const zs = this.zSamples();
    this.depthSlider.max = String(zs - 1);
    this.depth = Math.min(this.depth, zs - 1);
    this.depthSlider.value = String(this.depth);
    this._ensureFull(line);
    this._version++;
    this._dirty = true;
    this._updateCaps();
  }

  setVisible(lineId, visible) {
    const line = this.lines.find(l => l.id === lineId);
    if (!line || line.visible === visible) return;
    line.visible = visible;
    if (!visible) { line.slabGen++; line.slab.clear(); line.version++; }
    this._computeComposite();
    this._version++;
    this._dirty = true;
  }

  setCscanMode(mode) {
    if (!this.multi) mode = 'single';
    if (mode === this.cscanMode) return;
    this.cscanMode = mode;
    this._dirty = true;
    if (mode === 'composite') this._syncSlabs();
    this._updateCaps();
  }

  // 单线模式兼容：切换 basePath 重载整条表
  setSource(basePath) {
    const line = this.selLine();
    if (basePath === line.basePath && line.full.size > 0) return;
    line.basePath = basePath;
    line.fullGen++; line.full.clear();
    this._version++;
    this._dirty = true;
    this._ensureFull(line);
  }

  dispose() {
    for (const line of this.lines) {
      line.fullGen++; line.slabGen++;
      line.full.clear(); line.slab.clear();
    }
    this._version++;
  }

  // ---- 加载 ----
  // 选定线整条 sliceLevel（覆盖全深度 × 全通道）
  _ensureFull(line) {
    if (line.full.size > 0) return;
    line.fullGen++;
    const m = line.meta;
    const sl = m.sliceInfo();
    const L = sl.level;
    const [dx, dy, dz] = sl.dims;
    const nx = Math.ceil(dx / m.tileW);
    const ny = Math.ceil(dy / m.tileH);
    const nz = Math.ceil(dz / m.tileD);
    const keys = [];
    for (let tz = 0; tz < nz; tz++)
      for (let ty = 0; ty < ny; ty++)
        for (let tx = 0; tx < nx; tx++)
          keys.push(`${L}/${tx}/${ty}/${tz}`);
    this._loadKeys(line, line.full, 'fullGen', keys);
  }

  // 每个可见线在「当前深度」的粗级深度片：只加载 z 片（23 片/线 ≈13MB），
  // 深度滑块跨片（2.5m/片）才重载。
  _syncSlabs() {
    for (const line of this.lines) {
      if (!line.visible) {
        if (line.slab.size) { line.slabGen++; line.slab.clear(); line.version++; }
        continue;
      }
      const m = line.meta;
      const wantZ = this.depth * m.levelMap.get(0).spacing[2];
      const L = m.maxLevel;
      const li = m.levelMap.get(L);
      const tileD = m.tileD;
      const zTile = Math.floor((wantZ - m.origin[2]) / (tileD * li.spacing[2]));
      const nz = Math.ceil(li.dims[2] / tileD);
      if (zTile < 0 || zTile >= nz) { // 该线在此深度无数据（如 011-016 较浅）
        if (line.slab.size) { line.slabGen++; line.slab.clear(); line.version++; }
        line.slabZ = zTile;
        continue;
      }
      if (line.slabZ === zTile && line.slab.size > 0) continue;
      line.slabZ = zTile;
      line.slabGen++;
      line.slab.clear();
      const [dx, dy] = li.dims;
      const nx = Math.ceil(dx / m.tileW);
      const ny = Math.ceil(dy / m.tileH);
      const keys = [];
      for (let ty = 0; ty < ny; ty++)
        for (let tx = 0; tx < nx; tx++)
          keys.push(`${L}/${tx}/${ty}/${zTile}`);
      this._loadKeys(line, line.slab, 'slabGen', keys);
    }
  }

  // 并发受限地加载一批瓦片到 store（full/slab）。genName 变化即作废在途结果。
  _loadKeys(line, store, genName, keys) {
    const gen = line[genName];
    let idx = 0;
    const worker = async () => {
      while (idx < keys.length) {
        if (gen !== line[genName]) return;
        const key = keys[idx++];
        const [L, x, y, z] = key.split('/').map(Number);
        await acquire();
        try {
          if (gen !== line[genName]) return;
          const tile = await this.loadTileFn(this.tileUrlFor(line, L, x, y, z), {
            ghost: line.meta.ghost, scale: 1, offset: 0,
          });
          if (gen !== line[genName]) return;
          if (store !== line.full && store !== line.slab) return; // 防错引
          store.set(key, tile);
          line.version++;
          this._version++;
        } catch (err) {
          if (gen !== line[genName]) return;
          console.warn(`slice tile ${key} failed:`, err);
        } finally {
          release();
        }
      }
    };
    Promise.all(Array.from({ length: Math.min(CONCURRENT, Math.max(1, keys.length)) }, worker));
  }

  tileUrlFor(line, level, x, y, z) {
    const base = line.meta.storage.tilePath
      .replace('{level}', level).replace('{x}', x).replace('{y}', y).replace('{z}', z);
    return `${line.basePath}/${base}`;
  }

  // 兼容旧版单线 API
  tileUrl(level, x, y, z) {
    return this.tileUrlFor(this.selLine(), level, x, y, z);
  }

  // ---- UI ----
  _buildUI() {
    this.chanSlider = document.getElementById('chanSlider');
    this.depthSlider = document.getElementById('depthSlider');
    this.bCap = document.getElementById('bscanCap');
    this.cCap = document.getElementById('cscanCap');
    this.bCanvas = document.getElementById('bscanCanvas');
    this.cCanvas = document.getElementById('cscanCanvas');
    this.bCtx = this.bCanvas.getContext('2d');
    this.cCtx = this.cCanvas.getContext('2d');

    this.chanSlider.max = String(this.channelCount() - 1);
    this.depthSlider.max = String(this.zSamples() - 1);
    this.depthSlider.value = String(this.depth);

    this.chanSlider.addEventListener('input', () => {
      this.channel = Number(this.chanSlider.value);
      this._dirty = true;
      this._updateCaps();
    });
    this.depthSlider.addEventListener('input', () => {
      this.depth = Number(this.depthSlider.value);
      this._dirty = true;
      this._updateCaps();
    });
  }

  _updateCaps() {
    const sel = this.selLine();
    this.bCap.textContent = `B-Scan ${sel.name} 通道 ${this.channel}`;
    this.cCap.textContent = this.cscanMode === 'composite'
      ? `C-Scan 全宽 深度 ${this.depth}`
      : `C-Scan ${sel.name} 深度 ${this.depth}`;
  }

  // ---- 每帧门控：无数据跳过；瓦片版本/滑块/样式变化才重建或重渲染 ----
  update() {
    if (this._version === 0) return;
    if (this.cscanMode === 'composite') this._syncSlabs();
    const styleKey = this._styleKey();
    const tilesChanged = this._lastVersion !== this._version;
    const styleChanged = styleKey !== this._styleKeyCache;
    if (!this._dirty && !tilesChanged && !styleChanged) return;

    const now = performance.now();
    const doRebuild = this._dirty || (tilesChanged && now - this._lastRebuildAt > 100);
    if (doRebuild) {
      this._rebuildB();
      if (this.cscanMode === 'composite') this._rebuildCComposite();
      else this._rebuildCSingle();
      this._lastRebuildAt = now;
    }
    if (styleChanged || this._dirty || (tilesChanged && doRebuild)) {
      this._renderCanvas(this.bCanvas, this.bCtx, this.gridB, this.gridX, this.gridZ);
      if (this.cscanMode === 'composite')
        this._renderCanvas(this.cCanvas, this.cCtx, this.gridComp, this.compGridX, this.compGridY);
      else
        this._renderCanvas(this.cCanvas, this.cCtx, this.gridC, this.gridX, this.gridY);
    }
    this._lastVersion = this._version;
    this._styleKeyCache = styleKey;
    this._dirty = false;
  }

  // 级别间距：sliceLevel 不在 levelMap（级别号不连续），单独查；其余走 levelMap。
  _spacingFor(meta, level) {
    if (meta.sliceLevel && level === meta.sliceLevel.level) return meta.sliceLevel.spacing;
    return meta.levelInfo(level).spacing;
  }

  // 样式指纹：任一渲染参数或色带变化都要重绘 canvas（网格可复用）。
  _styleKey() {
    const s = this.style;
    return `${s.minValue}|${s.maxValue}|${s.gain}|${s.gamma}|` +
      `${s.thresholdMin}|${s.thresholdMax}|${s.opacity}|${s.colorMap ? s.colorMap.uuid : 0}`;
  }

  _allocB() {
    const gz = Math.min(this.zSamples(), MAX_Z);
    if (gz === this.gridZ) return;
    this.gridZ = gz;
    this.gridB = new Float32Array(this.gridX * gz);
    this.accB = new Float32Array(this.gridX * gz);
    this.cntB = new Int32Array(this.gridX * gz);
    this.claimB = new Int8Array(this.gridX * gz);
  }

  // 全宽合成网格几何：跨轨范围 = 可见线 [crossOffset±halfWidth] 并集；X = 沿轨世界并集。
  _computeComposite() {
    let crossMin = Infinity, crossMax = -Infinity, xMin = Infinity, xMax = -Infinity;
    for (const line of this.lines) {
      if (!line.visible) continue;
      const m = line.meta;
      const chY = this._channelOffsetsY(m);
      crossMin = Math.min(crossMin, line.worldOffset[1] + chY[0]);
      crossMax = Math.max(crossMax, line.worldOffset[1] + chY[chY.length - 1]);
      const l0 = m.levelMap.get(0);
      const Xmax = l0.dims[0] * l0.spacing[0];
      const w0 = line.worldOffset[0];
      const w1 = line.worldOffset[0] + Xmax * line.direction;
      xMin = Math.min(xMin, w0, w1);
      xMax = Math.max(xMax, w0, w1);
    }
    const l0 = this.lines[0].meta.levelMap.get(0);
    if (crossMin === Infinity) { // 无可见线：空网格
      this.compGridX = 1; this.compGridY = 1;
      this.compXMin = 0; this.compXRange = 1;
      this.crossMin = 0; this.crossRange = 1;
      this.gridComp = new Float32Array(1);
      this.accComp = new Float32Array(1);
      this.cntComp = new Int32Array(1);
      this.claimComp = new Int8Array(1);
      return;
    }
    this.compXMin = xMin;
    this.compXRange = (xMax - xMin) || 1;
    this.crossMin = crossMin;
    this.crossRange = (crossMax - crossMin) || 1;
    this.compGridX = Math.min(MAX_X, Math.max(2, Math.round(this.compXRange / l0.spacing[0])));
    this.compGridY = Math.min(MAX_CROSS_Y, Math.max(1, Math.round(this.crossRange / l0.spacing[1]) + 1));
    const n = this.compGridX * this.compGridY;
    this.gridComp = new Float32Array(n);
    this.accComp = new Float32Array(n);
    this.cntComp = new Int32Array(n);
    this.claimComp = new Int8Array(n);
  }

  _channelOffsetsY(m) {
    if (m.channelOffsetsY) return m.channelOffsetsY;
    const l0 = m.levelMap.get(0);
    const a = [];
    for (let i = 0; i < l0.dims[1]; i++) a.push(m.origin[1] + i * l0.spacing[1]);
    return a;
  }

  // 把所有已加载瓦片 stamp 进网格：level 降序（粗→细）。
  // 同级箱平均 + 细级覆盖（claim 记录占用格的瓦片级别）。NaN 表示「该格无数据」→ 黑。
  _rebuildB() {
    const line = this.selLine();
    const g = this.ghost;
    const { gridX, gridZ } = this;
    const accB = this.accB, cntB = this.cntB, claimB = this.claimB;
    accB.fill(0); cntB.fill(0); claimB.fill(-1);
    const aabb = line.aabb;
    const xRange = aabb.max[0] - aabb.min[0];
    const zRange = aabb.max[2] - aabb.min[2];

    const tiles = [...line.full.values()].sort((a, b) => b.header.level - a.header.level);
    for (const tile of tiles) {
      const { header, f32: data } = tile;
      const sw = header.width, sh = header.height;
      const L = header.level;
      const [sx, sy, sz] = this._spacingFor(line.meta, L);
      const cw = sw - 2 * g, ch = sh - 2 * g, cd = header.depth - 2 * g;
      const minX = aabb.min[0] + header.x * line.meta.tileW * sx;
      const minZ = aabb.min[2] + header.z * line.meta.tileD * sz;

      // ---- B-Scan：固定通道这一行 (x, z) ----
      const k = this.channel;
      if (k >= ch) continue;
      const syStore = g + k;
      const spanX = Math.max(1, Math.round(sx / xRange * (gridX - 1)));
      const spanZ = Math.max(1, Math.round(sz / zRange * (gridZ - 1)));
      for (let szc = 0; szc < cd; szc++) {
        const gzBase = Math.round((minZ + szc * sz - aabb.min[2]) / zRange * (gridZ - 1));
        const rowBase = (g + szc) * sh * sw + syStore * sw + g;
        for (let sxc = 0; sxc < cw; sxc++) {
          const gxBase = Math.round((minX + sxc * sx - aabb.min[0]) / xRange * (gridX - 1));
          const v = data[rowBase + sxc];
          for (let dzg = 0; dzg < spanZ; dzg++) {
            const gz = gzBase + dzg;
            if (gz < 0 || gz >= gridZ) continue;
            const row = gz * gridX;
            for (let dxg = 0; dxg < spanX; dxg++) {
              const gx = gxBase + dxg;
              if (gx < 0 || gx >= gridX) break;
              const idx = row + gx;
              if (claimB[idx] !== L) { claimB[idx] = L; accB[idx] = v; cntB[idx] = 1; }
              else { accB[idx] += v; cntB[idx]++; }
            }
          }
        }
      }
    }
    for (let i = 0; i < this.gridB.length; i++) this.gridB[i] = cntB[i] > 0 ? accB[i] / cntB[i] : NaN;
  }

  // 单线 C-Scan：固定深度这一行 (x, y=通道)。
  _rebuildCSingle() {
    const line = this.selLine();
    const g = this.ghost;
    const { gridX, gridY } = this;
    const accC = this.accC, cntC = this.cntC, claimC = this.claimC;
    accC.fill(0); cntC.fill(0); claimC.fill(-1);
    const aabb = line.aabb;
    const xRange = aabb.max[0] - aabb.min[0];
    const wantZ = aabb.min[2] + this.depth * line.meta.levelMap.get(0).spacing[2];

    const tiles = [...line.full.values()].sort((a, b) => b.header.level - a.header.level);
    for (const tile of tiles) {
      const { header, f32: data } = tile;
      const sw = header.width, sh = header.height;
      const L = header.level;
      const [sx, sy, sz] = this._spacingFor(line.meta, L);
      const cw = sw - 2 * g, ch = sh - 2 * g, cd = header.depth - 2 * g;
      const minX = aabb.min[0] + header.x * line.meta.tileW * sx;
      const minZ = aabb.min[2] + header.z * line.meta.tileD * sz;

      const szc = Math.round((wantZ - minZ) / sz);
      if (szc < 0 || szc >= cd) continue;
      const spanX = Math.max(1, Math.round(sx / xRange * (gridX - 1)));
      for (let syc = 0; syc < ch; syc++) {
        const rowBase = (g + szc) * sh * sw + (g + syc) * sw + g;
        for (let sxc = 0; sxc < cw; sxc++) {
          const gxBase = Math.round((minX + sxc * sx - aabb.min[0]) / xRange * (gridX - 1));
          const v = data[rowBase + sxc];
          const row = syc * gridX;
          for (let dxg = 0; dxg < spanX; dxg++) {
            const gx = gxBase + dxg;
            if (gx < 0 || gx >= gridX) break;
            const idx = row + gx;
            if (claimC[idx] !== L) { claimC[idx] = L; accC[idx] = v; cntC[idx] = 1; }
            else { accC[idx] += v; cntC[idx]++; }
          }
        }
      }
    }
    for (let i = 0; i < this.gridC.length; i++) this.gridC[i] = cntC[i] > 0 ? accC[i] / cntC[i] : NaN;
  }

  // 全宽合成 C-Scan：固定深度行按真实跨轨位置拼进全宽网格。
  //   X：世界沿轨（反向线 worldOffset[0] + localX*direction 逆序映射）
  //   Y：跨轨行 = round((crossOffset + channelOffsetY − crossMin)/spacing)
  //   跨线「后线优先」：claim 记 lineIdx，不同线覆盖（空隙保持 NaN 黑）。
  _rebuildCComposite() {
    const g = this.ghost;
    const { compGridX, compGridY } = this;
    const acc = this.accComp, cnt = this.cntComp, claim = this.claimComp;
    acc.fill(0); cnt.fill(0); claim.fill(-1);

    for (const line of this.lines) {
      if (!line.visible || line.slab.size === 0) continue;
      const m = line.meta;
      const chY = this._channelOffsetsY(m);
      const wantZ = this.depth * m.levelMap.get(0).spacing[2];
      const tiles = [...line.slab.values()].sort((a, b) => b.header.level - a.header.level);
      for (const tile of tiles) {
        const { header, f32: data } = tile;
        const sw = header.width, sh = header.height;
        const L = header.level;
        const [sx, sy, sz] = this._spacingFor(m, L);
        const cw = sw - 2 * g, ch = sh - 2 * g, cd = header.depth - 2 * g;
        const minX = line.aabb.min[0] + header.x * m.tileW * sx;
        const minZ = line.aabb.min[2] + header.z * m.tileD * sz;

        const szc = Math.round((wantZ - minZ) / sz);
        if (szc < 0 || szc >= cd) continue;
        const dir = line.direction;
        const w0 = line.worldOffset[0];
        const cOff = line.worldOffset[1];
        const claimKey = line.lineIdx; // 跨线覆盖：不同线互不平均
        for (let syc = 0; syc < ch; syc++) {
          const gChannel = header.y * m.tileH + syc;
          const crossY = cOff + chY[gChannel];
          const row = Math.round((crossY - this.crossMin) / this.crossRange * (compGridY - 1));
          if (row < 0 || row >= compGridY) continue;
          const rowBase = (g + szc) * sh * sw + (g + syc) * sw + g;
          for (let sxc = 0; sxc < cw; sxc++) {
            const worldX = w0 + (minX + sxc * sx) * dir;
            const gx = Math.round((worldX - this.compXMin) / this.compXRange * (compGridX - 1));
            if (gx < 0 || gx >= compGridX) continue;
            const idx = row * compGridX + gx;
            const v = data[rowBase + sxc];
            if (claim[idx] !== claimKey) { claim[idx] = claimKey; acc[idx] = v; cnt[idx] = 1; }
            else { acc[idx] += v; cnt[idx]++; }
          }
        }
      }
    }
    for (let i = 0; i < this.gridComp.length; i++) this.gridComp[i] = cnt[i] > 0 ? acc[i] / cnt[i] : NaN;
  }

  // 逐像素箱平均：每输出像素取其覆盖的源网格区间均值（NaN 感知，全 NaN → 黑）。
  _renderCanvas(canvas, ctx, grid, gridW, gridH) {
    this._sizeCanvas(canvas);
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;

    let img = canvas._img;
    if (!img || img.width !== w || img.height !== h) {
      img = canvas._img = ctx.createImageData(w, h);
    }
    const out = img.data;
    const style = this.style;
    const cmData = this._cmapData();
    if (!cmData) return;
    const cols = this._rangeTable(w, gridW);
    const rows = this._rangeTable(h, gridH);

    let p = 0;
    for (let py = 0; py < h; py++) {
      const [rz0, rz1] = rows[py];
      for (let px = 0; px < w; px++) {
        const [rx0, rx1] = cols[px];
        let sum = 0, n = 0;
        for (let r = rz0; r < rz1; r++) {
          const row = r * gridW;
          for (let c = rx0; c < rx1; c++) {
            const v = grid[row + c];
            if (v === v) { sum += v; n++; } // NaN 感知
          }
        }
        const c = n ? shade(style, cmData, sum / n) : [0, 0, 0];
        out[p++] = c[0];
        out[p++] = c[1];
        out[p++] = c[2];
        out[p++] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    canvas.style.opacity = String(style.opacity);
  }

  // 输出像素 i 覆盖的源网格索引区间 [a, b)。网格列 c 的区间为 [c, c+1)，
  // 像素 i 覆盖 [i*gridN/outN, (i+1)*gridN/outN)；至少取 1 格。
  _rangeTable(outN, gridN) {
    const key = `${outN}/${gridN}`;
    let t = this._rangeCache.get(key);
    if (!t) {
      t = new Array(outN);
      for (let i = 0; i < outN; i++) {
        const a = i * gridN / outN;
        const b = (i + 1) * gridN / outN;
        let c0 = Math.floor(a);
        let c1 = Math.max(c0 + 1, Math.ceil(b));
        c1 = Math.min(c1, gridN);
        c0 = Math.min(c0, gridN - 1);
        t[i] = [c0, c1];
      }
      this._rangeCache.set(key, t);
    }
    return t;
  }

  // 色带像素数据：three CanvasTexture.image 是 canvas，不是 ImageData；
  // 首次或色带更换时用 2D 上下文取 RGBA。兜底：内置灰阶，保证 _renderCanvas 不中断。
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
