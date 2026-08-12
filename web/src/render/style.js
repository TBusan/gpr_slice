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

// 生成 256×1 RGBA 色带
export function makeColorMap(name) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, 1);
  const data = img.data;

  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let r = 0, g = 0, b = 0;
    if (name === 'grayscale') {
      // 黑→白线性渐变（此前写成常量 255，整个色带全白 → 图例/切片一片白）
      r = g = b = t * 255;
    } else if (name === 'blue-red') {
      r = t * 255;
      b = (1 - t) * 255;
    } else if (name === 'seismic') {
      // 低=蓝，中=白(0)，高=红
      if (t < 0.5) {
        b = 255 * (1 - t * 2);
        r = 255 * t * 2;
      } else {
        r = 255 * (t - 0.5) * 2;
        g = 255 * (1 - (t - 0.5) * 2);
      }
    } else if (name === 'jet') {
      const jet = (x) => {
        if (x < 0.125) return 0;
        if (x < 0.375) return (x - 0.125) / 0.25;
        if (x < 0.625) return 1;
        if (x < 0.875) return (0.875 - x) / 0.25;
        return 0;
      };
      r = jet(t + 0.25);
      g = jet(t);
      b = jet(t - 0.25);
      r *= 255; g *= 255; b *= 255;
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
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
