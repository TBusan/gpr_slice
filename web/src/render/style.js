// render/style.js —— 动态样式状态 + 色带纹理（数据与样式分离）

import * as THREE from 'three';

export class Style {
  constructor(globalMin, globalMax) {
    this.globalMin = globalMin;
    this.globalMax = globalMax;
    this.minValue = globalMin;
    this.maxValue = globalMax;
    this.gain = 1;
    this.gamma = 1;
    this.thresholdMin = globalMin;
    this.thresholdMax = globalMax;
    this.opacity = 0.6;
    this.colorMapName = 'blue-red';
    this.colorMap = makeColorMap('blue-red');
  }

  setColorMap(name) {
    this.colorMapName = name;
    if (this.colorMap && this.colorMap.dispose) this.colorMap.dispose();
    this.colorMap = makeColorMap(name);
  }
}

// 多色点插值 → 256×1 RGBA 色带
function lerpStops(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / Math.max(1e-9, t1 - t0);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
  }
  return stops[stops.length - 1][1];
}

const VIRIDIS = [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]];
const MAGMA = [[0, [0, 0, 4]], [0.25, [81, 18, 124]], [0.5, [183, 55, 121]], [0.75, [251, 136, 97]], [1, [252, 253, 191]]];
const GRAY_RED = [[0, [40, 40, 40]], [0.5, [160, 160, 160]], [1, [230, 40, 40]]];

export function makeColorMap(name) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, 1);
  const data = img.data;

  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let r = 0, g = 0, b = 0;
    if (name === 'viridis') [r, g, b] = lerpStops(VIRIDIS, t);
    else if (name === 'magma') [r, g, b] = lerpStops(MAGMA, t);
    else if (name === 'gray-red') [r, g, b] = lerpStops(GRAY_RED, t);
    else if (name === 'grayscale') { r = g = b = t * 255; }
    else if (name === 'blue-red') { r = t * 255; b = (1 - t) * 255; }
    else if (name === 'seismic') {
      if (t < 0.5) { b = 255 * (1 - t * 2); r = 255 * t * 2; }
      else { r = 255 * (t - 0.5) * 2; g = 255 * (1 - (t - 0.5) * 2); }
    } else if (name === 'jet') {
      const jet = (x) => x < 0.125 ? 0 : x < 0.375 ? (x - 0.125) / 0.25 : x < 0.625 ? 1 : x < 0.875 ? (0.875 - x) / 0.25 : 0;
      r = jet(t + 0.25) * 255; g = jet(t) * 255; b = jet(t - 0.25) * 255;
    }
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
