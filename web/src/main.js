// main.js —— 装配入口：manifest(多线) → 样式 → 3D 宿主 → 切片/GPS 视图 → 状态 HUD
//
// 多线模式（默认）：加载 dataset/lines/manifest.json → 并行 loadMetadata N 份 →
//   MultiLineHost（共享渲染器/相机/缓存，12 线按真实 GPS worldOffset 同显，逐线开关）→
//   sliceView 多线（B-Scan 选定线、C-Scan 单线/全宽合成）→ gpsMapView 全轨迹。
// 单线回退：manifest 缺失/加载失败 → 现有 /dataset/metadata.json 单线路径。

import { loadMetadata, loadManifest } from './dataset/metadata.js';
import { Style } from './render/style.js';
import { VolumeScene } from './render/volumeScene.js';
import { MultiLineHost } from './render/multiLineHost.js';
import { createStylePanel } from './render/stylePanel.js';
import { SliceView } from './render/sliceView.js';
import { GpsMapView } from './render/gpsMapView.js';
import { ViewCube } from './render/viewCube.js';
import { createSceneGizmos, attachScaleBar } from './render/sceneGizmos.js';
import { LayerManager } from './layers/layerManager.js';
import { createLayerPanel } from './render/layerPanel.js';
import { createBoreholePanel } from './render/boreholePanel.js';
import { parseBoreholeCsv } from './io/boreholeCsv.js';
import { buildBoreholeMeshes, siteToWorld } from './render/boreholeLayer.js';

const statusEl = document.getElementById('status');
const hudEl = document.getElementById('hud');
const viewportEl = document.getElementById('viewport');
const linePanelEl = document.getElementById('linePanel');
const lineSelEl = document.getElementById('lineSelect');
const cscanSelEl = document.getElementById('cscanMode');

// 测线调色板（与 gpsMapView / linePanel swatch 共用）
const LINE_COLORS = [
  '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9A6324', '#dcbeff',
];

// metaUrl(/dataset/lines/明星路_001/metadata.json) → 瓦片根目录
const baseOf = (metaUrl) => metaUrl.replace(/\/metadata\.json$/, '');

(async function boot() {
  let manifest = null;
  try { manifest = await loadManifest(); }
  catch (err) { console.warn('no manifest, single-line fallback:', err.message); }
  if (manifest && manifest.lines && manifest.lines.length) {
    try { await bootMulti(manifest); }
    catch (err) {
      console.error('multi boot failed, single-line fallback:', err);
      await bootSingle();
    }
  } else {
    await bootSingle();
  }
})();

// ---- 单线回退路径（保持原有行为）----
async function bootSingle() {
  let meta;
  try {
    meta = await loadMetadata('/dataset/metadata.json');
  } catch (err) {
    setStatus('✗ 无法加载 /dataset/metadata.json（请先运行 C++ 管线生成 dataset/）');
    console.error(err);
    return;
  }

  const style = new Style(meta.value.globalMin, meta.value.globalMax);
  const scene = new VolumeScene(viewportEl, meta);
  scene.style = style;
  scene.onStatus = (s) => updateHud(s);
  createStylePanel(document.getElementById('stylePanel'), style, meta);

  const lm = new LayerManager(); lm.attach(scene);
  createLayerPanel(document.getElementById('layerPanel'), lm);
  lm.add({ id: 'gizmos', label: '场景参照（网格/指北针）', object3D: createSceneGizmos({ ref: meta.reference }).object3D, builtin: true });
  attachScaleBar(viewportEl, scene.camera);
  setupBoreholeUI({ lm, meta, getHost: () => scene });

  const sliceView = new SliceView({ meta, style, basePath: '/dataset' });
  const gpsMapView = new GpsMapView(document.getElementById('mapPanel'), scene, meta);
  const viewCube = new ViewCube(document.getElementById('viewCube'), scene);
  (function frame() {
    requestAnimationFrame(frame);
    try {
      sliceView.update();
      gpsMapView.update();
      viewCube.update();
    } catch (err) { console.error('[frame]', err); }
  })();

  lineSelEl.style.display = 'none';
  cscanSelEl.style.display = 'none';
  linePanelEl.style.display = 'none';

  setStatus(`已加载 ${meta.dataset.name} · ${meta.volume.dimensions.join('×')} vox`);
  window.__scene = scene;
  window.__slice = sliceView;
  window.__gps = gpsMapView;
  window.__viewCube = viewCube;
  scene.start();
}

