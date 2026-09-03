// io/boreholeCsv.js —— 解析《从煤气到地层编码.csv》钻孔分层表（纯函数，无 DOM）
// 注：CSV 字段内不含逗号（值与列名可被引号包裹），按逗号切分即可。

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim().replace(/^"|"$/g, '');
  if (!t || t === 'ND' || t === '/') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const cell = (s) => String(s ?? '').trim().replace(/^"|"$/g, '');

export function splitPointIds(raw) {
  return cell(raw).split('/').map(s => s.trim()).filter(Boolean);
}

export function parseBoreholeCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('CSV 为空');
  const header = lines[0].split(',').map(h => cell(h));
  const need = ['监测点位', 'X', 'Y', '上层深度', '下层深度'];
  const missing = need.filter(n => !header.includes(n));
  if (missing.length) throw new Error(`缺少必需列（${missing.join('/')}）：${header.join('|')}`);
  const c = (name) => header.indexOf(name);
  const cId = c('监测点位'), cX = c('X'), cY = c('Y');
  const cTop = c('上层深度'), cBot = c('下层深度');
  const cSample = c('样品编号'), cPh = c('pH值');
  const cStr = c('2米分层（详查）'), cGround = c('地面高程/m');

  const byId = new Map();
  const warnings = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(',');
    const x = num(cells[cX]), y = num(cells[cY]);
    const top = num(cells[cTop]), bot = num(cells[cBot]);
    if (x == null || y == null || top == null || bot == null) {
      warnings.push(`第${r + 1}行数值缺失，跳过`);
      continue;
    }
    const ids = splitPointIds(cells[cId]);
    if (!ids.length) { warnings.push(`第${r + 1}行孔号缺失，跳过`); continue; }
    if (ids.length > 1) warnings.push(`第${r + 1}行合并孔号 ${ids.join('/')} → 复制到各孔`);
    for (const id of ids) {
      let b = byId.get(id);
      if (!b) {
        b = { id, x, y, ground: cGround >= 0 ? num(cells[cGround]) : null, layers: [] };
        byId.set(id, b);
      }
      b.layers.push({
        top, bottom: bot,
        sampleId: cSample >= 0 ? cell(cells[cSample]) : '',
        ph: cPh >= 0 ? num(cells[cPh]) : null,
        stratum: cStr >= 0 ? num(cells[cStr]) : null,
      });
    }
  }
  for (const b of byId.values()) b.layers.sort((a, z) => a.top - z.top);
  return { boreholes: [...byId.values()], warnings };
}
