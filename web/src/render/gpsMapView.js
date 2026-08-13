// render/gpsMapView.js —— 2D UTM 轨迹地图视图
//
// 单线模式（旧签名兼容）：卷的世界 X 轴按轨迹累计弧长线性映射，画折线 + 相机标记。
// 多线模式：绘制全部测线 gpsTrack 折线（每线一色 + 图例），相机标记用参考线（001）
//   —— 相机世界 X 在 [worldXRange] 内的比例 → 参考线弧长 → UTM 点。
// 2D 只做示意，不做地理叠加（卷不覆盖到弯曲道路上）。

export class GpsMapView {
  // 用法：
  //   new GpsMapView(container, { tracks, refTrack, worldXRange, getCameraX })
  //   旧签名（单线）：new GpsMapView(container, scene, meta)
  constructor(container, arg2, arg3) {
    let cfg;
    if (arg2 && arg2.tracks) {
      cfg = arg2;
    } else {
      const scene = arg2, meta = arg3;
      const aabb = meta.volumeAABB();
      const pts = (meta.gpsTrack && meta.gpsTrack.points) || [];
      cfg = {
        tracks: [{ pts, color: '#4d9fff', name: meta.dataset.name }],
        refTrack: pts,
        worldXRange: [aabb.min[0], aabb.max[0]],
        getCameraX: () => scene.camera.position.x,
      };
    }
    this.tracks = cfg.tracks || [];
    this.refTrack = cfg.refTrack || (this.tracks[0] && this.tracks[0].pts) || [];
    this.worldXRange = cfg.worldXRange || [0, 1];
    this.getCameraX = cfg.getCameraX || (() => 0);
    // 跨轨放大倍数：0=自动（窄轴夸大到图幅短边 70%），>0=固定倍数（UI 滑块可调）。
    this.crossTrackFactor = cfg.crossTrackFactor || 0;

    // 每条轨迹的累计弧长（点插值用）
    this.cums = this.tracks.map(pts => {
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        cum.push(cum[i - 1] + Math.hypot(dx, dy));
      }
      return { pts, cum, total: cum[cum.length - 1] || 1 };
    });
    this.ref = this._arc(this.refTrack);

