// render/viewCube.js —— 视口右下角坐标轴方向指示器 + 前/俯/左三视图切换
//
// 用 2D Canvas 绘制（无需第二个 WebGL 上下文）：
//  - 三根轴箭头 X(红)/Y(绿)/Z(蓝)，方向随主相机实时同步旋转；
//  - 三个半透明平面四边形（前 X-Z / 俯 X-Y / 左 Y-Z，共享原点角的"立方体角"），
//    朝向相机的一面更亮，标签"前/俯/左"画在面中心；
//  - 点击某个平面 → snap() 把主相机切换到对应工程视图（框住整个数据体）。

import * as THREE from 'three';

// 轴投影半径（CSS 像素，相对指示器中心）
const R = 38;

// 世界三轴（与 metadata/spec 一致：X=沿轨、Y=跨轨、Z=深度向下）
const AXES = [
  { dir: [1, 0, 0], label: 'X', color: '#ff5252' },
  { dir: [0, 1, 0], label: 'Y', color: '#4caf50' },
  { dir: [0, 0, 1], label: 'Z', color: '#4d9fff' },
];

// 三个可点击平面。axes 为该面在 AXES 中的两轴索引；normal 用于判定朝向。
const PLANES = [
  { key: 'front', label: '前', axes: [0, 2], normal: [0, 1, 0], color: '0,200,255' },
  { key: 'top',   label: '俯', axes: [0, 1], normal: [0, 0, 1], color: '76,175,80' },
  { key: 'left',  label: '左', axes: [1, 2], normal: [1, 0, 0], color: '255,150,60' },
];

// 三视图相机配置。
//   axis    = 相机相对体积中心的偏移方向
//   up      = 相机上方向（前/左视图让深度 Z 向下=雷达图习惯；俯视图让 X 向右、Y 向下）
//   plane   = 所看平面在 AXES 中的两轴索引（用于算取景距离）
//   axisIdx = 观察方向所在的世界轴索引（相机要放在该轴方向的体外）
const VIEWS = {
  front: { axis: [0, 1, 0],   up: [0, 0, -1], plane: [0, 2], axisIdx: 1 },
  top:   { axis: [0, 0, -1],  up: [0, -1, 0], plane: [0, 1], axisIdx: 2 },
  left:  { axis: [1, 0, 0],   up: [0, 0, -1], plane: [1, 2], axisIdx: 0 },
};

export class ViewCube {
  constructor(container, scene) {
    this.scene = scene; // VolumeScene：提供 camera / controls / meta
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    // W2: 复用向量，避免每帧 3 次分配
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  // 每帧调用：同步主相机朝向并重绘
  update() {
    const { camera, controls } = this.scene;
    camera.updateMatrixWorld();
    this.right = this._right.setFromMatrixColumn(camera.matrixWorld, 0);
    this.up = this._up.setFromMatrixColumn(camera.matrixWorld, 1);
    this.viewDir = this._dir.subVectors(controls.target, camera.position).normalize();
    this.draw();
  }

  // 世界方向向量 → 指示器屏幕单位向量（canvas 坐标：x 向右、y 向下，相对中心半径 1）。
  // 相机 up 分量需取负：世界 "上" 在 canvas 里 y 更小。
  proj(d) {
    return [
      d[0] * this.right.x + d[1] * this.right.y + d[2] * this.right.z,
      -(d[0] * this.up.x + d[1] * this.up.y + d[2] * this.up.z),
    ];
  }

  draw() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = canvas.clientWidth || 108;
    const ch = canvas.clientHeight || 108;
    ctx.clearRect(0, 0, cw, ch);
    const C = cw / 2;

    // 三个轴尖在屏幕上的投影（单位向量）
    const tips = AXES.map((a) => this.proj(a.dir));

    // 平面按朝向从远到近绘制（painter's algorithm）
    const list = PLANES.map((p) => {
      const a = tips[p.axes[0]];
      const b = tips[p.axes[1]];
      const facing =
        p.normal[0] * this.viewDir.x +
        p.normal[1] * this.viewDir.y +
        p.normal[2] * this.viewDir.z;
      return { p, a, b, facing };
    }).sort((x, y) => x.facing - y.facing);

    for (const { p, a, b, facing } of list) {
      const alpha = 0.10 + 0.30 * Math.min(1, Math.abs(facing));
      ctx.beginPath();
      const corners = [
        [0, 0],
        a,
        [a[0] + b[0], a[1] + b[1]],
        b,
      ];
      corners.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(C + x * R, C + y * R);
        else ctx.lineTo(C + x * R, C + y * R);
      });
      ctx.closePath();
      ctx.fillStyle = `rgba(${p.color},${alpha.toFixed(3)})`;
      ctx.fill();

