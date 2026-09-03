// io/volumeSampler.js —— 世界 (x,y,z) → 任一激活线局部 (along, cross, depth) → 振幅
// 与 host 解耦：sampleLocal 由调用方注入（从真实瓦片取样）
//
// 约定：每条线 info = { id, worldOffset:[dx,dy], direction:±1, ref, halfCross, length, depthMax, active }
//   worldOffset = 该线原点在世界坐标的 (wx, wy)
//   ref.{originUtm, alongVec, crossVec} 决定「世界 +X / +Y」对应 UTM 方向

// 世界 → 线的局部 (along, cross, depth) + inRange 判定
// depth = 0 在地面，+Z 向下为深度
export function worldToLocal({ x, y, z }, line) {
  const ox = x - line.worldOffset[0];
  const oy = y - line.worldOffset[1];
  // 局部轴 = ref 的 alongVec/crossVec
  const along = (ox * line.ref.alongVec[0] + oy * line.ref.alongVec[1]) * line.direction;
  const cross = ox * line.ref.crossVec[0] + oy * line.ref.crossVec[1];
  const depth = z; // 地面高程=0，深度直接用 z（host 在多线时按 line.groundOffset 校正；本期用统一基面）
  return {
    along, cross, depth,
    inRange:
      cross >= -line.halfCross && cross <= line.halfCross &&
      along >= 0 && along <= line.length &&
      depth >= 0 && depth <= line.depthMax,
  };
}

// 在多线中选 cross 距离最近且 inRange 的激活线，调用 sampleLocal 取样
export function sampleWorld({ x, y, z }, { lines, sampleLocal }) {
  let best = null;
  for (const line of lines) {
    if (!line.active) continue;
    const l = worldToLocal({ x, y, z }, line);
    if (!l.inRange) continue;
    const dist = Math.abs(l.cross);
    if (best == null || dist < best.dist) best = { line, l, dist };
  }
  if (!best) return null;
  const r = sampleLocal(best.line.id, best.l.along, best.l.cross, best.l.depth);
  return r ? { ...r, lineId: best.line.id, along: best.l.along, cross: best.l.cross, depth: best.l.depth } : null;
}
