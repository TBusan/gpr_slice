// io/dxfLoader.js —— DXF 文本/对象 → 线段数组（不依赖 dxf-parser，适配已有 DxfParser 输出）
// 输入：dxfObject = { entities: [...] }（dxf-parser 解析结果）
// 输出：lines = [[[x1,y1,z1], [x2,y2,z2]], ...]

const NUM = (v) => (v == null ? 0 : Number(v) || 0);

export function dxfToLines(dxf) {
  const out = [];
  if (!dxf || !Array.isArray(dxf.entities)) return out;
  for (const e of dxf.entities) {
    if (!e || !e.type) continue;
    if (e.type === 'LINE') {
      const v = e.vertices || (e.start && e.end ? [e.start, e.end] : null);
      if (v && v.length >= 2) out.push([toPt(v[0]), toPt(v[1])]);
    } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      const v = e.vertices || [];
      for (let i = 0; i < v.length - 1; i++) {
        out.push([toPt(v[i]), toPt(v[i + 1])]);
      }
    }
    // CIRCLE / ARC / TEXT / HATCH / INSERT：本期不展开，几何精度不够
  }
  return out;
}

function toPt(v) {
  if (Array.isArray(v)) return [NUM(v[0]), NUM(v[1]), NUM(v[2])];
  if (v && typeof v === 'object') return [NUM(v.x), NUM(v.y), NUM(v.z)];
  return [0, 0, 0];
}

export function dxfBoundingBox(lines) {
  if (!lines.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const ln of lines) for (const p of ln) for (let k = 0; k < 3; k++) {
    if (p[k] < min[k]) min[k] = p[k];
    if (p[k] > max[k]) max[k] = p[k];
  }
  return { min, max };
}
