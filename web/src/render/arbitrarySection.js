// render/arbitrarySection.js —— 任意角度剖面：折线重采样 + 振幅渲染到 canvas
import * as THREE from 'three';

// 折线重采样：points=[[x,y,z],...]，按 stepMeters 等距输出 [{s, p:[x,y,z]}]
// s 为沿折线距离，p 为对应 3D 位置
export function resamplePolyline(points, stepMeters) {
  if (!points || points.length < 2) return [];
  const segLens = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const dz = points[i + 1][2] - points[i][2];
    const L = Math.hypot(dx, dy, dz);
    segLens.push(L); total += L;
  }
  if (total < 1e-9) return [{ s: 0, p: points[0].slice() }, { s: 0, p: points[points.length - 1].slice() }];
  const out = [];
  // 起点 s=0
  out.push({ s: 0, p: points[0].slice() });
  let s = stepMeters;
  let seg = 0, segPos = 0;
  while (s < total - 1e-9) {
    // 推进到目标 s 所在段
    while (seg < segLens.length - 1 && segPos + segLens[seg] < s - 1e-9) {
      segPos += segLens[seg]; seg++;
    }
    const t = (s - segPos) / Math.max(1e-9, segLens[seg]);
    const a = points[seg], b = points[seg + 1];
    out.push({ s, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] });
    s += stepMeters;
  }
  // 终点 s=total
  out.push({ s: total, p: points[points.length - 1].slice() });
  return out;
}

// 把 samples = [{s, depth, value, lineId}] 渲染到 canvas
// 横轴 = s（沿折线距离），纵轴 = depth（向下为正）
// 颜色按 value，用 style.colorMap；value 缺失像素用黑色
export function renderSection(canvas, samples, style, { width, height } = {}) {
  if (width) canvas.width = width; if (height) canvas.height = height;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!samples.length) return;
  let sMax = 0, dMax = 0;
  for (const s of samples) { if (s.s > sMax) sMax = s.s; if (s.depth > dMax) dMax = s.depth; }
  if (sMax < 1e-9 || dMax < 1e-9) return;
  const img = ctx.createImageData(W, H);
  const vMin = style.minValue, vMax = style.maxValue, span = Math.max(1e-9, vMax - vMin);
  // 直接从色带纹理（CanvasTexture）取色：value → u ∈ [0,1] → ImageData
  const cmap = style.colorMap;
  if (!cmap || !cmap.image) return;
  const cmapCtx = cmap.image.getContext('2d');
  const cmapData = cmapCtx.getImageData(0, 0, 256, 1).data;
  for (const s of samples) {
    const px = Math.min(W - 1, Math.max(0, Math.round((s.s / sMax) * (W - 1))));
    const py = Math.min(H - 1, Math.max(0, Math.round((s.depth / dMax) * (H - 1))));
    if (s.value == null || !Number.isFinite(s.value)) continue;
    const u = Math.min(1, Math.max(0, (s.value - vMin) / span));
    const ci = Math.min(255, Math.max(0, Math.round(u * 255))) * 4;
    const o = (py * W + px) * 4;
    img.data[o] = cmapData[ci];
    img.data[o + 1] = cmapData[ci + 1];
    img.data[o + 2] = cmapData[ci + 2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // 标尺
  ctx.fillStyle = '#fff'; ctx.font = '10px system-ui';
  ctx.fillText(`s=${sMax.toFixed(1)}m`, 6, 12);
  ctx.fillText(`d=${dMax.toFixed(1)}m`, W - 60, H - 6);
}
