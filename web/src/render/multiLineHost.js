// render/multiLineHost.js —— 多测线共享渲染器宿主
//
// 拥有：渲染器 / 场景 / 相机 / OrbitControls + 单一共享 TileCache。
// 管理 N 个 VolumeScene（每线一个，复用共享 renderer/scene/camera/controls/cache）。
// 每帧：可见线各自 tick()（LOD 选择 / 加载 / 场景差异）→ 跨线全局背向排序 renderOrder
//       （距离并列按 lineIdx 稳定排序，避免相邻线等距砖块混合顺序闪烁）→ 渲染一次。
// 相机适配 fitAllLines()：全部可见线体积 AABB 并集（含反向线 scale.x=-1 镜像后的世界范围）。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TileCache } from '../lod/tileCache.js';
import { VolumeScene } from './volumeScene.js';

// 满 tile 纹理 = 258×34×34×2B（HalfFloat，store 含 ghost=1）≈ 0.57MB；
// CACHE_LIMIT 1280 块 ≈ 728MB GPU 上限。全览 12 线粗级 1104 片 ≈ 630MB，
// 典型 3D 视锥 300–700 片 ≈ 170–400MB。实测全览 ~1009 纹理 ≈ 575MB。
const CACHE_LIMIT = 1280;

export class MultiLineHost {
  constructor(container, lineCfgs) {
    // lineCfgs: [{ meta, basePath, worldOffset, direction, lineId, style, visible }]
    this.container = container;
    this.lineCfgs = lineCfgs;

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

    this.linearOK = renderer.capabilities.isWebGL2 ||
      !!renderer.extensions.get('OES_texture_half_float_linear');

    this.cache = new TileCache(CACHE_LIMIT);
    const shared = {
      renderer, scene: this.scene, camera: this.camera, controls: this.controls, cache: this.cache,
    };

    this.views = lineCfgs.map((cfg, i) => {
      const v = new VolumeScene(container, cfg.meta, {
        shared,
        basePath: cfg.basePath,
        worldOffset: cfg.worldOffset,
        direction: cfg.direction,
        lineId: cfg.lineId,
        lineIdx: i,
        visible: cfg.visible !== false,
      });
      v.style = cfg.style;
      if (v.visible) this.scene.add(v.group);
      return v;
    });

    this._onResize = () => this.resize();
    this.resize();
    window.addEventListener('resize', this._onResize);

    this.frames = 0;
    this.lastFpsAt = 0;
    this.fps = 0;
    this._autoFitted = false; // 多线显示窗宽只自动适配一次
    this.loop = this.loop.bind(this);
  }

  // 全部可见线的世界 AABB 并集（反向线按 direction 镜像局部 X）。
  worldBounds() {
    const box = new THREE.Box3();
    for (const v of this.views) {
      if (!v.visible) continue;
      const a = v.meta.volumeAABB();
      const [ox, oy, oz] = v.worldOffset;
      let x0 = ox + a.min[0] * v.direction;
      let x1 = ox + a.max[0] * v.direction;
      if (x0 > x1) [x0, x1] = [x1, x0];
      box.expandByPoint(new THREE.Vector3(x0, oy + a.min[1], oz + a.min[2]));
      box.expandByPoint(new THREE.Vector3(x1, oy + a.max[1], oz + a.max[2]));
    }
    return box;
  }

