import { describe, it, expect } from 'vitest';
import { resamplePolyline } from '../src/render/arbitrarySection.js';

describe('resamplePolyline', () => {
  it('单段直线 10m，step 2m → 6 点（0,2,4,6,8,10）', () => {
    const pts = resamplePolyline([[0, 0, 0], [10, 0, 0]], 2);
    expect(pts).toHaveLength(6);
    for (let i = 0; i < pts.length; i++) expect(pts[i].s).toBeCloseTo(i * 2);
  });

  it('两段折线（Z 形）：总长 5+5=10', () => {
    const pts = resamplePolyline([[0, 0, 0], [5, 0, 0], [5, 5, 0]], 1);
    // 总长 10，每 1m 一点：11 个点
    expect(pts).toHaveLength(11);
    // 第 5 点 s=5 应在 (5,0,0)
    expect(pts[5].p[0]).toBeCloseTo(5);
    expect(pts[5].p[1]).toBeCloseTo(0);
    // 第 10 点 s=10 应在 (5,5,0)
    expect(pts[10].p[0]).toBeCloseTo(5);
    expect(pts[10].p[1]).toBeCloseTo(5);
  });

  it('含 z（深度）信息保留', () => {
    const pts = resamplePolyline([[0, 0, 1], [10, 0, 5]], 5);
    // 总长 ≈ 10.77，步长 5：s = 0, 5, 10 + 终点 ≈ 10.77 → 4 点
    expect(pts).toHaveLength(4);
    expect(pts[0].p[2]).toBeCloseTo(1);
    expect(pts[pts.length - 1].p[2]).toBeCloseTo(5);
  });

  it('步长大于总长 → 仅起点与终点', () => {
    const pts = resamplePolyline([[0, 0, 0], [1, 0, 0]], 10);
    expect(pts).toHaveLength(2);
  });

  it('点不足 2 → 空', () => {
    expect(resamplePolyline([], 1)).toEqual([]);
    expect(resamplePolyline([[0, 0, 0]], 1)).toEqual([]);
  });

  it('退化（重复点）不崩', () => {
    const pts = resamplePolyline([[0, 0, 0], [0, 0, 0], [5, 0, 0]], 1);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0].p[0]).toBeCloseTo(0);
    expect(pts[pts.length - 1].p[0]).toBeCloseTo(5);
  });
});
