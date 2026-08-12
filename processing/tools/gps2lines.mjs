// processing/tools/gps2lines.mjs —— 逐线 GPS → 道路参考系 + 逐线几何 + .utmgps + manifest
//
// 输入（data/mingxingroad/）：
//   明星路_NNN.gps         WGS84 经纬度（按道序，~5Hz）
//   明星路_NNN_A01.iprh    trace 数（LAST TRACE）、通道偏移（CH_X_OFFSET）
// 输出：
//   <out>/road.json                道路参考系：origin UTM、沿轨 u、跨轨 v
//   <out>/明星路_NNN/line.utmgps   逐线 4 角点轨迹（供 gpr2gvt --gps；只取角质心）
//   <out>/manifest.json            逐线世界几何 worldOffset/direction/traceCount
//
// 坐标系约定：
//   u = 001 线行进方向单位向量；v = 垂直跨轨单位向量；P0 = 001 trace-0 的 UTM。
//   along(P) = (P-P0)·u（沿 u 方向增大），cross(P) = (P-P0)·v。
//   direction = sign(along_end - along_start)：正向线 +1，反向线 -1（3D 用 scale.x=-1 镜像）。
//   世界摆放：volume 局部 X 沿道迹，group.position.x = alongStart、scale.x = direction，
//             group.position.y = crossOffset（+ 通道本地偏移即世界跨轨位置）。
//
// 用法: node processing/tools/gps2lines.mjs [--data data/mingxingroad] [--out dataset/lines]
//       [--lines 001,002,...] [--ref 001]
// 默认：12 条全长线 001 002 003 004 006 008 009 010 011 012 015 016，参考线 001。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const a = { data: 'data/mingxingroad', out: 'dataset/lines', ref: '001' };
  const def = ['001', '002', '003', '004', '006', '008', '009', '010', '011', '012', '015', '016'];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') a.data = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--ref') a.ref = argv[++i];
    else if (argv[i] === '--lines') a.lines = argv[++i].split(',');
  }
  a.lines = a.lines || def;
  return a;
}

// ---------------------------------------------------------------- WGS84 → UTM
// 标准 UTM 公式（WGS84，无第三方依赖），已对照共享轨迹验证（偏差 ~0.3/2.1m）。
function latLonToUtm(lat, lon) {
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
  const latRad = (lat * Math.PI) / 180, lonRad = (lon * Math.PI) / 180;
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
  const T = Math.tan(latRad) ** 2, C = ep2 * Math.cos(latRad) ** 2;
  const A = Math.cos(latRad) * (lonRad - lon0);
  const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * latRad
    - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latRad)
    + ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latRad)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * latRad));
  const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const Nor = k0 * (M + N * Math.tan(latRad) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return { E: E + 500000, N: (Nor < 0 ? 10000000 : 0) + Nor, zone };
}

// ---------------------------------------------------------------- 读取 .gps
// 列: date \t time:ms \t lat \t N/S \t lon \t E/W \t alt \t M \t q
function readGps(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map(l => {
    const f = l.split(/\t/);
    return { lat: parseFloat(f[2]), lon: parseFloat(f[4]) };
  });
}

// ---------------------------------------------------------------- 读取 .iprh
function readIprh(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const grab = (re) => {
    const m = txt.match(re);
    return m ? parseFloat(m[1]) : NaN;
  };
  return {
    traceCount: grab(/LAST TRACE:\s*(\d+)/),
    chXOffset: grab(/CH_X_OFFSET:\s*([-0-9.]+)/),
    distanceInterval: grab(/DISTANCE INTERVAL:\s*([-0-9.]+)/),
    zeroLevel: grab(/ZERO LEVEL:\s*(\d+)/),
  };
}

// ---------------------------------------------------------------- PCA 主轴
function pcaDir(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.E; cy += p.N; }
  cx /= pts.length; cy /= pts.length;
  let xx = 0, yy = 0, xy = 0;
  for (const p of pts) { xx += (p.E - cx) ** 2; yy += (p.N - cy) ** 2; xy += (p.E - cx) * (p.N - cy); }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { cx, cy, ux: Math.cos(theta), uy: Math.sin(theta) };
}

// ---------------------------------------------------------------- 重采样
// 均匀重采样到 n 点（含首末）。
function resample(pts, n) {
  if (pts.length <= 2 || n >= pts.length) return pts.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (pts.length - 1);
    const i0 = Math.floor(t), i1 = Math.min(pts.length - 1, i0 + 1);
    const fr = t - i0;
    out.push({
      E: pts[i0].E * (1 - fr) + pts[i1].E * fr,
      N: pts[i0].N * (1 - fr) + pts[i1].N * fr,
    });
  }
  return out;
}

// ---------------------------------------------------------------- main
const A = parseArgs(process.argv.slice(2));
const lines = A.lines;
const base = (n) => path.join(A.data, `明星路_${n}`);
const p0 = path.resolve(__dirname, '..', '..');