  fitAllLines() {
    const box = this.worldBounds();
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const diag = box.getSize(new THREE.Vector3()).length();
    const dir = new THREE.Vector3(1, 0.55, 0.45).normalize();
    this.camera.position.copy(c).addScaledVector(dir, diag * 0.9);
    this.controls.target.copy(c);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- 每帧：各线 tick → 全局排序 → （宿主渲染在 loop 里）----
  tick() {
    const now = performance.now();
    this.frames++;
    if (now - this.lastFpsAt > 500) {
      this.fps = this.frames * 1000 / (now - this.lastFpsAt);
      this.frames = 0;
      this.lastFpsAt = now;
    }

    const visible = this.views.filter(v => v.visible);
    for (const v of visible) v.tick();

    // 跨线全局背向排序（远→近），renderOrder 递增；距离并列按 lineIdx 稳定排序。
    // mesh.userData.center 是局部坐标 → 按各线 worldOffset/direction 转世界点再算距离
    // （反向线镜像 + 跨轨偏移，否则排序基准全错）。
    const cam = this.camera.position;
    const all = [];
    for (const v of visible) {
      const [ox, oy, oz] = v.worldOffset;
      const dir = v.direction;
      for (const m of v.meshes.values()) {
        if (!m.parent) continue;
        const c = m.userData.center;
        const wx = ox + c.x * dir;
        const wy = oy + c.y;
        const wz = oz + c.z;
        const dx = wx - cam.x, dy = wy - cam.y, dz = wz - cam.z;
        all.push({ m, dsq: dx * dx + dy * dy + dz * dz });
      }
    }
    all.sort((a, b) => {
      if (b.dsq !== a.dsq) return b.dsq - a.dsq;
      return a.m.userData.lineIdx - b.m.userData.lineIdx;
    });
    all.forEach((e, i) => { e.m.renderOrder = i; });

    if (!this._autoFitted && this.loadedCount() >= 30) this.autoFitWindow();
  }

  loadedCount() {
    let n = 0;
    for (const v of this.views) n += v.loaded.size;
    return n;
  }

  // 与 VolumeScene.autoFitWindow 相同的 p5/p95 窗宽自适应，但跨全部可见线采样。
  autoFitWindow() {
    const style = this.views[0] && this.views[0].style;
    if (!style) return;
    const samples = [];
    const N = 200000;
    outer:
    for (const v of this.views) {
      if (!v.visible) continue;
      for (const mesh of v.meshes.values()) {
        const u = mesh.material.uniforms.uVolume.value;
        const data = u.image.data;
        // HalfFloat 纹理：image.data 是 Uint16Array（半精度位模式），须解码成 float 再采样。
        const decode = data instanceof Uint16Array
          ? (v) => THREE.DataUtils.fromHalfFloat(v)
          : (v) => v;
        const step = Math.max(1, Math.floor(data.length / 30000));
        for (let i = 0; i < data.length; i += step) samples.push(decode(data[i]));
        if (samples.length >= N) break outer;
      }
    }
    if (samples.length < 1000) return;
    samples.sort((a, b) => a - b);
    const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
    let lo = q(0.05), hi = q(0.95);
    if (!(hi > lo)) return;
    if (hi - lo < 200) { lo = -200; hi = 200; }
    style.minValue = lo;
    style.maxValue = hi;
    if (style._inputs && style._inputs.minValue) style._inputs.minValue.value = String(Math.round(lo));
    if (style._inputs && style._inputs.maxValue) style._inputs.maxValue.value = String(Math.round(hi));
    this._autoFitted = true;
    console.log(`[auto-fit] 多线窗宽 ${lo.toFixed(0)} .. ${hi.toFixed(0)}（采样 ${samples.length}）`);
  }

  setLineVisible(lineId, v) {
    const view = this.views.find(x => x.lineId === lineId);
    if (view) view.setVisible(v);
  }

  // 兼容单线调试/测试钩子：跨线扁平化 mesh 集合（__scene.meshes.values() 可取首块）。
  get meshes() {
    const views = this.views;
    return {
      get size() { let n = 0; for (const v of views) n += v.meshes.size; return n; },
      values: function* () {
        for (const v of views) yield* v.meshes.values();
      },
    };
  }

  // 跨线状态汇总（HUD）
  status() {
    let desired = 0, loaded = 0, meshes = 0, inFlight = 0, queue = 0;
    for (const v of this.views) {
      desired += v.desired.size;
      loaded += v.loaded.size;
      inFlight += v.inFlight.size;
      queue += v.queue.length;
      for (const m of v.meshes.values()) if (m.parent) meshes++;
    }
    return {
      desired, loaded, meshes, inFlight, queue,
      cache: this.cache.size(),
      linear: this.linearOK,
      fps: Math.round(this.fps),
    };
  }

  start() {
    this.fitAllLines();
    requestAnimationFrame(this.loop);
  }

  loop() {
    requestAnimationFrame(this.loop);
    this.controls.update();
    this.tick();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    for (const v of this.views) v.dispose();
    this.renderer.dispose();
  }
}
