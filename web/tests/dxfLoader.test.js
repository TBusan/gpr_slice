import { describe, it, expect } from 'vitest';
import { dxfToLines, dxfBoundingBox } from '../src/io/dxfLoader.js';

describe('dxfToLines', () => {
  it('LINE 实体转 2 端点', () => {
    const lines = dxfToLines({
      entities: [{ type: 'LINE', vertices: [[0, 0, 0], [10, 5, 0]] }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([[0, 0, 0], [10, 5, 0]]);
  });

  it('LWPOLYLINE 多段转多个 line', () => {
    const lines = dxfToLines({
      entities: [{ type: 'LWPOLYLINE', vertices: [[0, 0, 0], [10, 0, 0], [10, 5, 0]] }],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0][1]).toEqual([10, 0, 0]);
    expect(lines[1][1]).toEqual([10, 5, 0]);
  });

  it('POLYLINE/3DFACE/CIRCLE/ARC 跳过不报', () => {
    const lines = dxfToLines({
      entities: [
        { type: 'CIRCLE', center: [0, 0, 0], radius: 1 },
        { type: 'ARC', center: [0, 0, 0], radius: 1, startAngle: 0, endAngle: 90 },
        { type: 'POINT', position: [0, 0, 0] },
        { type: 'LINE', vertices: [[0, 0, 0], [1, 0, 0]] },
      ],
    });
    expect(lines).toHaveLength(1);
  });

  it('vertices 缺失/异常 → 跳过该实体', () => {
    const lines = dxfToLines({
      entities: [
        { type: 'LINE' /* no vertices */ },
        { type: 'LINE', vertices: [[0, 0, 0]] /* < 2 points */ },
        { type: 'LINE', vertices: [[0, 0, 0], [2, 0, 0]] },
      ],
    });
    expect(lines).toHaveLength(1);
  });

  it('空 entities → 空数组', () => {
    expect(dxfToLines({ entities: [] })).toEqual([]);
  });
});

describe('dxfBoundingBox', () => {
  it('lines 求 min/max', () => {
    const bb = dxfBoundingBox([[[0, 0, 0], [10, 5, 3]], [[-2, 1, 0], [3, 8, 1]]]);
    expect(bb.min).toEqual([-2, 0, 0]);
    expect(bb.max).toEqual([10, 8, 3]);
  });
  it('空 → 全 0', () => {
    expect(dxfBoundingBox([])).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });
});
