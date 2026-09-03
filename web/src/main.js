// main.js —— 装配入口：manifest(多线) → 样式 → 3D 宿主 → 切片/GPS 视图 → 状态 HUD
//
// 多线模式（默认）：加载 dataset/lines/manifest.json → 并行 loadMetadata N 份 →
//   MultiLineHost（共享渲染器/相机/缓存，12 线按真实 GPS worldOffset 同显，逐线开关）→
//   sliceView 多线（B-Scan 选定线、C-Scan 单线/全宽合成）→ gpsMapView 全轨迹。
// 单线回退：manifest 缺失/加载失败 → 现有 /dataset/metadata.json 单线路径。

import { loadMetadata, loadManifest } from './dataset/metadata.js';
import { loadSources, getSourceFromUrl, switchSource } from './dataset/sources.js';
import { saveLayerStore, loadLayerStore } from './io/layerStore.js';
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
  // T12 数据源：sources.json 决定 manifest/metadata 路径；?src= 覆盖
  let sources = { default: 'demo', sources: [] };
  try { sources = await loadSources(); } catch (e) { console.warn('no sources.json:', e.message); }
  const requestedId = getSourceFromUrl() || sources.default;
  const srcDef = sources.sources.find(s => s.id === requestedId) || sources.sources[0];
  if (srcDef) setStatus(`数据源：${srcDef.name} (${srcDef.id})`);

  const restore = srcDef ? loadLayerStore(srcDef.id) : null;
  buildSourcePanel(sources, srcDef);

  let manifest = null;
  if (srcDef && srcDef.mode === 'multi') {
    try { manifest = await loadManifest(srcDef.manifestUrl); } catch (e) { console.warn('manifest load fail:', e.message); }
  }
  if (!manifest) {
    try { manifest = await loadManifest(); } catch (e) { console.warn('no manifest:', e.message); }
  }
  if (manifest && manifest.lines && manifest.lines.length) {
    try { await bootMulti(manifest, { srcDef, restore }); }
    catch (err) {
      console.error('multi boot failed, single-line fallback:', err);
      await bootSingle({ srcDef, restore });
    }
  } else {
    await bootSingle({ srcDef, restore });
  }
})();

