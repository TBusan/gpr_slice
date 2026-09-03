import { describe, it, expect } from 'vitest';
import { computeNorthDeg } from '../src/render/sceneGizmos.js';

describe('computeNorthDeg', () => {
  it('crossVec=(0,1) → 0°（世界+Y 即正北）', () => {
    expect(computeNorthDeg({ alongVec: [1, 0], crossVec: [0, 1] })).toBeCloseTo(0);
  });
  it('crossVec=(1,0) → 90°（世界+X 即正北）', () => {
    expect(computeNorthDeg({ alongVec: [0, 1], crossVec: [1, 0] })).toBeCloseTo(90);
  });
  it('crossVec=(0,-1) → ±180°', () => {
    const d = computeNorthDeg({ alongVec: [1, 0], crossVec: [0, -1] });
    expect(Math.abs(d)).toBeCloseTo(180);
  });
  it('crossVec 对角 (0.707,0.707) → 45°', () => {
    expect(computeNorthDeg({ alongVec: [0.707, -0.707], crossVec: [0.707, 0.707] })).toBeCloseTo(45);
  });
  it('ref 缺失 → 0°', () => {
    expect(computeNorthDeg(null)).toBe(0);
  });
});
