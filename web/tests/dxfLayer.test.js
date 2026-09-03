import { describe, it, expect } from 'vitest';
import { buildDxfLayer } from '../src/render/dxfLayer.js';
import * as THREE from 'three';

describe('buildDxfLayer', () => {
  it('每条线段 → 2 顶点 (x,y,z)', () => {
    const grp = buildDxfLayer({ lines: [[[0, 0, 0], [10, 0, 0]], [[0, 0, 0], [0, 5, 0]]] });
    const seg = grp.children[0];
    const pos = seg.geometry.attributes.position.array;
    expect(pos).toHaveLength(12); // 2 segments × 2 points × 3 floats
  });

  it('center 模式把几何平移到 boundingBox 中心', () => {
    const grp = buildDxfLayer({ lines: [[[0, 0, 0], [10, 0, 0]]], center: true });
    const seg = grp.children[0];
    const pos = seg.geometry.attributes.position.array;
    // 中心 (5, 0, 0) → 顶点从 (-5, 0, 0) 到 (5, 0, 0)
    expect(pos[0]).toBeCloseTo(-5);
    expect(pos[3]).toBeCloseTo(5);
  });

  it('空 lines → 空 Group', () => {
    const grp = buildDxfLayer({ lines: [] });
    expect(grp.children).toHaveLength(0);
  });

  it('Group name 为 dxf:<count>', () => {
    const grp = buildDxfLayer({ lines: [[[0, 0, 0], [1, 0, 0]]] });
    expect(grp.name).toBe('dxf:1');
  });
});