    this.container = container;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._pt = [0, 0];        // 复用数组，避免每帧分配
    this._lastXFrac = null;   // 相机 X 与画布尺寸均不变则跳过重绘
    this._lastW = -1;
    this._lastH = -1;
  }

  _arc(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
    }
    return { pts, cum, total: cum[cum.length - 1] || 1 };
  }

  // 弧长→UTM 点插值（f ∈ [0,1] 为总弧长比例）。返回 this._pt 的复用数组。
  pointAtFrac(arc, f) {
    const target = f * arc.total;
    let i = 1;
    while (i < arc.cum.length && arc.cum[i] < target) i++;
    if (i >= arc.cum.length) {
      const last = arc.pts[arc.pts.length - 1];
      this._pt[0] = last[0];
      this._pt[1] = last[1];
      return this._pt;
    }
    const a = (target - arc.cum[i - 1]) / (arc.cum[i] - arc.cum[i - 1] || 1);
    const p0 = arc.pts[i - 1], p1 = arc.pts[i];
    this._pt[0] = p0[0] + (p1[0] - p0[0]) * a;
    this._pt[1] = p0[1] + (p1[1] - p0[1]) * a;
    return this._pt;
  }

  update() {
    const [x0, x1] = this.worldXRange;
    const f = (this.getCameraX() - x0) / (x1 - x0 || 1);
    this.xFrac = Math.max(0, Math.min(1, f));
    const cw = this.canvas.clientWidth || 220;
    const ch = this.canvas.clientHeight || 130;
    if (this.xFrac === this._lastXFrac && cw === this._lastW && ch === this._lastH) return;
    this._lastXFrac = this.xFrac;
    this._lastW = cw;
    this._lastH = ch;
    this.draw();
  }

  // UI 滑块调用：设置跨轨放大倍数（0=自动，>0=固定倍数），立即重绘。
  setCrossTrackFactor(f) {
    this.crossTrackFactor = f || 0;
    this._lastXFrac = null; // 使 update() 跳过"未变化"检查，下一帧重绘
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

    const allPts = this.tracks.flatMap(t => t.pts);
    if (!allPts.length) {
      ctx.fillStyle = '#667';
      ctx.font = '11px system-ui';
      ctx.fillText('无 GPS 轨迹', 8, ch / 2);
      return;
    }

    // 边界 + fit（全部轨迹并集）
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (const [e, n] of allPts) {
      if (e < e0) e0 = e;
      if (n < n0) n0 = n;
      if (e > e1) e1 = e;
      if (n > n1) n1 = n;
    }
    const pad = 14;
    // 统一 fit 会把窄轴（跨轨，如 50m）压扁到 ~3px，12 条平行测线叠成一条。
    // 逐轴缩放：自动模式把窄轴（跨轨）夸大到图幅短边 ~70%，使测线分开可见
    // （示意性夸大，非地理精确；沿轨轴仍按真实比例铺满）。
    // 固定倍数模式（crossTrackFactor>0）：跨轨轴按 base×factor 放大，封顶避免
    // 溢出画布（此时"跨轨 ×N"标注显示实际生效倍数）。
    const dE = e1 - e0 || 1, dN = n1 - n0 || 1;
    const base = Math.min((cw - 2 * pad) / dE, (ch - 2 * pad) / dN);
    let sE = base, sN = base, exaggerate = 1;
    const fix = this.crossTrackFactor || 0;
    if (fix > 0) {
      if (dE < dN) { sE = Math.min(base * fix, (cw - 2 * pad) / dE); exaggerate = sE / base; }
      else if (dN < dE) { sN = Math.min(base * fix, (ch - 2 * pad) / dN); exaggerate = sN / base; }
    } else if (dE < dN * 0.25) {        // 自动：E 为跨轨（道路近南北向）
      sE = Math.max(sE, (ch * 0.7) / dE);
      exaggerate = sE / base;
    } else if (dN < dE * 0.25) {        // 自动：N 为跨轨（道路近东西向）
      sN = Math.max(sN, (ch * 0.7) / dN);
      exaggerate = sN / base;
    }
    const ox = (cw - dE * sE) / 2;
    const oy = (ch - dN * sN) / 2;
    const X = (e) => ox + (e - e0) * sE;
    const Y = (n) => ch - (oy + (n - n0) * sN);

    // 各测线轨迹折线
    for (const t of this.tracks) {
      ctx.strokeStyle = t.color || '#556';
      ctx.lineWidth = t.pts === this.refTrack ? 3 : 1.5;
      ctx.beginPath();
      t.pts.forEach(([e, n], i) => {
        if (i === 0) ctx.moveTo(X(e), Y(n));
        else ctx.lineTo(X(e), Y(n));
      });
      ctx.stroke();
    }

    // 相机标记（用参考线 001 的弧长映射）
    if (this.ref.pts.length) {
      const mp = this.pointAtFrac(this.ref, this.xFrac);
      const mx = X(mp[0]), my = Y(mp[1]);
      ctx.fillStyle = '#ffd24d';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffd24d';
      ctx.font = '9px system-ui';
      const xLen = (this.xFrac * (this.worldXRange[1] - this.worldXRange[0])).toFixed(0);
      ctx.fillText(`X ${xLen}m`, mx + 6, my - 6);
    }

    // 标签 + 图例
    ctx.fillStyle = '#8899aa';
    ctx.font = '9px system-ui';
    ctx.fillText(`E ${e0.toFixed(0)}`, 4, ch - 4);
    ctx.fillText(`N ${n0.toFixed(0)}`, 4, 10);
    ctx.fillText(`E ${e1.toFixed(0)}`, cw - 70, ch - 4);
    if (exaggerate > 1.01) {
      ctx.fillStyle = '#667';
      ctx.fillText(`跨轨 ×${Math.round(exaggerate)}`, 4, 20);
    }
    if (this.tracks.length > 1) {
      ctx.font = '8px system-ui';
      const lx = cw - 70, ly = 24;
      let dy = 0;
      for (const t of this.tracks.slice(0, 8)) {
        ctx.fillStyle = t.color || '#556';
        ctx.fillRect(lx, ly + dy, 8, 3);
        ctx.fillStyle = '#8899aa';
        ctx.fillText(t.name || '', lx + 10, ly + dy + 3);
        dy += 10;
      }
      if (this.tracks.length > 8) {
        ctx.fillStyle = '#667';
        ctx.fillText(`…共 ${this.tracks.length} 线`, lx + 10, ly + dy + 3);
      }
    }
  }
}