      // 平面标签
      const lx = C + ((a[0] + b[0]) / 2) * R;
      const ly = C + ((a[1] + b[1]) / 2) * R;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '600 12px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.label, lx, ly);
    }

    // 轴线 + 轴字母
    AXES.forEach((a, i) => {
      const [tx, ty] = tips[i];
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(C, C);
      ctx.lineTo(C + tx * R, C + ty * R);
      ctx.stroke();
      const lx = C + tx * (R + 7);
      const ly = C + ty * (R + 7);
      ctx.fillStyle = a.color;
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.label, lx, ly);
    });
  }

  onPointerDown(e) {
    e.stopPropagation();
    if (!this.viewDir) return; // 尚未首帧绘制
    const rect = this.canvas.getBoundingClientRect();
    const C = rect.width / 2;
    const vx = (e.clientX - rect.left - C) / R;
    const vy = (e.clientY - rect.top - C) / R;

    let best = null;
    let bestFacing = -Infinity;
    for (const p of PLANES) {
      const a = this.proj(AXES[p.axes[0]].dir);
      const b = this.proj(AXES[p.axes[1]].dir);
      // 平行四边形测试：v = α·a + β·b，α,β∈[0,1]（略放宽）
      const det = a[0] * b[1] - a[1] * b[0];
      if (Math.abs(det) < 1e-4) continue; // 该面边对相机（退化成线）
      const alpha = (vx * b[1] - vy * b[0]) / det;
      const beta = (a[0] * vy - a[1] * vx) / det;
      if (alpha < -0.15 || alpha > 1.15 || beta < -0.15 || beta > 1.15) continue;
      const facing = Math.abs(
        p.normal[0] * this.viewDir.x +
          p.normal[1] * this.viewDir.y +
          p.normal[2] * this.viewDir.z
      );
      if (facing > bestFacing) {
        bestFacing = facing;
        best = p.key;
      }
    }
    if (best) this.snap(best);
  }

  // 切换到工程视图（前/俯/左）：框住整个数据体
  snap(key) {
    const cfg = VIEWS[key];
    const { camera, controls } = this.scene;
    // 多线宿主：worldBounds() 返回 THREE.Box3；单线 VolumeScene：meta.volumeAABB() 返回数组
    const isHost = !!this.scene.worldBounds;
    const aabb = isHost ? this.scene.worldBounds() : this.scene.meta.volumeAABB();
    const min = isHost ? aabb.min : new THREE.Vector3(...aabb.min);
    const max = isHost ? aabb.max : new THREE.Vector3(...aabb.max);
    const dims = [
      max.x - min.x,
      max.y - min.y,
      max.z - min.z,
    ];
    // 面内两轴的更大跨度 → 取景距离
    const fit = Math.max(dims[cfg.plane[0]], dims[cfg.plane[1]]);
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const frameDist = (fit / 2) / Math.tan(halfFov) * 1.25;
    // 相机放在观察轴方向体外：半纵深 + 取景距离
    const d = dims[cfg.axisIdx] / 2 + frameDist;
    const c = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    camera.position.set(
      c.x + cfg.axis[0] * d,
      c.y + cfg.axis[1] * d,
      c.z + cfg.axis[2] * d
    );
    controls.target.set(c.x, c.y, c.z);
    camera.up.set(cfg.up[0], cfg.up[1], cfg.up[2]);
    controls.update();
  }
}