// ---- 多线路径：manifest + 并行元数据 + MultiLineHost ----
async function bootMulti(manifest) {
  const metas = await Promise.all(manifest.lines.map(l => loadMetadata(l.metaUrl)));
  let gmin = Infinity, gmax = -Infinity;
  for (const m of metas) {
    if (m.value.globalMin < gmin) gmin = m.value.globalMin;
    if (m.value.globalMax > gmax) gmax = m.value.globalMax;
  }
  const style = new Style(gmin, gmax);

  const lineCfgs = manifest.lines.map((l, i) => ({
    meta: metas[i],
    basePath: baseOf(l.metaUrl),
    worldOffset: l.worldOffset,
    direction: l.direction,
    lineId: l.id,
    visible: true,
    style,
  }));

  const host = new MultiLineHost(viewportEl, lineCfgs);
  createStylePanel(document.getElementById('stylePanel'), style, metas[0]);
  const lm = new LayerManager(); lm.attach(host);
  createLayerPanel(document.getElementById('layerPanel'), lm);
  lm.add({ id: 'gizmos', label: '场景参照（网格/指北针）', object3D: createSceneGizmos({ ref: metas[0].reference }).object3D, builtin: true });
  attachScaleBar(viewportEl, host.camera);
  setupBoreholeUI({ lm, meta: metas[0], getHost: () => host });

  // B-Scan 数据源：测线下拉
  lineSelEl.innerHTML = '';
  manifest.lines.forEach((l, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = l.name;
    lineSelEl.appendChild(opt);
  });

  // 切片视图（多线）：同一份 lines 配置，共享 visible 状态
  const sliceLines = manifest.lines.map((l, i) => ({
    id: l.id, name: l.name, meta: metas[i], basePath: baseOf(l.metaUrl),
    worldOffset: l.worldOffset, direction: l.direction, visible: true,
  }));
  const sliceView = new SliceView({ style, lines: sliceLines });
  lineSelEl.addEventListener('change', () => sliceView.setSelected(Number(lineSelEl.value)));
  cscanSelEl.addEventListener('change', () => sliceView.setCscanMode(cscanSelEl.value));
  cscanSelEl.value = 'composite'; // 多线默认全宽合成（C-Scan 主呈现）
  sliceView.setCscanMode('composite');

  // 逐线可见性（3D + C-Scan 合成共用）
  buildLinePanel(host, sliceView, manifest.lines, lineCfgs);

  // GPS 全轨迹
  const tracks = manifest.lines.map((l, i) => ({
    pts: (metas[i].gpsTrack && metas[i].gpsTrack.points) || [],
    color: LINE_COLORS[i % LINE_COLORS.length],
    name: l.name,
  }));
  const gpsMapView = new GpsMapView(document.getElementById('mapPanel'), {
    tracks,
    refTrack: tracks[0] ? tracks[0].pts : [],
    worldXRange: hostWorldXRange(host),
    getCameraX: () => host.camera.position.x,
  });
  // 跨轨放大滑块：0=自动（现有启发式），>0=固定倍数
  const gpsZoomWrap = document.getElementById('gpsZoomWrap');
  const gpsZoomSlider = document.getElementById('gpsZoomSlider');
  const gpsZoomVal = document.getElementById('gpsZoomVal');
  gpsZoomWrap.style.display = 'flex';
  const gpsZoomSync = () => {
    const f = Number(gpsZoomSlider.value);
    gpsMapView.setCrossTrackFactor(f);
    gpsZoomVal.textContent = f === 0 ? '自动' : `${f}×`;
  };
  gpsZoomSlider.addEventListener('input', gpsZoomSync);
  gpsZoomSync();
  const viewCube = new ViewCube(document.getElementById('viewCube'), host);

  (function frame() {
    requestAnimationFrame(frame);
    try {
      sliceView.update();
      gpsMapView.update();
      viewCube.update();
      updateHudThrottled(host.status());
    } catch (err) { console.error('[frame]', err); }
  })();

  setStatus(`多测线 ${manifest.lines.length} 条 · ${metas[0].dataset.name}（GPS 定位）`);
  window.__scene = host;
  window.__slice = sliceView;
  window.__gps = gpsMapView;
  window.__viewCube = viewCube;
  host.start();
}

function buildLinePanel(host, sliceView, manifestLines, lineCfgs) {
  linePanelEl.style.display = 'block';
  const list = document.getElementById('lineList');
  list.innerHTML = '';
  manifestLines.forEach((l, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = LINE_COLORS[i % LINE_COLORS.length];
    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = l.name;
    name.title = `${l.id} · 跨轨 ${lineCfgs[i].worldOffset[1].toFixed(2)}m`;
    label.append(cb, sw, name);
    list.appendChild(label);
    cb.addEventListener('change', () => {
      const on = cb.checked;
      host.setLineVisible(l.id, on);
      sliceView.setVisible(l.id, on);
    });
  });
}

function hostWorldXRange(host) {
  const b = host.worldBounds();
  return [b.min.x, b.max.x];
}

