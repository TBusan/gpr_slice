import { describe, it, expect } from 'vitest';
import { buildSectionLinkMeshes, pairLayersByTop } from '../src/render/sectionLinkLayer.js';

describe('pairLayersByTop', () => {
  it('按 top 深度排序后逐对配对', () => {
    const A = [{ top: 2, bottom: 3, stratum: 1 }, { top: 0, bottom: 1, stratum: 2 }];
    const B = [{ top: 0.5, bottom: 1.5, stratum: 2 }, { top: 2.5, bottom: 3, stratum: 1 }];
    const pairs = pairLayersByTop(A, B);
    // A[0].top=0, B[0].top=0.5 → (A[1],B[0])  // A[1].top=2, B[1].top=2.5 → (A[0],B[1])
    expect(pairs).toEqual([[A[1], B[0]], [A[0], B[1]]]);
  });
  it('层数不等取 min，剩余不连', () => {
    const A = [{ top: 0, bottom: 1, stratum: 1 }, { top: 2, bottom: 3, stratum: 2 }, { top: 4, bottom: 5, stratum: 3 }];
    const B = [{ top: 0, bottom: 1, stratum: 1 }];
    const pairs = pairLayersByTop(A, B);
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0]).toBe(A[0]);
    expect(pairs[0][1]).toBe(B[0]);
  });
  it('任一为空返回空', () => {
    expect(pairLayersByTop([], [{ top: 0, bottom: 1, stratum: 1 }])).toEqual([]);
    expect(pairLayersByTop([{ top: 0, bottom: 1, stratum: 1 }], [])).toEqual([]);
  });
});

describe('buildSectionLinkMeshes', () => {
  const ref = { originUtm: [0, 0], alongVec: [1, 0], crossVec: [0, 1] };
  const worldPositions = {
    a: [0, 0, 10.0],   // wx=0, wy=0, ground=10
    b: [10, 0, 10.0],  // wx=10
  };
  const bhA = { id: 'a', x: 0, y: 0, ground: 10, layers: [
    { top: 0, bottom: 3, stratum: 1 }, { top: 3, bottom: 6, stratum: 2 },
  ] };
  const bhB = { id: 'b', x: 10, y: 0, ground: 10, layers: [
    { top: 0, bottom: 3, stratum: 1 }, { top: 3, bottom: 6, stratum: 2 },
  ] };

  it('两孔同层生成 N 条线', () => {
    const grp = buildSectionLinkMeshes({
      a: bhA, b: bhB, worldPositions, ref,
    });
    // 2 配对 → 2 条 lineSegments
    expect(grp.children).toHaveLength(2);
  });

  it('每条线两端 z = ground - layer.top', () => {
    const grp = buildSectionLinkMeshes({ a: bhA, b: bhB, worldPositions, ref });
    const line = grp.children[0];
    // line.geometry.attributes.position.array: [x1,y1,z1, x2,y2,z2]
    const p = line.geometry.attributes.position.array;
    // 排序后第一对是 top=0 (depth=10)，两端 (0,0,10) → (10,0,10)
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(10);
    expect(p[3]).toBeCloseTo(10);
    expect(p[4]).toBeCloseTo(0);
    expect(p[5]).toBeCloseTo(10);
  });

  it('缺 worldPositions 返回空 Group', () => {
    const grp = buildSectionLinkMeshes({ a: bhA, b: bhB, worldPositions: { a: worldPositions.a }, ref });
    expect(grp.children).toHaveLength(0);
  });

  it('空 layers 返回空 Group', () => {
    const grp = buildSectionLinkMeshes({ a: { ...bhA, layers: [] }, b: bhB, worldPositions, ref });
    expect(grp.children).toHaveLength(0);
  });
});
