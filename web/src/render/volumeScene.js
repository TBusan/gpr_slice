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

// LOD 交叉过渡时长（ms）：旧瓦片淡出 + 新瓦片淡入同步进行，避免硬切。
const FADE_MS = 200;

// LOD 迟滞系数：已选本级的瓦片在 d < th*HYST_KEEP 才细分（更接近才切细），
// 未选本级的瓦片在 d > th*HYST_SWITCH 才切回本级（更远才切粗）。
// 在 th*[HYST_KEEP, HYST_SWITCH] 之间形成死区——旋转/阻尼时相机位置摆动使
// 距离围绕阈值震荡，无迟滞时 desired 会在细/粗两级每帧翻转，交叉淡入淡出
// 被反复触发 → 画面瓦片来回闪烁。死区让级别只在明显跨过边界时切换一次。
const HYST_KEEP = 0.8;
const HYST_SWITCH = 1.2;
// 移出视锥瓦片的延迟移除帧数：连续 N 帧不在 desired 且移出视锥才真正移除，
// 配合交叉淡出，抑制旋转时视锥边缘瓦片反复增删（重载、闪烁）。
const REMOVE_GRACE = 6;

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
    this._frustum = new THREE.Frustum();  // 世界视锥（共享/self 模式都用）
    this._frustumBox = new THREE.Box3();  // 局部 box → 世界 AABB 测试复用
    this._proj = new THREE.Matrix4();     // 视锥投影矩阵复用

    this._transitions = new Map(); // key -> { mesh, mode, start, dur, from }：LOD 交叉淡入淡出登记
    this._grace = new Map();       // key -> 连续不在 desired 且移出视锥的帧数（延迟移除滞回）

    this.limiter = this.shared ? (this.shared.limiter || null) : null; // 全局瓦片加载并发预算（多线共享；self 模式用 MAX_IN_FLIGHT）

    this._styleFp = null; // syncStyle 样式指纹：8 项参数未变则跳过逐 mesh uniform 写入

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
      this._grace.delete(plain);
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

  // 世界视锥测试：瓦片 box 是局部坐标（多测线 worldOffset 平移 + 反向线 direction 镜像），
  // 转成世界 AABB 再测（镜像线 x 取 [min*d, max*d] 排序）。复用 scratch，不分配。
  _frustumTest(box) {
    const [ox, oy, oz] = this.worldOffset;
    const d = this.direction;
    let x0 = ox + box.min.x * d, x1 = ox + box.max.x * d;
    if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
    const b = this._frustumBox;
    b.min.set(x0, oy + box.min.y, oz + box.min.z);
    b.max.set(x1, oy + box.max.y, oz + box.max.z);
    return this._frustum.intersectsBox(b);
  }

  // 瓦片（局部 box）是否在视锥内：区分「视锥内错误 LOD → 立即交叉替换」与
  // 「移出视锥 → 延迟移除（滞回）」。box 从 tile index O(1) 查，复用 _frustumTest。
  _inFrustum(key) {
    const p = key.split('/');
    const lv = this.tilesByLevel.get(+p[0]);
    const t = lv && lv.idx.get(`${p[1]}/${p[2]}/${p[3]}`);
    if (!t) return true; // 查不到（理论上已加载必有）→ 按在视锥内处理，走立即替换
    return this._frustumTest(t.box);
  }

  // 向上走祖先：返回 key 的所有更粗祖先（"level/x/y/z"，X/Z 各减半），到 maxLevel 为止。
  _ancestorsOf(key) {
    const p = key.split('/');
    let L = +p[0], x = +p[1], y = +p[2], z = +p[3];
    const res = [];
    while (L < this.meta.maxLevel) {
      L++; x >>= 1; z >>= 1;
      res.push(kkey(L, x, y, z));
    }
    return res;
  }

  // 登记交叉淡入/淡出。淡入 fade 0→1；淡出从当前 fade→0，结束时移出场景。
  _startFade(mesh, mode) {
    const key = mesh.userData.key;
    const now = performance.now();
    if (mode === 'in') {
      mesh.userData.fade = 0;
      this._transitions.set(key, { mesh, mode, start: now, dur: FADE_MS });
    } else {
      this._transitions.set(key, {
        mesh, mode, start: now, dur: FADE_MS,
        from: mesh.userData.fade ?? 1,
      });
    }
  }

  // ---- LOD 递归：本帧应渲染的瓦片 key 集合（每个区域恰好一个）----
  computeDesired() {
    const desired = new Set();
    const byLevel = this.tilesByLevel;
    const visit = (L, tx, ty, tz, box) => {
      // 相机在世界坐标，瓦片 box 是局部坐标 → 距离按世界点算（跨线偏移/反向镜像）
      const c = this._toWorld(box.getCenter(this._scratchV));
      const d = this.camera.position.distanceTo(c);
      if (L === 0) { desired.add(`${L}/${tx}/${ty}/${tz}`); return; }
      // LOD 迟滞：按上一帧该瓦片是否已选本级，把细分/合并阈值分开成死区。
      // this.desired 在 tick 末尾更新，此处仍是上一帧的集合（计算在更新前）。
      const was = this.desired.has(`${L}/${tx}/${ty}/${tz}`);
      const thNow = this.thresholds.get(L) * (was ? HYST_KEEP : HYST_SWITCH);
      if (d > thNow) {
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
          if (!this._frustumTest(child.box)) continue;
          visit(L1, child.x, child.y, child.z, child.box);
        }
      }
    };

    const coarse = this.meta.maxLevel;
    for (const t of byLevel.get(coarse).list) {
      if (!this._frustumTest(t.box)) continue;
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

    // 世界视锥（共享/self 模式都用）：瓦片 box 是局部坐标，测试时由 _frustumTest 转世界 AABB。
    // matrixWorldInverse 由 renderer.render 更新，而 tick 先于 render 运行；阻尼移动/首帧时
    // 用上一帧矩阵会滞后一帧 → 这里手动 updateMatrixWorld + 求逆，保证当帧视锥正确。
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this._proj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._proj);

    const desired = this.computeDesired();

    // 新需要的瓦片入队
    for (const key of desired) {
      if (this.loaded.has(key) || this.inFlight.has(key)) continue;
      this.enqueue(key);
    }

    // desired 瓦片刷新 LRU 位置：缓存打满时优先淘汰视野外旧瓦片，
    // 避免把仍在渲染中的瓦片淘汰掉导致闪烁/空洞（LRU 淘汰回调会 dispose + 移出场景）。
    for (const key of desired) this.cache.get(this._ck(key));

    // 场景增删 + 交叉淡入淡出（LOD 过渡不产生空洞、不生硬）：
    //   非 desired 网格保留条件 = 仍有「desired 但未加载」的瓦片与其区域重叠
    //   （细后代 zoom-in / 粗祖先 zoom-out，双向）；区域全部就绪才移除。
    //   移除时若替换瓦片已就绪 → 旧瓦片淡出 + 新瓦片淡入 200ms，杜绝硬切。
    // 1) 取消淡出：desired 又出现 → 恢复全不透明（镜头拉回时旧瓦片重新可见）
    for (const [key, t] of this._transitions) {
      if (t.mode === 'out' && desired.has(key)) {
        t.mesh.userData.fade = 1;
        this._transitions.delete(key);
      }
    }
    // 2) 推进过渡：淡出完成即移除（淡出中保护 LRU，防中途淘汰闪烁）
    if (this._transitions.size) {
      for (const [key, t] of this._transitions) {
        if (!this.meshes.has(key)) { this._transitions.delete(key); continue; } // 已被 LRU 淘汰
        const p = Math.min(1, (now - t.start) / t.dur);
        if (t.mode === 'in') {
          t.mesh.userData.fade = p;
          if (p >= 1) this._transitions.delete(key);
        } else {
          t.mesh.userData.fade = (t.from ?? 1) * (1 - p);
          if (p >= 1) {
            t.mesh.userData.fade = 0;
            if (t.mesh.parent) this.group.remove(t.mesh);
            this._transitions.delete(key);
          } else {
            this.cache.get(this._ck(key));
          }
        }
      }
    }
    // 3) zoom-in fallback：未加载 desired → 其粗祖先须保留（O(D×levels)）
    const keepAnc = new Set();
    for (const key of desired) {
      if (this.loaded.has(key)) continue;
      for (const a of this._ancestorsOf(key)) keepAnc.add(a);
    }
    // 4) 非 desired 网格保留/移除判定（双向，O(M×levels)）
    const toRemove = [];
    for (const [key, mesh] of this.meshes) {
      if (!mesh.parent) { this._grace.delete(key); continue; }
      if (desired.has(key)) { this._grace.delete(key); continue; }
      let need = keepAnc.has(key);
      if (!need) {
        // zoom-out：细瓦片覆盖某未加载的 desired 粗祖先 → 保留（粗瓦片落地前不黑屏）
        for (const a of this._ancestorsOf(key)) {
          if (desired.has(a) && !this.loaded.has(a)) { need = true; break; }
        }
      }
      if (need) {
        // 从淡出中恢复：区域又被需求 → 取消过渡、全不透明当 fallback
        this._grace.delete(key);
        const t = this._transitions.get(key);
        if (t && t.mode === 'out') { mesh.userData.fade = 1; this._transitions.delete(key); }
        this.cache.get(this._ck(key)); // fallback 也保护，防止 LRU 淘汰
      } else if (this._transitions.has(key)) {
        continue; // 正在淡出：交给过渡推进
      } else if (this._inFrustum(key)) {
        // 视锥内但 LOD 错误：立即走交叉淡出替换（放大/缩小的正常切换路径）
        this._grace.delete(key);
        toRemove.push([key, mesh]);
      } else {
        // 移出视锥：延迟移除（滞回计数）。旋转时视锥边缘瓦片在 desired 内外
        // 跳变，直接移除会造成来回增删/重载/闪烁；连续 N 帧移出才真正移除。
        // 滞回期间也保护 LRU，避免被淘汰后需重新拉取。
        const g = (this._grace.get(key) || 0) + 1;
        if (g < REMOVE_GRACE) {
          this._grace.set(key, g);
          this.cache.get(this._ck(key));
          continue;
        }
        this._grace.delete(key);
        toRemove.push([key, mesh]);
      }
    }
    // 5) 移除 + 交叉淡出配对（O(D×levels)）：zoom-in 由 loaded desired 向上配对，
    //    zoom-out 由被移除的细瓦片向上找 loaded desired 祖先
    const removeSet = new Set(toRemove.map(([k]) => k));
    const replaceMap = new Map(); // removedKey -> Set(replacementKey)
    for (const key of desired) {
      if (!this.loaded.has(key) || !this.meshes.has(key)) continue;
      for (const a of this._ancestorsOf(key)) {
        if (removeSet.has(a)) {
          let s = replaceMap.get(a);
          if (!s) { s = new Set(); replaceMap.set(a, s); }
          s.add(key);
        }
      }
    }
    for (const [key, mesh] of toRemove) {
      let replaces = replaceMap.get(key);
      if (!replaces) {
        for (const a of this._ancestorsOf(key)) {
          if (desired.has(a) && this.loaded.has(a)) { replaces = new Set([a]); break; }
        }
      }
      if (replaces && replaces.size) {
        this._startFade(mesh, 'out');
        for (const rk of replaces) {
          const rm = this.meshes.get(rk);
          if (rm && !rm.parent) { this.group.add(rm); this._startFade(rm, 'in'); }
        }
      } else {
        this.group.remove(mesh);
      }
    }
    // 6) desired 加入：粗祖先 fallback 仍在场景则暂不加入（等其移除/淡出后下一帧）；
    //    祖先正在淡出 → 本瓦片直接加入并同步淡入（衔接淡出间隙，无空洞）
    for (const key of desired) {
      const mesh = this.meshes.get(key);
      if (!mesh || mesh.parent) continue;
      if (this._transitions.has(key)) continue; // 已在淡入中
      let hasAncestor = false, fadingAncestor = false;
      for (const a of this._ancestorsOf(key)) {
        const am = this.meshes.get(a);
        if (!am || !am.parent) continue;
        const t = this._transitions.get(a);
        if (t && t.mode === 'out') { fadingAncestor = true; continue; }
        hasAncestor = true;
        break;
      }
      if (hasAncestor) continue;
      this.group.add(mesh);
      if (fadingAncestor) this._startFade(mesh, 'in');
    }

    this.desired = desired;

    // self 模式：背向排序（远→近）+ 状态上报；多测线由宿主跨线全局排序（renderOrder 需跨线一致）。
    // 共享模式不构建 renderList（每帧 [...meshes].filter 纯浪费——排序与计数都在宿主侧做）。
    if (this.ownsRender) {
      const renderList = [];
      for (const m of this.meshes.values()) if (m.parent) renderList.push(m);
      renderList.sort((a, b) => {
        const da = a.userData.center.distanceToSquared(this.camera.position);
        const db = b.userData.center.distanceToSquared(this.camera.position);
        return db - da;
      });
      renderList.forEach((m, i) => { m.renderOrder = i; });

      if (this.onStatus) {
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

    if (this.style) {
      this.syncStyle();
      // 初始视角窗宽自适应只由 self 模式（单线）触发；多测线由宿主统一做一次。
      if (this.ownsRender && !this._autoFitted && this.loaded.size >= 30) this.autoFitWindow();
    }

    this.drainQueue();
  }

  syncStyle() {
    const s = this.style;
    // 样式指纹门控：8 项参数未变则跳过逐 mesh 的 uniform 写入（12 线 × 数百 mesh × 8 uniform
    // 每帧重复写的开销很大）。uOpacity 额外含 LOD fade（每帧可能变），仅在样式变化或该 mesh
    // 正在淡入淡出时写。
    const fp = `${s.colorMap}|${s.minValue}|${s.maxValue}|${s.gain}|${s.gamma}|${s.thresholdMin}|${s.thresholdMax}|${s.opacity}`;
    const styleChanged = fp !== this._styleFp;
    if (styleChanged) this._styleFp = fp;
    for (const mesh of this.meshes.values()) {
      if (!mesh.parent) continue; // 只同步场景内可见 mesh；隐藏 mesh 入场景当帧补齐
      const fade = mesh.userData.fade ?? 1;
      if (!styleChanged && fade === 1) continue; // 样式没变且无过渡 → 无需写 uniform
      const u = mesh.material.uniforms;
      if (styleChanged) {
        u.uColorMap.value = s.colorMap;
        u.uMinValue.value = s.minValue;
        u.uMaxValue.value = s.maxValue;
        u.uGain.value = s.gain;
        u.uGamma.value = s.gamma;
        u.uThresholdMin.value = s.thresholdMin;
        u.uThresholdMax.value = s.thresholdMax;
      }
      u.uOpacity.value = s.opacity * fade; // LOD 交叉淡入淡出乘数
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
    // 缩放后队列里会残留大量不再 desired 的过期瓦片——它们只会在连接槽位上干等、
    // 让新 desired 瓦片在队尾排队。超过预算时整体压缩一次（O(n)）。
    if (this.queue.length > 200) {
      this.queue = this.queue.filter((q) => this.desired.has(q.key));
      this.queued = new Set(this.queue.map((q) => q.key));
    }
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length) {
      const item = this.queue.shift();
      this.queued.delete(item.key);
      if (!this.desired.has(item.key)) continue; // 过期：直接丢弃，不给它占连接
      if (this.loaded.has(item.key) || this.inFlight.has(item.key)) continue;
      this.loadTileAsync(item.key);
    }
  }

  async loadTileAsync(key) {
    const [level, x, y, z] = key.split('/').map(Number);
    const url = this.tileUrl(level, x, y, z);
    const limiter = this.limiter;
    // 立即登记 inFlight（同步），再取全局信号量——否则 drainQueue 的 inFlight 计数
    // 会因 await acquire 而失真，让 while 循环把整个队列一次性全拉起来。
    const p = (async () => {
      try {
        if (limiter) await limiter.acquire();
        const tile = await loadTile(url, { ghost: this.meta.ghost, scale: 1, offset: 0 });
        this.inFlight.delete(key);
        this.queued.delete(key);
        this.loaded.add(key);
        const mesh = this.createMesh(key, tile);
        this.meshes.set(key, mesh);
        this.cache.set(this._ck(key), { mesh, key: this._ck(key) });
        // 不入场景：统一由 tick() 按 fallback 规则决定加入时机
        // （避免细瓦片绕过祖先检查、与过渡期 coarse fallback 双重重叠渲染）。
        this.version++;
      } catch (err) {
        this.inFlight.delete(key);
        this.queued.delete(key);
        console.warn(`tile ${key} load failed:`, err);
      } finally {
        if (limiter) limiter.release();
      }
    })();
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
      worldOffset: this.worldOffset,   // shader 世界→局部逆变换用
      direction: this.direction,       // shader 反向线 x 镜像用
    });
    mesh.userData.key = key;
    mesh.userData.lineIdx = this.lineIdx; // 跨线 renderOrder 稳定排序 tie-breaker
    mesh.userData.fade = 1; // LOD 交叉淡入淡出乘数（默认全不透明）
    return mesh;
  }

  // 自适应步数：砖在屏幕上的投影尺寸 → 步数预算。
  // 注意！步数过高会在 12 线全载（1104 片）时把 Intel UHD 核显 GPU 永久卡到 1Hz，
  // 且该卡死是【粘滞】的——事后调低 uSteps 也救不回，只能整页重载。因此：
  //   - 曲线压低（0.3 步/投影像素，原 1.5）；
  //   - 硬上限 16（原 192，实测 32 步在冷启动全载时仍卡死，cliff 在 16~22 步）。
  // 定标记录：持续 16 步 → 12 线全部加载后 166 FPS；fit-all 时瓦片亚像素，
  // 16 步足够。近景同样被 16 步封顶，深度方向略粗但可接受（GPR 深度薄、
  // 表面反射主导）。
  stepsFor(tile) {
    const h = this.renderer.domElement.clientHeight || 800;
    const k = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const d = this.camera.position.distanceTo(this.tileWorldCenter(tile));
    const li = this.meta.levelInfo(tile.header.level);
    const [sx, , sz] = li.spacing;
    const worldX = tile.coreSize[0] * sx;
    const worldZ = tile.coreSize[2] * sz;
    const proj = Math.max(worldX, worldZ) * k / d;
    return Math.max(8, Math.min(16, Math.round(proj * 0.3)));
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
