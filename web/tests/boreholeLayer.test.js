import { describe, it, expect } from 'vitest';
import { buildBoreholeMeshes, stratumColor } from '../src/render/boreholeLayer.js';

describe('boreholeLayer', () => {
  const ref = { originUtm: [0, 0], alongVec: [1, 0], crossVec: [0, 1] };
  const worldPositions = { b1: [10, 0, 5.0] }; // wx=10, wy=0, ground=5m

  it('生成 head + 段几何', () => {
    const meshes = buildBoreholeMeshes({
      boreholes: [{
        id: 'b1', x: 10, y: 0, ground: 5.0,
        layers: [{ top: 0, bottom: 2, sampleId: 'S1', ph: 7, stratum: 1 },
                 { top: 2, bottom: 5, sampleId: 'S2', ph: 6, stratum: 2 }],
      }],
      worldPositions, ref, radius: 0.3,
    });
    // 顶层：1 个 borehole Group；其子节点 = 1 head + 2 段 = 3
    expect(meshes.children).toHaveLength(1);
    const bh = meshes.children[0];
    expect(bh.children).toHaveLength(3);
  });

  it('深度 = ground - top (向下为正)', () => {
    const meshes = buildBoreholeMeshes({
      boreholes: [{
        id: 'b1', x: 10, y: 0, ground: 5.0,
        layers: [{ top: 0, bottom: 3, sampleId: '', ph: null, stratum: 1 }],
      }],
      worldPositions, ref, radius: 0.3,
    });
    const seg = meshes.children[0].children[1]; // [head, segment]
    // 段中心 z = ground - (top+bottom)/2 = 5 - 1.5 = 3.5
    expect(seg.position.z).toBeCloseTo(3.5);
    // 段高度 = bottom - top = 3（沿本地 Y，旋转后等价世界 Z）
    expect(seg.scale.y).toBeCloseTo(3);
  });

  it('stratum 整数 → RGB 颜色', () => {
    const c0 = stratumColor(0);
    const c1 = stratumColor(1);
    const c7 = stratumColor(7);
    expect(c0).toHaveLength(3);
    expect(c1).toHaveLength(3);
    expect(c7).toHaveLength(3);
    // 不同 stratum 颜色不同
    expect(c0.join(',')).not.toBe(c1.join(','));
    expect(c1.join(',')).not.toBe(c7.join(','));
  });

  it('空 boreholes → 空 Group', () => {
    const meshes = buildBoreholeMeshes({ boreholes: [], worldPositions, ref, radius: 0.3 });
    expect(meshes.children).toHaveLength(0);
  });

  it('跳过 worldPositions 中缺失的孔', () => {
    const meshes = buildBoreholeMeshes({
      boreholes: [{ id: 'unknown', x: 0, y: 0, ground: 0, layers: [] }],
      worldPositions, ref, radius: 0.3,
    });
    expect(meshes.children).toHaveLength(0);
  });
});
