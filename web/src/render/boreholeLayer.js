// render/boreholeLayer.js —— 钻孔 L1 柱状 3D 几何（每孔：head disc + 每层 cylinder）
import * as THREE from 'three';

// 简化调色板：12 个 stratum 槽位循环
const PALETTE = [
  0xe6194B, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4,
  0x42d4f4, 0xf032e6, 0xbfef45, 0x469990, 0x9A6324, 0xdcbeff,
];

export function stratumColor(s) {
  if (s == null || !Number.isFinite(s)) return [128, 128, 128];
  const i = ((Math.floor(s) % PALETTE.length) + PALETTE.length) % PALETTE.length;
  const hex = PALETTE[i];
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

// 场地 (x,y) → 世界 (wx, wy) 经 ref.{originUtm, alongVec, crossVec}
export function siteToWorld(ref, x, y) {
  const dx = x - ref.originUtm[0];
  const dy = y - ref.originUtm[1];
  return [
    dx * ref.alongVec[0] + dy * ref.alongVec[1],
    dx * ref.crossVec[0] + dy * ref.crossVec[1],
  ];
}

// worldPositions: { boreholeId → [wx, wy, ground] }，允许调用方先做相似变换 + ref 转换
export function buildBoreholeMeshes({ boreholes, worldPositions, ref, radius = 0.3 }) {
  const group = new THREE.Group();
  group.name = 'boreholes';
  for (const b of boreholes) {
    const wp = worldPositions[b.id];
    if (!wp) continue;
    const [wx, wy, ground] = wp;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(ground)) continue;
    const g = new THREE.Group();
    g.name = `borehole:${b.id}`;
    g.position.set(wx, wy, 0);

    // 头：地面 disc（z = ground）
    const headGeom = new THREE.CircleGeometry(radius, 16);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    const head = new THREE.Mesh(headGeom, headMat);
    head.rotation.x = -Math.PI / 2; // 平放
    head.position.z = ground;
    g.add(head);

    // 立柱：每层一个 cylinder（y 轴向，但世界深度是 +z，所以绕 X 转 90° 沿 Z 立起）
    for (const layer of b.layers) {
      const h = layer.bottom - layer.top;
      if (!Number.isFinite(h) || h <= 0) continue;
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 1, 12), // 高度 1，由 scale.y 缩放
        new THREE.MeshLambertMaterial({ color: new THREE.Color(...stratumColor(layer.stratum).map(v => v / 255)) }),
      );
      // cylinder 默认沿 Y 立。绕 X 旋转 90° 后沿 Z 立。世界深度 +Z 向下。
      cyl.rotation.x = Math.PI / 2;
      cyl.position.z = ground - (layer.top + layer.bottom) / 2;
      cyl.scale.y = h;
      g.add(cyl);
    }
    group.add(g);
  }
  return group;
}
