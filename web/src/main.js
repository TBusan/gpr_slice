// main.js —— 装配入口：metadata → 样式 → 3D 体渲染 → 切片/GPS 视图 → 状态 HUD
import { loadMetadata } from './dataset/metadata.js';
import { Style } from './render/style.js';
import { VolumeScene } from './render/volumeScene.js';
import { createStylePanel } from './render/stylePanel.js';
import { SliceView } from './render/sliceView.js';
import { GpsMapView } from './render/gpsMapView.js';
import { ViewCube } from './render/viewCube.js';

const statusEl = document.getElementById('status');
const hudEl = document.getElementById('hud');
const viewportEl = document.getElementById('viewport');

(async function boot() {
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
  scene.onTileLoaded = (key) => { /* 瓦片级进度回调可扩展 */ };

  createStylePanel(document.getElementById('stylePanel'), style, meta);

  // 切片 + GPS + 方向指示器视图（每帧与场景同步）
  const sliceView = new SliceView(scene, style, meta);
  const gpsMapView = new GpsMapView(document.getElementById('mapPanel'), scene, meta);
  const viewCube = new ViewCube(document.getElementById('viewCube'), scene);
  (function frame() {
    requestAnimationFrame(frame);
    try {
      sliceView.update();
      gpsMapView.update();
      viewCube.update();
    } catch (err) {
      // 任一视图渲染抛错不打断 rAF 主循环；控制台可定位
      console.error('[frame]', err);
    }
  })();

  setStatus(`已加载 ${meta.dataset.name} · ${meta.volume.dimensions.join('×')} vox`);
  window.__scene = scene; // 调试钩子：控制台直接操作场景
  window.__slice = sliceView;
  window.__gps = gpsMapView;
  window.__viewCube = viewCube;
  scene.start();
})();

function setStatus(text) {
  statusEl.textContent = text;
}

function updateHud(s) {
  hudEl.innerHTML =
    `视口瓦片 ${s.meshes} · 已加载 ${s.loaded} · 排队 ${s.queue} · 传输中 ${s.inFlight} · 缓存 ${s.cache}<br>` +
    `LOD 目标 ${s.desired} · ${s.fps} fps` +
    (s.linear ? '' : ' · <span style="color:#ff8">浮点线性不可用，退化为最近邻</span>');
}

// 清理（HMR 用）
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.location.reload();
  });
}