let _lastHud = 0;
function updateHudThrottled(s) {
  const now = performance.now();
  if (now - _lastHud < 500) return;
  _lastHud = now;
  updateHud(s);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updateHud(s) {
  hudEl.innerHTML =
    `视口瓦片 ${s.meshes} · 已加载 ${s.loaded} · 排队 ${s.queue} · 传输中 ${s.inFlight} · 缓存 ${s.cache}<br>` +
    `LOD 目标 ${s.desired} · ${s.fps} fps` +
    (s.linear ? '' : ' · <span style="color:#ff8">浮点线性不可用，退化为最近邻</span>');
}

// ---- T7 钻孔 UI：拖入 CSV → 解析 → 3D 层组 + 面板 ----
function setupBoreholeUI({ lm, meta, getHost }) {
  const dropEl = document.getElementById('dropHint');
  let pendingSection = null;
  let boreholeMap = null; // 解析后填
  let worldPositions = null;

  const panel = createBoreholePanel(document.getElementById('boreholePanel'), {
    onToggle: (id, on) => {
      const bhLayer = lm.get('boreholes');
      if (!bhLayer) return;
      const grp = bhLayer.object3D.getObjectByName(`borehole:${id}`);
      if (grp) grp.visible = on;
    },
    onSection: (id) => {
      if (!pendingSection) {
        pendingSection = id;
        flashStatus(`📌 剖面：起点 ${id} — 再点另一孔「剖面」连线`);
      } else if (pendingSection === id) {
        pendingSection = null;
        flashStatus('已取消剖面选择');
      } else {
        addSectionLink({ lm, meta, worldPositions, idA: pendingSection, idB: id, boreholeMap });
        flashStatus(`✓ 剖面：${pendingSection} ↔ ${id}`);
        pendingSection = null;
      }
    },
  });
  window.__bhPanel = panel;

  // drag/drop
  let dragDepth = 0;
  const onEnter = (e) => { e.preventDefault(); dragDepth++; dropEl.classList.add('on'); };
  const onLeave = (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.classList.remove('on'); };
  const onOver  = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const onDrop  = async (e) => {
    e.preventDefault(); dragDepth = 0; dropEl.classList.remove('on');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { flashStatus('✗ 仅支持 .csv 钻孔文件'); return; }
    const text = await f.text();
    let parsed;
    try { parsed = parseBoreholeCsv(text); }
    catch (err) { flashStatus('✗ CSV 解析失败：' + err.message); return; }
    if (parsed.warnings.length) console.warn('CSV warnings:', parsed.warnings);
    addBoreholeLayer({ lm, meta, parsed });
    panel.setBoreholes(parsed.boreholes);
    flashStatus(`✓ 钻孔 ${parsed.boreholes.length} 个（${parsed.warnings.length} 警告）`);
  };
  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('dragover', onOver);
  window.addEventListener('drop', onDrop);
}

function addBoreholeLayer({ lm, meta, parsed }) {
  if (!meta.reference) { console.warn('无 manifest.reference，钻孔无法定位'); return; }
  // 直接用 CSV 坐标当作 UTM（演示用；T12 数据源切换时再做相似变换）
  worldPositions = {};
  for (const b of parsed.boreholes) {
    const [wx, wy] = siteToWorld(meta.reference, b.x, b.y);
    worldPositions[b.id] = [wx, wy, b.ground != null ? b.ground : 0];
  }
  const object3D = buildBoreholeMeshes({ boreholes: parsed.boreholes, worldPositions, ref: meta.reference, radius: 0.3 });
  lm.add({ id: 'boreholes', label: `钻孔（${parsed.boreholes.length}）`, object3D });
  boreholeMap = new Map(parsed.boreholes.map(b => [b.id, b]));
}

import { buildSectionLinkMeshes } from './render/sectionLinkLayer.js';
function addSectionLink({ lm, meta, worldPositions, idA, idB, boreholeMap }) {
  if (!meta.reference || !worldPositions || !boreholeMap) return;
  const a = boreholeMap.get(idA), b = boreholeMap.get(idB);
  if (!a || !b) return;
  const grp = buildSectionLinkMeshes({ a, b, worldPositions, ref: meta.reference });
  lm.add({ id: `section:${idA}-${idB}`, label: `剖面 ${idA}↔${idB}`, object3D: grp });
}
  if (!meta.reference) { console.warn('无 manifest.reference，钻孔无法定位'); return; }
  // 直接用 CSV 坐标当作 UTM（演示用；T12 数据源切换时再做相似变换）
  const worldPositions = {};
  for (const b of parsed.boreholes) {
    const [wx, wy] = siteToWorld(meta.reference, b.x, b.y);
    worldPositions[b.id] = [wx, wy, b.ground != null ? b.ground : 0];
  }
  const object3D = buildBoreholeMeshes({ boreholes: parsed.boreholes, worldPositions, ref: meta.reference, radius: 0.3 });
  lm.add({ id: 'boreholes', label: `钻孔（${parsed.boreholes.length}）`, object3D });
}

function flashStatus(text) { setStatus(text); }

// 清理（HMR 用）
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.location.reload();
  });
}
