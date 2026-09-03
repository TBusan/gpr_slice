// processing/tools/regen_dataset.mjs —— 用新格式（tile 256,16,128 + chunk 16）重生成全部测线
//
// 背景：A（瓦片形状）+ C（chunk 打包）的代码已实现，但旧数据仍是 256,32,32 无 chunk。
// 本脚本逐线清旧 tiles → 调 gpr2gvt.exe 重生成 → 并把 001 线复制到根 /dataset（单线回退）。
// 不重跑 gps2lines.mjs（manifest/road/line.utmgps 几何由 GPS 决定，与 A+C 无关，保持原样）。
//
// 用法（仓库根）: node processing/tools/regen_dataset.mjs
//       可加 --lines 001,002,... 只重生成部分线；--exe 指定 gpr2gvt 路径。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // 仓库根

const DEF_LINES = ['001', '002', '003', '004', '006', '008', '009', '010', '011', '012', '015', '016'];

function parseArgs(argv) {
  const a = { lines: null, exe: path.join(ROOT, 'processing', 'build', 'gpr2gvt.exe') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lines') a.lines = argv[++i].split(',');
    else if (argv[i] === '--exe') a.exe = path.resolve(ROOT, argv[++i]);
  }
  a.lines = a.lines || DEF_LINES;
  return a;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function cpDir(src, dst) {
  // 注意：Node 22 在 Windows 上 fs.cpSync(recursive) 会静默崩溃（exit 127、不抛错）。
  // 改用手动递归复制（readdirSync + copyFileSync），逐文件，稳定且可报数。
  let files = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) walk(sp, dp);
      else { fs.copyFileSync(sp, dp); files++; }
    }
  };
  walk(src, dst);
  return files;
}

function runGpr2gvt(n) {
  const lineDir = path.join(ROOT, 'dataset', 'lines', `明星路_${n}`);
  const args = [
    `--line`, path.join('data', 'mingxingroad', `明星路_${n}`),
    `--gps`, path.join('dataset', 'lines', `明星路_${n}`, 'line.utmgps'),
    `--out`, path.join('dataset', 'lines', `明星路_${n}`),
    `--tile-size`, '256,16,128',
    `--chunk-size`, '16',
  ];
  const r = spawnSync(A.exe, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`gpr2gvt 退出码 ${r.status}（line ${n}）`);
  // 校验产物：metadata 已写 chunkSize/chunkOnly，且无残留 .gvt
  const meta = JSON.parse(fs.readFileSync(path.join(lineDir, 'metadata.json'), 'utf8'));
  if (meta.storage.chunkSize !== 16) throw new Error(`line ${n} chunkSize != 16`);
  if (meta.storage.chunkOnly !== true) throw new Error(`line ${n} 缺 chunkOnly`);
  const leftover = (() => {
    try { return fs.readdirSync(path.join(lineDir, 'tiles')).length; } catch { return -1; }
  })();
  return { n, tile: meta.tile.size, levels: meta.levels.length, tilesDirEntries: leftover };
}

const A = parseArgs(process.argv.slice(2));
if (!fs.existsSync(A.exe)) {
  console.error(`找不到 gpr2gvt.exe: ${A.exe}\n先 cmake --build processing/build`);
  process.exit(1);
}

const t0 = Date.now();
console.log(`== 重生成 ${A.lines.length} 线（tile 256,16,128 + chunk 16）==`);
for (const n of A.lines) {
  const lineDir = path.join(ROOT, 'dataset', 'lines', `明星路_${n}`);
  console.log(`\n[${n}] 清旧 tiles: ${lineDir}/tiles`);
  rmrf(path.join(lineDir, 'tiles'));
  rmrf(path.join(lineDir, 'metadata.json'));

  const t1 = Date.now();
  const info = runGpr2gvt(n);
  console.log(`[${n}] 完成 tile=${info.tile} levels=${info.levels} ` +
    `tiles目录条目=${info.tilesDirEntries} 用时=${((Date.now() - t1) / 1000).toFixed(1)}s`);
}

// 根 /dataset 单线回退：001 的 tiles + metadata.json（basePath 不同但相对路径一致，直接复制）
console.log(`\n== 复制 明星路_001 → 根 /dataset ==`);
const rootTiles = path.join(ROOT, 'dataset', 'tiles');
const rootMeta = path.join(ROOT, 'dataset', 'metadata.json');
rmrf(rootTiles);
rmrf(rootMeta);
const nRoot = cpDir(path.join(ROOT, 'dataset', 'lines', '明星路_001', 'tiles'), rootTiles);
fs.copyFileSync(path.join(ROOT, 'dataset', 'lines', '明星路_001', 'metadata.json'), rootMeta);
if (!fs.existsSync(rootMeta) || nRoot === 0) throw new Error('根 /dataset 复制失败');
console.log(`根 /dataset 已更新（tiles ${nRoot} 文件 + metadata.json）`);

console.log(`\n== 完成（总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）==`);