// 1. 读全部线 UTM
const all = new Map();
for (const n of lines) {
  const gps = readGps(base(n) + '.gps');
  const utm = gps.map(g => latLonToUtm(g.lat, g.lon));
  const iprh = readIprh(base(n) + '_A01.iprh');
  all.set(n, { gps, utm, iprh });
  console.log(`[${n}] gps=${gps.length}  trace=${iprh.traceCount}  chX=${iprh.chXOffset}  ` +
    `utm首=(${utm[0].E.toFixed(1)},${utm[0].N.toFixed(1)}) utm末=(${utm[utm.length-1].E.toFixed(1)},${utm[utm.length-1].N.toFixed(1)})`);
}

// 2. 参考系（默认 001）
const refN = A.ref;
const refUtm = all.get(refN).utm;
const { cx, cy, ux, uy } = pcaDir(refUtm);
// 使 u 指向参考线 trace-0 → trace-end
const dE = refUtm[refUtm.length - 1].E - refUtm[0].E;
const dN = refUtm[refUtm.length - 1].N - refUtm[0].N;
let u = { x: ux, y: uy };
if (u.x * dE + u.y * dN < 0) u = { x: -ux, y: -uy };
const v = { x: -u.y, y: u.x }; // 垂直跨轨
const P0 = refUtm[0];
const along = (P) => (P.E - P0.E) * u.x + (P.N - P0.N) * u.y;
const cross = (P) => (P.E - P0.E) * v.x + (P.N - P0.N) * v.y;

console.log(`\n参考系[${refN}]: u=(${u.x.toFixed(5)},${u.y.toFixed(5)}) v=(${v.x.toFixed(5)},${v.y.toFixed(5)}) ` +
  `P0=(${P0.E.toFixed(2)},${P0.N.toFixed(2)}) zone=${refUtm[0].zone}`);

// 3. 逐线几何
const manifest = { reference: { zone: refUtm[0].zone, originUtm: [P0.E, P0.N], alongVec: [u.x, u.y], crossVec: [v.x, v.y] }, lines: [] };
for (const n of lines) {
  const { utm, iprh, gps } = all.get(n);
  const proj = utm.map(P => ({ along: along(P), cross: cross(P) }));
  const alongStart = proj[0].along;
  const crossOffset = proj.reduce((s, q) => s + q.cross, 0) / proj.length;
  const direction = Math.sign(proj[proj.length - 1].along - proj[0].along) || 1;
  const lengthM = Math.abs(proj[proj.length - 1].along - proj[0].along);
  manifest.lines.push({
    id: `mingxingroad_${n}`,
    name: `明星路_${n}`,
    metaUrl: `/dataset/lines/明星路_${n}/metadata.json`,
    worldOffset: [Math.round(alongStart * 100) / 100, Math.round(crossOffset * 100) / 100, 0],
    direction,
    traceCount: iprh.traceCount,
    lengthM: Math.round(lengthM * 10) / 10,
    crossHalfWidthM: Math.abs(iprh.chXOffset),
    gpsPoints: gps.length,
  });
  console.log(`[${n}] alongStart=${alongStart.toFixed(2)}m  cross=${crossOffset.toFixed(2)}m  ` +
    `dir=${direction > 0 ? '+' : '-'}1  len=${lengthM.toFixed(1)}m`);

  // 4. 写逐线 line.utmgps（4 角点矩形，只取质心；重采样 ~100 点）
  const half = Math.abs(iprh.chXOffset) || 0.7;
  const resampled = resample(utm, 100);
  const rows = [];
  let prevHead = null;
  for (let i = 0; i < resampled.length; i++) {
    const P = resampled[i];
    let heading;
    if (i < resampled.length - 1) {
      heading = (Math.atan2(resampled[i + 1].E - P.E, resampled[i + 1].N - P.N) * 180) / Math.PI;
      prevHead = heading;
    } else {
      heading = prevHead ?? 0;
    }
    const ca = half * u.x, sa = half * u.y;   // 沿轨小偏移
    const cc = half * v.x, sc = half * v.y;   // 跨轨小偏移
    const c1 = [P.E - ca - cc, P.N - sa - sc];
    const c2 = [P.E + ca - cc, P.N + sa - sc];
    const c3 = [P.E + ca + cc, P.N + sa + sc];
    const c4 = [P.E - ca + cc, P.N - sa + sc];
    rows.push([...c1, ...c2, ...c3, ...c4, heading].map(x => x.toFixed(6)).join(','));
  }
  const lineDir = path.join(A.out, `明星路_${n}`);
  fs.mkdirSync(lineDir, { recursive: true });
  fs.writeFileSync(path.join(lineDir, 'line.utmgps'), rows.join('\n') + '\n');
}

// 5. 写 road.json + manifest.json
fs.mkdirSync(A.out, { recursive: true });
fs.writeFileSync(path.join(A.out, 'road.json'), JSON.stringify(manifest.reference, null, 2));
fs.writeFileSync(path.join(A.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n完成: ${manifest.lines.length} 线 → ${A.out}/manifest.json + road.json + 各线 line.utmgps`);
