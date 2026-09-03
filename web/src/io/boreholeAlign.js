// io/boreholeAlign.js —— 场地坐标 → GPR 世界坐标 的相似变换（平移+等比+旋转）
// 线性最小二乘：to ≈ [[a,-b],[b,a]]·from + t
// 1 控制点 → 仅平移；≥2 控制点 → 闭式解。
export function solveSimilarity(pairs) {
  if (!pairs || !pairs.length) return null;
  const n = pairs.length;
  let cx = 0, cy = 0, ux = 0, uy = 0;
  for (const p of pairs) { cx += p.from[0]; cy += p.from[1]; ux += p.to[0]; uy += p.to[1]; }
  cx /= n; cy /= n; ux /= n; uy /= n;
  if (n === 1) return { a: 1, b: 0, tx: ux - cx, ty: uy - cy, scale: 1 };
  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0, D = 0;
  for (const p of pairs) {
    const dx = p.from[0] - cx, dy = p.from[1] - cy;
    const ex = p.to[0] - ux, ey = p.to[1] - uy;
    Sxx += dx * ex; Sxy += dx * ey; Syx += dy * ex; Syy += dy * ey;
    D += dx * dx + dy * dy;
  }
  if (D < 1e-12) return null;
  const a = (Sxx + Syy) / D;
  const b = (Sxy - Syx) / D;
  const scale = Math.hypot(a, b);
  if (!Number.isFinite(scale) || scale < 1e-9) return null;
  const tx = ux - (a * cx - b * cy);
  const ty = uy - (b * cx + a * cy);
  return { a, b, tx, ty, scale };
}

export function applySimilarity(tr, p) {
  return [tr.a * p[0] - tr.b * p[1] + tr.tx, tr.b * p[0] + tr.a * p[1] + tr.ty];
}
