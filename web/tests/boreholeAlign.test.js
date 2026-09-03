import { describe, it, expect } from 'vitest';
import { solveSimilarity, applySimilarity } from '../src/io/boreholeAlign.js';

describe('solveSimilarity', () => {
  it('1 点 → 仅平移', () => {
    const tr = solveSimilarity([{ from: [100, 200], to: [0, 0] }]);
    expect(applySimilarity(tr, [100, 200])).toEqual([0, 0]);
    expect(applySimilarity(tr, [150, 200])).toEqual([50, 0]);
  });
  it('旋转 90° + 平移（2 点精确）', () => {
    // (0,0)→(10,20), (1,0)→(10,21)：旋转 90°（from-x 转到 to-y），t=(10,20)
    const tr = solveSimilarity([{ from: [0, 0], to: [10, 20] }, { from: [1, 0], to: [10, 21] }]);
    expect(applySimilarity(tr, [0, 0])).toEqual([10, 20]);
    expect(applySimilarity(tr, [1, 0])).toEqual([10, 21]);
    expect(applySimilarity(tr, [0, 1])).toEqual([9, 20]);
  });
  it('等比缩放 + 平移（2 点）', () => {
    const tr = solveSimilarity([{ from: [0, 0], to: [100, 200] }, { from: [1, 0], to: [200, 200] }]);
    expect(applySimilarity(tr, [2, 0])).toEqual([300, 200]);
  });
  it('多对点最小二乘（旋转 + 平移）', () => {
    // 真值：旋转 90° + 平移 (5, 0)：[[0,0],[1,0],[0,1],[1,1]] → [[5,0],[5,1],[4,0],[4,1]]
    const trueTr = { a: 0, b: 1, tx: 5, ty: 0 };
    const pairs = [
      { from: [0, 0], to: applySimilarity(trueTr, [0, 0]) },
      { from: [1, 0], to: applySimilarity(trueTr, [1, 0]) },
      { from: [0, 1], to: applySimilarity(trueTr, [0, 1]) },
      { from: [1, 1], to: applySimilarity(trueTr, [1, 1]) },
    ];
    const tr = solveSimilarity(pairs);
    expect(applySimilarity(tr, [0, 0])).toEqual([5, 0]);
    expect(applySimilarity(tr, [1, 0])).toEqual([5, 1]);
    expect(applySimilarity(tr, [0, 1])).toEqual([4, 0]);
    expect(applySimilarity(tr, [1, 1])).toEqual([4, 1]);
  });
  it('退化：全同点 → null', () => {
    expect(solveSimilarity([{ from: [0, 0], to: [0, 0] }, { from: [0, 0], to: [0, 0] }])).toBeNull();
  });
  it('空数组 → null', () => {
    expect(solveSimilarity([])).toBeNull();
  });
});
