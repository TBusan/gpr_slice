// render/volumeScene.js —— 3D 体渲染主场景
//
// LOD：递归细分，每个空间区域恰好选一个级别的瓦片（多 LOD 共存，§27）。
//   粗级瓦片离得远时直接渲染，相机靠近则细分到更细级；视锥剔除 + 距离阈值。
// 渲染：可见瓦片按相机距离背向排序（远→近 renderOrder），back-to-front 预乘混合。
// 加载：并发受限队列 + LRU 缓存（限制 GPU 纹理内存），淘汰时 dispose。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createBrickMesh } from './brickRenderer.js';
import { loadTile } from '../dataset/tileLoader.js';
import { TileCache } from '../lod/tileCache.js';

// 各级细分阈值：相机到瓦片中心 > 阈值 → 该级足够，渲染；更近 → 细分。
// voxelPx(L) = s*(H/2)/(d*tan(fov/2))；令 =2px → d = s*(H/2)/(2*tan(fov/2))
function buildThresholds(meta, viewportHeight, fovDeg) {
  const k = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  const th = new Map();
  for (const li of meta.levels) {
    th.set(li.level, Math.max(...li.spacing) * k / 2);
  }
  return th;
}

const MAX_IN_FLIGHT = 6;

// 瓦片 key 统一为 "level/x/y/z"
const kkey = (l, x, y, z) => `${l}/${x}/${y}/${z}`;

export class VolumeScene {
  constructor(container, meta, opts = {}) {
    // opts: { shared, basePath, worldOffset, direction, lineId, lineIdx, visible }
    //   shared = { renderer, scene, camera, controls, cache }：多测线时复用同一渲染器/相机/缓存。
    //   basePath / worldOffset / direction / lineId / lineIdx：多测线摆放与瓦片 URL 前缀。
    //   self 模式（无 shared）：保持原有单线行为（自建渲染器 + 自己的 rAF 循环）。
    this.meta = meta;
    this.container = container;
    this.basePath = opts.basePath || '/dataset';
    this.worldOffset = opts.worldOffset || [0, 0, 0];
    this.direction = opts.direction ?? 1;
    this.lineId = opts.lineId || null;  // 共享缓存 key 前缀（如 "mingxingroad_001/"）
    this.lineIdx = opts.lineIdx ?? 0;   // 跨线全局 renderOrder 稳定排序 tie-breaker
    this.visible = opts.visible !== false;
    this.shared = opts.shared || null;
    this.ownsRender = !this.shared;     // self 模式才自建渲染器 + 自己的渲染循环

    if (this.shared) {
      this.renderer = this.shared.renderer;
      this.scene = this.shared.scene;
      this.camera = this.shared.camera;
      this.controls = this.shared.controls;
      this.cache = this.shared.cache;
    } else {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x0b0d12, 1);
      container.appendChild(renderer.domElement);
      this.renderer = renderer;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 80000);
      this.controls = new OrbitControls(this.camera, renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.maxDistance = 40000;
      this.controls.minDistance = 0.5;

      this.cache = new TileCache(this.cacheLimit());
    }

    this.style = null; // main.js 注入

    // 纹理线性过滤（ghost 三线性插值的前提）。
    // HalfFloat（R16F）线性过滤是 WebGL2 核心能力；仅 WebGL1 回退才需要扩展。
    this.linearOK = this.renderer.capabilities.isWebGL2 ||
      !!this.renderer.extensions.get('OES_texture_half_float_linear');

    this.sharedGeo = new THREE.BoxGeometry(1, 1, 1);

    // 多测线：每线一个 group（worldOffset 平移 + 反向线 scale.x = -1 镜像）。
    // self 模式 group 恒等变换（0,0,0 / +1），行为不变。
    this.group = new THREE.Group();
    this.group.position.set(this.worldOffset[0], this.worldOffset[1], this.worldOffset[2]);
    this.group.scale.x = this.direction;
    if (this.ownsRender) this.scene.add(this.group);

    this.tilesByLevel = this.buildTileIndex(meta);

    // 缓存 + 场景 mesh + 加载状态
    this.meshes = new Map();   // key -> mesh（含不在场景中的，LRU 淘汰才删除）
    this.loaded = new Set();   // 已成功加载（含已淘汰的则被移出）
    this.inFlight = new Map(); // key -> Promise
    this.queued = new Set();   // 已在加载队列中的 key（去重）
    this.queue = [];
    this.desired = new Set();  // 本帧想渲染的 key 集合
    this._autoFitted = false;  // 默认显示窗宽只自动适配一次（初始视角），之后交给用户
    this.version = 0;          // 瓦片加载/淘汰计数，供派生视图（切片等）判断数据是否变化

