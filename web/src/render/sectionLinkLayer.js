// render/sectionLinkLayer.js —— 钻孔剖面连线：两孔按 top 深度配对，每对画一条 line（颜色按 stratum）
import * as THREE from 'three';
import { stratumColor } from './boreholeLayer.js';

// 按 top 升序排序后逐对配对（min(len(A), len(B))）
export function pairLayersByTop(A, B) {
  if (!A.length || !B.length) return [];
  const a = [...A].sort((x, y) => x.top - y.top);
  const b = [...B].sort((x, y) => x.top - y.top);
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push([a[i], b[i]]);
  return out;
}

export function buildSectionLinkMeshes({ a, b, worldPositions, ref }) {
  const group = new THREE.Group();
  group.name = `section:${a.id}↔${b.id}`;
  const pa = worldPositions[a.id], pb = worldPositions[b.id];
  if (!pa || !pb) return group;
  const pairs = pairLayersByTop(a.layers || [], b.layers || []);
  for (const [la, lb] of pairs) {
    const zA = pa[2] - la.top;
    const zB = pb[2] - lb.top;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([
      pa[0], pa[1], zA,
      pb[0], pb[1], zB,
    ], 3));
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(...stratumColor(la.stratum).map(v => v / 255)),
      transparent: true, opacity: 0.85,
    });
    group.add(new THREE.Line(geom, mat));
  }
  return group;
}
