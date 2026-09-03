import { describe, it, expect } from 'vitest';
import { worldToLocal, sampleWorld } from '../src/io/volumeSampler.js';

const ref = { originUtm: [0, 0], alongVec: [1, 0], crossVec: [0, 1] };

describe('worldToLocal', () => {
  it('恒等 ref：world(x,0,0) → local(x,0,0)', () => {
    const l = worldToLocal({ x: 5, y: 0, z: 2 }, { worldOffset: [0, 0], direction: 1, ref, halfCross: 5, length: 100, depthMax: 10 });
    expect(l.along).toBeCloseTo(5);
    expect(l.cross).toBeCloseTo(0);
    expect(l.depth).toBeCloseTo(2);
    expect(l.inRange).toBe(true);
  });

  it('反向线 direction=-1：world(5,0,0) → local(-5,0,0)', () => {
    const l = worldToLocal({ x: 5, y: 0, z: 0 }, { worldOffset: [0, 0], direction: -1, ref, halfCross: 5, length: 100, depthMax: 10 });
    expect(l.along).toBeCloseTo(-5);
    expect(l.cross).toBeCloseTo(0);
  });

  it('worldOffset 偏移：line offset (0,5)，world(0,3,0) → cross=-2', () => {
    // 相对 line 原点：世界 (0,3) - lineOffset(0,5) = (0,-2) → cross=-2
    const l = worldToLocal({ x: 0, y: 3, z: 0 }, { worldOffset: [0, 5], direction: 1, ref, halfCross: 5, length: 100, depthMax: 10 });
    expect(l.cross).toBeCloseTo(-2);
    expect(l.along).toBeCloseTo(0);
  });

  it('跨轨超 halfCross → inRange=false', () => {
    const l = worldToLocal({ x: 0, y: 10, z: 0 }, { worldOffset: [0, 0], direction: 1, ref, halfCross: 2, length: 100, depthMax: 10 });
    expect(l.inRange).toBe(false);
  });

  it('沿轨超 length → inRange=false', () => {
    const l = worldToLocal({ x: 200, y: 0, z: 0 }, { worldOffset: [0, 0], direction: 1, ref, halfCross: 5, length: 100, depthMax: 10 });
    expect(l.inRange).toBe(false);
  });
});

describe('sampleWorld', () => {
  const lines = [
    { id: 'L1', worldOffset: [0, 0], direction: 1, ref, halfCross: 4, length: 100, depthMax: 10, active: true },
    { id: 'L2', worldOffset: [0, 5], direction: 1, ref, halfCross: 4, length: 100, depthMax: 10, active: true },
    { id: 'L3', worldOffset: [0, -5], direction: 1, ref, halfCross: 4, length: 100, depthMax: 10, active: false },
  ];
  const sampleLocal = (lineId, along, cross, depth) => ({ lineId, along, cross, depth, value: along * 0.1 + depth });

  it('选 cross 距离最近且在范围内的激活线', () => {
    const r = sampleWorld({ x: 0, y: 3, z: 1 }, { lines, sampleLocal });
    // y=3 距 L1(0) 3m，距 L2(5) 2m → 选 L2
    expect(r.lineId).toBe('L2');
    expect(r.value).toBeCloseTo(0.1 * 0 + 1);
  });

  it('跳过未激活线', () => {
    const r = sampleWorld({ x: 0, y: -3, z: 1 }, { lines, sampleLocal });
    // y=-3: L1 3m,L2 8m,L3 (-5) 2m 但 inactive → 选 L1
    expect(r.lineId).toBe('L1');
  });

  it('所有线均超出范围 → null', () => {
    const r = sampleWorld({ x: 0, y: 100, z: 0 }, { lines, sampleLocal });
    expect(r).toBeNull();
  });
});
