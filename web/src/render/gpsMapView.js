// render/gpsMapView.js —— 2D UTM 轨迹地图视图
//
// 卷的世界 X 轴（0..Xmax，即沿轨距离）按轨迹【累计弧长】线性映射：
//   X/worldXRange → 弧长 0..total → 折线插值得到 UTM 点。
// 绘制：49 点折线（灰）、卷覆盖范围段（蓝）、相机位置标记（实时联动 3D 相机 X）。
// 2D 只做示意，不做地理叠加（卷不覆盖到弯曲道路上）。

export class GpsMapView {
  constructor(container, scene, meta) {
    this.scene = scene;
    this.meta = meta;
    this.container = container;

    this.aabb = meta.volumeAABB();
    this.xRange = this.aabb.max[0] - this.aabb.min[0];

    const pts = (meta.gpsTrack && meta.gpsTrack.points) || [];
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      this.cum.push(this.cum[i - 1] + Math.hypot(dx, dy));
    }
    this.total = this.cum[this.cum.length - 1] || 1;

    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._pt = [0, 0];        // W2: pointAtFrac 复用数组，避免每帧 65+ 次分配
    this._lastXFrac = null;   // W4: 门控（相机 X 与画布尺寸均不变则跳过重绘）
    this._lastW = -1;
    this._lastH = -1;
  }

  // 弧长→UTM 点插值（f ∈ [0,1] 为总弧长比例）。返回 this._pt 的复用数组，
  // 调用方须立即读取（下一次调用会覆盖）。
  pointAtFrac(f) {
    const target = f * this.total;
    let i = 1;
    while (i < this.cum.length && this.cum[i] < target) i++;
    if (i >= this.cum.length) {
      const last = this.pts[this.pts.length - 1];
      this._pt[0] = last[0];
      this._pt[1] = last[1];
      return this._pt;
    }
    const a = (target - this.cum[i - 1]) / (this.cum[i] - this.cum[i - 1] || 1);
    const p0 = this.pts[i - 1], p1 = this.pts[i];
    this._pt[0] = p0[0] + (p1[0] - p0[0]) * a;
    this._pt[1] = p0[1] + (p1[1] - p0[1]) * a;
    return this._pt;
  }

  update() {
    const cam = this.scene.camera.position;
    const f = (cam.x - this.aabb.min[0]) / this.xRange;
    this.xFrac = Math.max(0, Math.min(1, f));
    // W4: 相机未动且画布尺寸未变 → 跳过重绘（2D 轨迹与标记只依赖这两者）
    const cw = this.canvas.clientWidth || 220;
    const ch = this.canvas.clientHeight || 130;
    if (this.xFrac === this._lastXFrac && cw === this._lastW && ch === this._lastH) return;
    this._lastXFrac = this.xFrac;
    this._lastW = cw;
    this._lastH = ch;
    this.draw();
  }

  draw() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || 220;
    const ch = canvas.clientHeight || 130;
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 用 CSS 像素绘制
    ctx.clearRect(0, 0, cw, ch);

    if (!this.pts.length) {
      ctx.fillStyle = '#667';
      ctx.font = '11px system-ui';
      ctx.fillText('无 GPS 轨迹', 8, ch / 2);
      return;
    }

    // 边界 + fit
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (const [e, n] of this.pts) {
      if (e < e0) e0 = e;
      if (n < n0) n0 = n;
      if (e > e1) e1 = e;
      if (n > n1) n1 = n;
    }
    const pad = 14;
    const s = Math.min((cw - 2 * pad) / (e1 - e0 || 1), (ch - 2 * pad) / (n1 - n0 || 1));
    const ox = (cw - (e1 - e0) * s) / 2;
    const oy = (ch - (n1 - n0) * s) / 2;
    const X = (e) => ox + (e - e0) * s;
    const Y = (n) => ch - (oy + (n - n0) * s);

    // 整条轨迹（灰）
    ctx.strokeStyle = '#556';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.pts.forEach(([e, n], i) => {
      if (i === 0) ctx.moveTo(X(e), Y(n));
      else ctx.lineTo(X(e), Y(n));
    });
    ctx.stroke();

    // 卷覆盖范围段（弧长 0..1 → 蓝）：沿折线按累计弧长密集采样，
    // 而不是把两端用一条直线连起来（弯路会被画成直线）。
    const SEG = 64;
    ctx.strokeStyle = '#4d9fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= SEG; i++) {
      const p = this.pointAtFrac(i / SEG);
      if (i === 0) ctx.moveTo(X(p[0]), Y(p[1]));
      else ctx.lineTo(X(p[0]), Y(p[1]));
    }
    ctx.stroke();

    // 相机标记（圆 + 指向）
    const mp = this.pointAtFrac(this.xFrac);
    const mx = X(mp[0]), my = Y(mp[1]);
    ctx.fillStyle = '#ffd24d';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 标签
    ctx.fillStyle = '#8899aa';
    ctx.font = '9px system-ui';
    ctx.fillText(`E ${e0.toFixed(0)}`, 4, ch - 4);
    ctx.fillText(`N ${n0.toFixed(0)}`, 4, 10);
    ctx.fillText(`E ${e1.toFixed(0)}`, cw - 70, ch - 4);
    ctx.fillStyle = '#4d9fff';
    ctx.fillText(`X ${(this.xFrac * this.xRange).toFixed(0)}m`, mx + 6, my - 6);
  }
}