    this._thKey = null;        // W1: LOD 阈值缓存键（clientHeight|fov），变化才重算
    this._scratchV = new THREE.Vector3(); // W2: 复用临时向量，减少每帧 GC

    this.cache.onEvict(({ mesh, key }) => {
      // 共享缓存：key 带 lineId 前缀，只处理本线的淘汰（避免跨线误删）。
      if (this.lineId && !key.startsWith(this.lineId + '/')) return;
      const plain = this.lineId ? key.slice(this.lineId.length + 1) : key;
      if (mesh && mesh.parent) mesh.parent.remove(mesh);
      if (mesh) {
        mesh.material.uniforms.uVolume.value.dispose();
        mesh.material.dispose();
      }
      this.meshes.delete(plain);
      this.loaded.delete(plain);
      this.version++; // 派生视图依赖的体素集合变化
    });

    if (this.ownsRender) {
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    this.frames = 0;
    this.lastFpsAt = 0;
    this.fps = 0;
    this.loop = this.loop.bind(this);
  }

  cacheLimit() {
    // 满 tile 纹理 ≈ 258*16*34*4 ≈ 0.56MB；512 个 ≈ 287MB GPU
    return 512;
  }

  // 共享缓存 key 命名空间：多线共用缓存时前缀 lineId 防 key 冲突；self 模式原样。
  _ck(key) {
    return this.lineId ? `${this.lineId}/${key}` : key;
  }