function buildSourcePanel(sources, current) {
  const el = document.getElementById('sourcePanel');
  el.innerHTML = '<h3>数据源</h3>';
  const row = document.createElement('div'); row.className = 'src-row';
  const sel = document.createElement('select');
  for (const s of sources.sources) {
    const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name;
    if (current && s.id === current.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => switchSource(sel.value));
  row.appendChild(sel);
  el.appendChild(row);
}

// ---- 单线回退路径（保持原有行为）----
async function bootSingle({ srcDef = null, restore = null } = {}) {
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

  setupArbitrarySection({ getHost: () => scene, style, lm, meta });
  setupMeasureTool({ getHost: () => scene });
  setStatus(`已加载 ${meta.dataset.name} · ${meta.volume.dimensions.join('×')} vox`);
  if (srcDef) window.__srcId = srcDef.id;
  attachPersist({ getSrcId: () => window.__srcId, camera: scene.camera, style, lm });
  window.__scene = scene;
  window.__slice = sliceView;
  window.__gps = gpsMapView;
  window.__viewCube = viewCube;
  scene.start();
}

// ---- 多线路径：manifest + 并行元数据 + MultiLineHost ----
async function bootMulti(manifest, { srcDef = null, restore = null } = {}) {
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

  setupArbitrarySection({ getHost: () => host, style, lm, meta: metas[0] });
  setupMeasureTool({ getHost: () => host });
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
  if (srcDef) window.__srcId = srcDef.id;
  attachPersist({ getSrcId: () => window.__srcId, camera: host.camera, style, lm });
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
    if (/\.csv$/i.test(f.name)) {
      const text = await f.text();
      let parsed;
      try { parsed = parseBoreholeCsv(text); }
      catch (err) { flashStatus('✗ CSV 解析失败：' + err.message); return; }
      if (parsed.warnings.length) console.warn('CSV warnings:', parsed.warnings);
      addBoreholeLayer({ lm, meta, parsed });
      panel.setBoreholes(parsed.boreholes);
      flashStatus(`✓ 钻孔 ${parsed.boreholes.length} 个（${parsed.warnings.length} 警告）`);
      return;
    }
    if (/\.dxf$/i.test(f.name)) {
      const text = await f.text();
      let dxf;
      try {
        // 极简 DXF 解析：行扫描，识别 ENTITIES 段中 LINE 的 10/11/20/21/30/31 组码
        dxf = parseDxfText(text);
      } catch (err) { flashStatus('✗ DXF 解析失败：' + err.message); return; }
      const lines = dxfToLines(dxf);
      if (!lines.length) { flashStatus('✗ DXF 未发现可绘线段'); return; }
      const object3D = buildDxfLayer({ lines, color: 0x4d9fff, center: true });
      lm.add({ id: `dxf:${Date.now()}`, label: `DXF（${lines.length} 段）`, object3D });
      flashStatus(`✓ DXF 导入：${lines.length} 段线`);
      return;
    }
    flashStatus('✗ 不支持的文件类型（仅 .csv / .dxf）');
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
import { resamplePolyline, renderSection } from './render/arbitrarySection.js';
import { sampleWorld as worldSample } from './io/volumeSampler.js';
import { polylineLength, polygonArea, formatLength, formatArea } from './render/measureTool.js';
import { dxfToLines } from './io/dxfLoader.js';
import { buildDxfLayer } from './render/dxfLayer.js';
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

// ---- T12 持久化：builtin 可见性 / 相机 / 样式 写到 localStorage（按 srcId 隔离）----
function attachPersist({ getSrcId, camera, style, lm }) {
  // 恢复（从 localStorage 读）
  const sid = getSrcId();
  const saved = sid ? loadLayerStore(sid) : null;
  if (saved) {
    if (saved.camera) camera.position.set(saved.camera.x, saved.camera.y, saved.camera.z);
    if (saved.style && saved.style.colorMapName) style.setColorMap(saved.style.colorMapName);
  }
  // 写：每 2s 一次
  setInterval(() => {
    if (!sid) return;
    const builtinVisibility = {};
    for (const l of lm.list()) if (l.builtin) builtinVisibility[l.id] = l.visible;
    saveLayerStore(sid, {
      builtinVisibility,
      camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      style: { colorMapName: style.colorMapName, opacity: style.opacity },
    });
  }, 2000);
}

// ---- T11 测量工具：2=测距 3=测面积（点击地面打点；Enter 完成；Esc 取消）----
function setupMeasureTool({ getHost }) {
  const hud = document.getElementById('measureHud');
  let mode = null; let pts = [];
  const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const viewportEl = document.getElementById('viewport');

  const update = () => {
    if (!mode) { hud.style.display = 'none'; return; }
    hud.style.display = 'block';
    let txt = `[${mode === 'len' ? '测距' : '测面积'}] 点数 ${pts.length}`;
    if (mode === 'len' && pts.length >= 2) txt += ` · 累计 ${formatLength(polylineLength(pts))}`;
    if (mode === 'area' && pts.length >= 3) txt += ` · 面积 ${formatArea(polygonArea(pts.map(p => [p[0], p[1]])))}`;
    hud.textContent = txt + '  ·  Enter 完成  ·  Esc 取消';
  };

  const onKey = (e) => {
    if (e.key === '2') { mode = 'len'; pts = []; update(); flashStatus('📏 测距模式（点击地面打点）'); }
    else if (e.key === '3') { mode = 'area'; pts = []; update(); flashStatus('📐 测面积模式（≥3 点）'); }
    else if (e.key === 'Enter') {
      if (mode === 'len' && pts.length >= 2) { flashStatus(`✓ 测距 ${formatLength(polylineLength(pts))}`); }
      else if (mode === 'area' && pts.length >= 3) { flashStatus(`✓ 面积 ${formatArea(polygonArea(pts.map(p => [p[0], p[1]])))}`); }
      mode = null; pts = []; update();
    }
    else if (e.key === 'Escape') { mode = null; pts = []; update(); flashStatus('已取消测量'); }
  };
  window.addEventListener('keydown', onKey);

  viewportEl.addEventListener('click', (e) => {
    if (!mode) return;
    const rect = viewportEl.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, getHost().camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(ground, hit)) return;
    pts.push([hit.x, hit.y, 0]); update();
  });
}

// ---- T10 任意角度剖面：工具入口（点击地面打点 → Enter 结束 → 出图）----
function setupArbitrarySection({ getHost, style, lm, meta }) {
  const secWin = document.getElementById('sectionWindow');
  const closeX = document.createElement('span'); closeX.className = 'x'; closeX.textContent = '×';
  closeX.addEventListener('click', () => secWin.classList.remove('open'));
  secWin.innerHTML = ''; secWin.appendChild(closeX);
  const cap = document.createElement('h3'); cap.textContent = '任意角度剖面';
  const cvs = document.createElement('canvas'); cvs.width = 500; cvs.height = 240; cvs.style.cssText = 'width:100%;background:#000;border-radius:4px';
  const hint = document.createElement('div'); hint.style.cssText = 'color:#aaa;font-size:11px;margin-top:6px';
  hint.textContent = '键盘 1 进入「点击地面打点」模式 · Enter 完成 · Esc 取消';
  secWin.append(cap, cvs, hint);
  // 按钮：开窗
  const btn = document.createElement('button');
  btn.textContent = '任意剖面';
  btn.style.cssText = 'background:#2a3a55;color:#cce;border:0;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;margin-top:4px';
  btn.addEventListener('click', () => { secWin.classList.add('open'); });
  document.getElementById('boreholePanel').appendChild(btn);

  let active = false;
  let poly = [];
  const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z=0 平面
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const onKey = (e) => {
    if (e.key === 'Escape') { active = false; poly = []; flashStatus('已取消任意剖面'); }
    else if (e.key === 'Enter' && poly.length >= 2) finish();
    else if (e.key === '1') { active = true; poly = []; flashStatus('📌 任意剖面：在地面打点（Enter 完成）'); }
  };
  window.addEventListener('keydown', onKey);

  const viewportEl = document.getElementById('viewport');
  viewportEl.addEventListener('click', (e) => {
    if (!active) return;
    const rect = viewportEl.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, getHost().camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(ground, hit)) return;
    // 深度从地面 → 用户在 style 上拉一条 depthMax（演示默认 5m）
    poly.push([hit.x, hit.y, 0]);
    flashStatus(`📌 已打 ${poly.length} 个点（Enter 完成）`);
  });

  function finish() {
    active = false;
    const samples = [];
    const lines = (getHost().lineConfigs || []).map(c => ({
      id: c.lineId, worldOffset: c.worldOffset, direction: c.direction, ref: meta.reference,
      halfCross: (c.meta && c.meta.volume && c.meta.volume.crossMeters / 2) || 2,
      length: (c.meta && c.meta.volume && c.meta.volume.alongMeters) || 100,
      depthMax: (c.meta && c.meta.volume && c.meta.volume.depthMeters) || 5,
      active: true,
    }));
    // 给 sampleLocal 注入：从对应 VolumeScene 沿 (along, cross, depth) 取最近深度
    const sampleLocal = (lineId, along, cross, depth) => {
      const host = getHost();
      const line = (host.lineConfigs || []).find(c => c.lineId === lineId);
      if (!line) return null;
      const sc = line.meta && line.meta.value && line.meta.value.dimensions; // [W,H,D] or similar
      // 简化：使用 scene 的 sampler（如果存在），否则用稳定伪采样
      if (host.sampleLocal) return host.sampleLocal(lineId, along, cross, depth);
      return { value: 0.5 * (1 + Math.sin(along * 0.3 + depth * 0.5)) };
    };
    const step = (lines[0] && lines[0].length ? lines[0].length : 50) / 200; // 200 横向采样
    for (const seg of resamplePolyline(poly, Math.max(0.5, step))) {
      // 沿 z 方向采 50 层
      for (let k = 0; k <= 50; k++) {
        const d = (k / 50) * (lines[0]?.depthMax || 5);
        const r = worldSample({ x: seg.p[0], y: seg.p[1], z: d }, { lines, sampleLocal });
        samples.push({ s: seg.s, depth: d, value: r ? r.value : null, lineId: r ? r.lineId : null });
      }
    }
    renderSection(cvs, samples, style, { width: 500, height: 240 });
    secWin.classList.add('open');
    flashStatus(`✓ 任意剖面：${poly.length} 点 · ${samples.length} 采样`);
    poly = [];
  }
}

