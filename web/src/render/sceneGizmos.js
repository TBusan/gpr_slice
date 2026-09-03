// render/sceneGizmos.js —— 场景参照：地面网格 + 三轴 + 指北针（three 精灵 + DOM 标签）
import * as THREE from 'three';

// 由 manifest.reference 推算「世界 +Y 方向」相对 UTM 正北的方位角（度，绕 +Z 逆时针）
// 世界 (0,1) = crossVec；UTM (0,1) 即正北 → 方位角 = atan2(crossVec[0], crossVec[1]) * 180/π
export function computeNorthDeg(ref) {
  if (!ref || !ref.crossVec || ref.crossVec.length < 2) return 0;
  const [cx, cy] = ref.crossVec;
  return Math.atan2(cx, cy) * 180 / Math.PI;
}

// 创建场景参照 Group：grid（地面）+ axes（原点三轴）+ northArrow（指向正北的精灵）
export function createSceneGizmos({ ref = null, gridSize = 20, gridDiv = 20 } = {}) {
  const root = new THREE.Group();
  root.name = 'sceneGizmos';

  const grid = new THREE.GridHelper(gridSize, gridDiv, 0x4d9fff, 0x223344);
  grid.position.y = 0.001; // 防止 Z-fighting
  grid.material.transparent = true; grid.material.opacity = 0.45;
  root.add(grid);

  // 三轴：X 红（沿轨）、Y 绿（跨轨）、Z 蓝（深度）
  const axes = new THREE.AxesHelper(Math.min(gridSize, 5));
  axes.position.set(0, 0, 0);
  root.add(axes);

  // 指北针精灵（2D canvas 画箭头 + N 字）
  const northDeg = computeNorthDeg(ref);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeNorthTexture(northDeg), transparent: true, depthTest: false,
  }));
  sprite.position.set(0, gridSize * 0.42, 0.5);
  sprite.scale.set(2.4, 2.4, 1);
  sprite.renderOrder = 999;
  root.add(sprite);

  return { object3D: root, northDeg };
}

function makeNorthTexture(deg) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.translate(64, 64);
  ctx.rotate(deg * Math.PI / 180); // 旋转使箭头指向真北
  // 红箭头
  ctx.fillStyle = '#e6194B';
  ctx.beginPath();
  ctx.moveTo(0, -46); ctx.lineTo(18, 22); ctx.lineTo(0, 10); ctx.lineTo(-18, 22); ctx.closePath();
  ctx.fill();
  // N 字
  ctx.rotate(-deg * Math.PI / 180); // 文字保持水平
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', 0, -30);
  // 黑边
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}

// DOM 比例尺：固定 10m，根据相机高度自适应世界像素比（简化：固定显示）
export function attachScaleBar(viewportEl, camera, { lengthMeters = 10 } = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;left:14px;bottom:14px;color:#fff;font-size:11px;background:rgba(0,0,0,0.55);padding:3px 8px;border-radius:4px;pointer-events:none;';
  el.textContent = `⬛ ${lengthMeters} m`;
  viewportEl.appendChild(el);
  return { el, setLength: (m) => { el.textContent = `⬛ ${m} m`; } };
}