  // 逐线可见性（多测线）：隐藏 = 组移出场景，宿主跳过其 tick（不加载、不占预算）。
  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    if (!this.ownsRender) {
      if (v) this.scene.add(this.group);
      else this.scene.remove(this.group);
    }
  }

  buildTileIndex(meta) {
    const byLevel = new Map();
    for (const li of meta.levelMap.values()) {
      const L = li.level;
      const [sx, sy, sz] = li.spacing;
      const [dx, dy, dz] = li.dims;
      const nx = Math.ceil(dx / meta.tileW);
      const ny = Math.ceil(dy / meta.tileH);
      const nz = Math.ceil(dz / meta.tileD);
      const [ox, oy, oz] = meta.origin;
      const list = [];
      const idx = new Map(); // 'x/y/z' -> tile（O(1) 子瓦片查找）
      for (let tz = 0; tz < nz; tz++) {
        for (let ty = 0; ty < ny; ty++) {
          for (let tx = 0; tx < nx; tx++) {
            const cx = Math.min(meta.tileW, dx - tx * meta.tileW) * sx;
            const cy = Math.min(meta.tileH, dy - ty * meta.tileH) * sy;
            const cz = Math.min(meta.tileD, dz - tz * meta.tileD) * sz;
            const min = new THREE.Vector3(
              ox + tx * meta.tileW * sx,
              oy + ty * meta.tileH * sy,
              oz + tz * meta.tileD * sz
            );
            const box = new THREE.Box3(min, min.clone().add(new THREE.Vector3(cx, cy, cz)));
            const t = { level: L, x: tx, y: ty, z: tz, box };
            list.push(t);
            idx.set(`${tx}/${ty}/${tz}`, t);
          }
        }
      }
      byLevel.set(L, { list, idx });
    }
    return byLevel;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frameCamera() {
    const c = new THREE.Vector3(...this.meta.volumeCenter());
    const diag = this.meta.volumeDiagonal();
    const dir = new THREE.Vector3(1, 0.55, 0.45).normalize();
    this.camera.position.copy(c).addScaledVector(dir, diag * 0.9);
    this.controls.target.copy(c);
    this.controls.update();
  }

  // 局部点 → 世界点（多测线 worldOffset 平移 + 反向线 direction 镜像）。
  // 复用传入向量，避免分配。p 为局部 Box 中心/坐标。
  _toWorld(p) {
    p.x = this.worldOffset[0] + p.x * this.direction;
    p.y = this.worldOffset[1] + p.y;
    p.z = this.worldOffset[2] + p.z;
    return p;
  }

  // ---- LOD 递归：本帧应渲染的瓦片 key 集合（每个区域恰好一个）----
  computeDesired() {
    const desired = new Set();
    const byLevel = this.tilesByLevel;
    const visit = (L, tx, ty, tz, box) => {
      // 相机在世界坐标，瓦片 box 是局部坐标 → 距离按世界点算（跨线偏移/反向镜像）
      const c = this._toWorld(box.getCenter(this._scratchV));
      const d = this.camera.position.distanceTo(c);
      if (L === 0 || d > this.thresholds.get(L)) {
        desired.add(`${L}/${tx}/${ty}/${tz}`);
        return;
      }
      // 细分到 L-1：scale=[2,1,2] → X、Z 各二分
      const L1 = L - 1;
      const level = byLevel.get(L1);
      if (!level) { desired.add(`${L}/${tx}/${ty}/${tz}`); return; }
      for (let cz = 0; cz < 2; cz++) {
        for (let cx = 0; cx < 2; cx++) {
          const child = level.idx.get(`${tx * 2 + cx}/${ty}/${tz * 2 + cz}`);
          if (!child) continue;
          if (this.frustum && !this.frustum.intersectsBox(child.box)) continue;
          visit(L1, child.x, child.y, child.z, child.box);
        }
      }
    };

    const coarse = this.meta.maxLevel;
    for (const t of byLevel.get(coarse).list) {
      if (this.frustum && !this.frustum.intersectsBox(t.box)) continue;
      visit(coarse, t.x, t.y, t.z, t.box);
    }
    return desired;
  }

  // ---- 每帧：LOD 选择 → 场景差异更新 → 发起加载 → 渲染 ----
  tick() {
    const now = performance.now();
    this.frames++;
    if (now - this.lastFpsAt > 500) {
      this.fps = this.frames * 1000 / (now - this.lastFpsAt);
      this.frames = 0;
      this.lastFpsAt = now;
    }

    // W1: 阈值只随视口高度/fov 变化（fov 固定，实际仅在 resize 时重算）
    const vh = this.renderer.domElement.clientHeight || 800;
    const vf = this.camera.fov;
    if (this._thKey !== vh + '|' + vf) {
      this._thKey = vh + '|' + vf;
      this.thresholds = buildThresholds(this.meta, vh, vf);
    }

    // 视锥剔除只对 self 模式有意义：多测线共享模式下瓦片 box 是局部坐标，
    // 与共享相机的世界视锥比较会整体误剔除跨轨偏移大的线 → 共享模式关剔除。
    this.frustum = this.ownsRender ? new THREE.Frustum() : null;
    if (this.frustum) {
      this.frustum.setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      );
    }

    const desired = this.computeDesired();

    // 新需要的瓦片入队
    for (const key of desired) {
      if (this.loaded.has(key) || this.inFlight.has(key)) continue;
      this.enqueue(key);
    }

    // desired 瓦片刷新 LRU 位置：缓存打满时优先淘汰视野外旧瓦片，
    // 避免把仍在渲染中的瓦片淘汰掉导致闪烁/空洞（LRU 淘汰回调会 dispose + 移出场景）。
    for (const key of desired) this.cache.get(this._ck(key));

    // 场景增删（LOD 过渡不产生空洞）：
    // - 非 desired 的 mesh：若它有「desired 但尚未加载」的后代，则保留在场景中作为
    //   过渡期 fallback（细瓦片加载完成前该区域仍有粗瓦片覆盖，不会黑屏）；
    //   后代全部就绪后本帧移出。fallback 也刷新 LRU，避免被淘汰。
    // - desired 的 mesh：若其粗祖先 fallback 仍在场景中，则暂不加入，
    //   避免 coarse+fine 双重重叠渲染；祖先移除后下一帧自动加入。
    const desiredParsed = [...desired].map((k) => k.split('/').map(Number));
    const fallbackKeys = new Set();
    for (const [key, mesh] of this.meshes) {
      if (!mesh.parent || desired.has(key)) continue;
      const h = mesh.userData.header;
      let need = false;
      for (const [dl, dx, dy, dz] of desiredParsed) {
        if (dl >= h.level) continue;
        const scale = 1 << (h.level - dl);
        if (dx >= h.x * scale && dx < (h.x + 1) * scale &&
            dy === h.y && dz >= h.z * scale && dz < (h.z + 1) * scale) {
          if (!this.loaded.has(kkey(dl, dx, dy, dz))) { need = true; break; }
        }
      }
      if (need) {
        fallbackKeys.add(key);
        this.cache.get(this._ck(key)); // 过渡期 fallback 也保护，防止 LRU 淘汰
      } else {
        this.group.remove(mesh);
      }
    }
    for (const key of desired) {
      const mesh = this.meshes.get(key);
      if (!mesh || mesh.parent) continue;
      const [dl, dx, dy, dz] = key.split('/').map(Number);
      let hasAncestor = false;
      for (const fk of fallbackKeys) {
        const h = this.meshes.get(fk).userData.header;
        if (h.level <= dl) continue;
        const scale = 1 << (h.level - dl);
        if (dx >= h.x * scale && dx < (h.x + 1) * scale &&
            dy === h.y && dz >= h.z * scale && dz < (h.z + 1) * scale) { hasAncestor = true; break; }
      }
      if (!hasAncestor) this.group.add(mesh);
    }

    this.desired = desired;

    // 背向排序（远→近）仅 self 模式：多测线由宿主跨线全局排序（renderOrder 需跨线一致）。
    const renderList = [...this.meshes.values()].filter(m => m.parent);
    if (this.ownsRender) {
      renderList.sort((a, b) => {
        const da = a.userData.center.distanceToSquared(this.camera.position);
        const db = b.userData.center.distanceToSquared(this.camera.position);
        return db - da;
      });
      renderList.forEach((m, i) => { m.renderOrder = i; });
    }

    if (this.style) {
      this.syncStyle();
      // 初始视角窗宽自适应只由 self 模式（单线）触发；多测线由宿主统一做一次。
      if (this.ownsRender && !this._autoFitted && this.loaded.size >= 30) this.autoFitWindow();
    }

    this.drainQueue();

    if (this.ownsRender && this.onStatus) {
      this.onStatus({
        desired: desired.size,
        loaded: this.loaded.size,
        meshes: renderList.length,
        inFlight: this.inFlight.size,
        queue: this.queue.length,
        cache: this.cache.size(),
        linear: this.linearOK,
        fps: Math.round(this.fps),
      });
    }
  }

  syncStyle() {
    const s = this.style;
    for (const mesh of this.meshes.values()) {
      if (!mesh.parent) continue; // 只同步场景内可见 mesh；隐藏 mesh 入场景当帧补齐
      const u = mesh.material.uniforms;
      u.uColorMap.value = s.colorMap;
      u.uMinValue.value = s.minValue;
      u.uMaxValue.value = s.maxValue;
      u.uGain.value = s.gain;
      u.uGamma.value = s.gamma;
      u.uThresholdMin.value = s.thresholdMin;
      u.uThresholdMax.value = s.thresholdMax;
      u.uOpacity.value = s.opacity;
    }
  }

  // 用已加载瓦片的体素分布自动设定显示窗宽（只调 minValue/maxValue 做对比度，
  // 不改 threshold，避免把强反射裁掉）。采样上限约 20 万，排序一次。
  autoFitWindow() {
    const s = this.style;
    if (!s) return;
    const samples = [];
    const N = 200000;
    for (const mesh of this.meshes.values()) {
      const u = mesh.material.uniforms.uVolume.value;
      const data = u.image.data;
      // HalfFloat 纹理的 image.data 是 Uint16Array（半精度位模式），须解码成 float，
      // 否则窗宽会落在位模式区间（如 19328..55616）而非真实值域（-7k..5k）。
      const decode = data instanceof Uint16Array
        ? (v) => THREE.DataUtils.fromHalfFloat(v)
        : (v) => v;
      const step = Math.max(1, Math.floor(data.length / 30000));
      for (let i = 0; i < data.length; i += step) samples.push(decode(data[i]));
      if (samples.length >= N) break;
    }
    if (samples.length < 1000) return;
    samples.sort((a, b) => a - b);
    const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
    let lo = q(0.05), hi = q(0.95);
    if (!(hi > lo)) return;
    if (hi - lo < 200) { // 退化解保护：分布极窄时给一个保底窗宽
      const m = 200;
      lo = -m; hi = m;
    }
    s.minValue = lo;
    s.maxValue = hi;
    if (s._inputs && s._inputs.minValue) s._inputs.minValue.value = String(Math.round(lo));
    if (s._inputs && s._inputs.maxValue) s._inputs.maxValue.value = String(Math.round(hi));
    this._autoFitted = true;
    console.log(`[auto-fit] 显示窗宽 ${lo.toFixed(0)} .. ${hi.toFixed(0)}（采样 ${samples.length}）`);
  }

  // ---- 加载队列 ----
  enqueue(key) {
    if (this.queued.has(key)) return; // 去重：每帧只入队一次
    this.queued.add(key);
    const [level, x, y, z] = key.split('/').map(Number);
    const t = this.tilesByLevel.get(level)?.idx.get(`${x}/${y}/${z}`);
    // 相机在世界坐标 → 距离用世界点（多测线偏移/镜像）
    const dist = t
      ? this.camera.position.distanceTo(this._toWorld(t.box.getCenter(this._scratchV)))
      : 0;
    this.queue.push({ key, level, dist });
  }

  drainQueue() {
    // 每帧只排一次序（粗级优先，同级近者优先）
    if (this.queue.length > 1) {
      this.queue.sort((a, b) => a.level - b.level || a.dist - b.dist);
    }
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length) {
      const item = this.queue.shift();
      this.queued.delete(item.key);
      if (this.loaded.has(item.key) || this.inFlight.has(item.key)) continue;
      this.loadTileAsync(item.key);
    }
  }

  async loadTileAsync(key) {
    const [level, x, y, z] = key.split('/').map(Number);
    const url = this.tileUrl(level, x, y, z);
    const p = loadTile(url, { ghost: this.meta.ghost, scale: 1, offset: 0 })
      .then(tile => {
        this.inFlight.delete(key);
        this.queued.delete(key);
        this.loaded.add(key);
        const mesh = this.createMesh(key, tile);
        this.meshes.set(key, mesh);
        this.cache.set(this._ck(key), { mesh, key: this._ck(key) });
        // 不入场景：统一由 tick() 按 fallback 规则决定加入时机
        // （避免细瓦片绕过祖先检查、与过渡期 coarse fallback 双重重叠渲染）。
        this.version++;
      })
      .catch(err => {
        this.inFlight.delete(key);
        this.queued.delete(key);
        console.warn(`tile ${key} load failed:`, err);
      });
    this.inFlight.set(key, p);
  }

  createMesh(key, tile) {
    const style = this.style || {
      colorMap: null, minValue: 0, maxValue: 1, gain: 1, gamma: 1,
      thresholdMin: -Infinity, thresholdMax: Infinity, opacity: 0.6,
    };
    const { mesh } = createBrickMesh(tile, this.meta, style, {
      linear: this.linearOK,
      geometry: this.sharedGeo,
      steps: this.stepsFor(tile),
    });
    mesh.userData.key = key;
    mesh.userData.lineIdx = this.lineIdx; // 跨线 renderOrder 稳定排序 tie-breaker
    return mesh;
  }

  // 自适应步数：砖在屏幕上的投影尺寸 → 每像素约 1.5 步。
  // 远景细级砖被 LOD 覆盖得只剩几十像素，走 254+ 步纯属浪费；
  // 近景满步以保证 Z 向细节。clamp [16, 192]。
  stepsFor(tile) {
    const h = this.renderer.domElement.clientHeight || 800;
    const k = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const d = this.camera.position.distanceTo(this.tileWorldCenter(tile));
    const li = this.meta.levelInfo(tile.header.level);
    const [sx, , sz] = li.spacing;
    const worldX = tile.coreSize[0] * sx;
    const worldZ = tile.coreSize[2] * sz;
    const proj = Math.max(worldX, worldZ) * k / d;
    return Math.max(16, Math.min(192, Math.round(proj * 1.5)));
  }

  tileWorldCenter(tile) {
    const li = this.meta.levelInfo(tile.header.level);
    const [sx, sy, sz] = li.spacing;
    const [ox, oy, oz] = this.meta.origin;
    // 与 createBrickMesh 的 wmin + size/2 一致（ghost 只影响纹理坐标，不影响世界位置）。
    // 返回世界坐标：多测线 worldOffset 平移 + 反向线 direction 镜像（stepsFor 距离用）。
    const v = new THREE.Vector3(
      ox + (tile.header.x * this.meta.tileW + tile.coreSize[0] / 2) * sx,
      oy + (tile.header.y * this.meta.tileH + tile.coreSize[1] / 2) * sy,
      oz + (tile.header.z * this.meta.tileD + tile.coreSize[2] / 2) * sz
    );
    return this._toWorld(v);
  }

  tileUrl(level, x, y, z) {
    const base = this.meta.storage.tilePath
      .replace('{level}', level).replace('{x}', x).replace('{y}', y).replace('{z}', z);
    return `${this.basePath}/${base}`;
  }

  // ---- 渲染循环（仅 self 模式；多测线由宿主驱动）----
  start() {
    if (!this.ownsRender) return;
    this.frameCamera();
    requestAnimationFrame(this.loop);
  }

  loop() {
    requestAnimationFrame(this.loop);
    this.controls.update();
    this.tick();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.ownsRender) window.removeEventListener('resize', this.resize);
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.material.uniforms.uVolume.value.dispose();
      mesh.material.dispose();
    }
    if (this.ownsRender) this.renderer.dispose();
  }
}