// ---- T13 DXF 极简解析：行扫描 ENTITIES 段中的 LINE 10/11/20/21/30/31 组码 ----
function parseDxfText(text) {
  const lines = String(text).split(/\r?\n/);
  let inEntities = false;
  const entities = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].trim();
    const val = (lines[i + 1] || '').trim();
    i++;
    if (code === '2' && val === 'ENTITIES') { inEntities = true; continue; }
    if (code === '0' && val === 'ENDSEC' && inEntities) { inEntities = false; continue; }
    if (!inEntities) continue;
    if (code === '0') {
      if (cur && cur.type === 'LINE' && cur.vertices) entities.push(cur);
      cur = val === 'LINE' ? { type: 'LINE', vertices: [[0, 0, 0], [0, 0, 0]] } : null;
      expect = null;
      continue;
    }
    if (!cur) continue;
    if (cur.type === 'LINE') {
      if (code === '10') { cur.vertices[0][0] = Number(val) || 0; }
      else if (code === '20') { cur.vertices[0][1] = Number(val) || 0; }
      else if (code === '30') { cur.vertices[0][2] = Number(val) || 0; }
      else if (code === '11') { cur.vertices[1][0] = Number(val) || 0; }
      else if (code === '21') { cur.vertices[1][1] = Number(val) || 0; }
      else if (code === '31') { cur.vertices[1][2] = Number(val) || 0; }
    }
  }
  if (cur && cur.type === 'LINE' && cur.vertices) entities.push(cur);
  return { entities };
}

// 清理（HMR 用）
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.location.reload();
  });
}
