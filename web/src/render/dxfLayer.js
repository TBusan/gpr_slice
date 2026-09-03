// render/dxfLayer.js —— DXF 线段集合 → three.js LineSegments
import * as THREE from 'three';
import { dxfBoundingBox } from '../io/dxfLoader.js';

export function buildDxfLayer({ lines, color = 0x4d9fff, center = true } = {}) {
  const group = new THREE.Group();
  group.name = `dxf:${lines.length}`;
  if (!lines.length) return group;
  const positions = new Float32Array(lines.length * 6);
  let off = 0;
  let cx = 0, cy = 0, cz = 0;
  if (center) {
    const bb = dxfBoundingBox(lines);
    cx = (bb.min[0] + bb.max[0]) / 2;
    cy = (bb.min[1] + bb.max[1]) / 2;
    cz = (bb.min[2] + bb.max[2]) / 2;
  }
  for (const ln of lines) {
    const a = ln[0], b = ln[1];
    positions[off++] = a[0] - cx; positions[off++] = a[1] - cy; positions[off++] = a[2] - cz;
    positions[off++] = b[0] - cx; positions[off++] = b[1] - cy; positions[off++] = b[2] - cz;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  group.add(new THREE.LineSegments(geom, mat));
  return group;
}
