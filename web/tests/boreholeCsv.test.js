import { describe, it, expect } from 'vitest';
import { parseBoreholeCsv, splitPointIds } from '../src/io/boreholeCsv.js';

const CSV = [
  '监测点位,X,Y,采样深度/m,上层深度,下层深度,样品编号,pH值,苯并(a)芘,数据来源,2米分层（详查）,地面高程/m',
  'S1-JM1,3796.316,7657.852,0.2,0,0.2,S1-JM1-1,7.61,ND,工作井以北,2,4.062',
  'S1-JM1,3796.316,7657.852,4,3.8,4,S1-JM1-3,7.01,0.4,工作井以北,4,4.062',
  'S4-JM3,3635.443,7779.231,2,1.8,2,S4-JM3-2,7.83,6.7,工作井以北,2,4.367',
  'SS2-JM1/S1-JM3,3762.117,7681.87,0.2,0,0.2,SS2-JM1/S1-JM3-1,8.48,ND,工作井以北,2,3.507',
  'BADROW,,1.0,1,0,1,X-1,7.0,ND,,2,',
].join('\n');

describe('parseBoreholeCsv', () => {
  const r = parseBoreholeCsv(CSV);
  it('按孔号聚合、行内字段齐全', () => {
    const b = r.boreholes.find(x => x.id === 'S1-JM1');
    expect(b.x).toBeCloseTo(3796.316);
    expect(b.y).toBeCloseTo(7657.852);
    expect(b.ground).toBeCloseTo(4.062);
    expect(b.layers).toHaveLength(2);
    expect(b.layers[0]).toEqual({ top: 0, bottom: 0.2, sampleId: 'S1-JM1-1', ph: 7.61, stratum: 2 });
  });
  it('按上层深度升序', () => {
    const b = r.boreholes.find(x => x.id === 'S1-JM1');
    expect(b.layers[0].top).toBeLessThan(b.layers[1].top);
  });
  it('合并孔号拆为两个同位置钻孔', () => {
    const a = r.boreholes.find(x => x.id === 'SS2-JM1');
    const c = r.boreholes.find(x => x.id === 'S1-JM3');
    expect(a && c).toBeTruthy();
    expect(a.x).toBe(c.x);
    expect(a.layers).toEqual(c.layers);
  });
  it('ND/缺值→null，坏行跳过并告警', () => {
    expect(r.warnings.some(w => w.includes('第6行'))).toBe(true);
    expect(r.boreholes.find(x => x.id === 'BADROW')).toBeUndefined();
  });
  it('缺必需列抛错', () => {
    expect(() => parseBoreholeCsv('A,B\n1,2')).toThrow(/必需列/);
  });
  it('容忍 BOM', () => {
    const txt = '﻿' + CSV;
    const r2 = parseBoreholeCsv(txt);
    expect(r2.boreholes.length).toBeGreaterThan(0);
  });
});

describe('splitPointIds', () => {
  it('斜杠拆分并去空白', () => {
    expect(splitPointIds(' SS2-JM1 / S1-JM3 ')).toEqual(['SS2-JM1', 'S1-JM3']);
    expect(splitPointIds('S1')).toEqual(['S1']);
    expect(splitPointIds('')).toEqual([]);
  });
});
