import { describe, it, expect } from 'vitest';
import { polylineLength, polygonArea, formatLength, formatArea } from '../src/render/measureTool.js';

describe('measureTool', () => {
  it('polylineLength 3D：直角折线 3+4=7', () => {
    expect(polylineLength([[0, 0, 0], [3, 0, 0], [3, 4, 0]])).toBeCloseTo(7);
  });

  it('polylineLength 包含 z', () => {
    expect(polylineLength([[0, 0, 0], [0, 0, 5]])).toBeCloseTo(5);
  });

  it('polylineLength 退化（<2 点）→ 0', () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([[1, 2, 3]])).toBe(0);
  });

  it('polygonArea 矩形 4×3=12', () => {
    expect(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]])).toBeCloseTo(12);
  });

  it('polygonArea 三角形 底 4 高 3 = 6', () => {
    expect(polygonArea([[0, 0], [4, 0], [2, 3]])).toBeCloseTo(6);
  });

  it('polygonArea 凸多边形（不规则）', () => {
    // 不规则五边形 shoelace
    const a = polygonArea([[0, 0], [5, 0], [6, 2], [3, 5], [0, 3]]);
    // 手算：shoelace
    // Σ(x_i * y_{i+1} - x_{i+1} * y_i)
    // = 0*0-5*0 + 5*2-6*0 + 6*5-3*2 + 3*3-0*5 + 0*0-0*3
    // = 0 + 10 + 24 + 9 + 0 = 43 → |43|/2 = 21.5
    expect(a).toBeCloseTo(21.5);
  });

  it('polygonArea 点不足 3 → 0', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[0, 0]])).toBe(0);
    expect(polygonArea([[0, 0], [1, 0]])).toBe(0);
  });

  it('formatLength/formatArea', () => {
    expect(formatLength(123)).toBe('123 m');
    expect(formatLength(1500)).toBe('1.50 km');
    expect(formatArea(50)).toBe('50 m²');
    expect(formatArea(15000)).toBe('1.50 ha');
  });
});
