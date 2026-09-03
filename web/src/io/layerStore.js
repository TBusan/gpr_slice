// io/layerStore.js —— 跨会话恢复 builtin layer 可见性 / 相机 / 样式（按数据源隔离）
// localStorage key 形如 gpr_slice_layerStore_<srcId>

const PREFIX = 'gpr_slice_layerStore_';

export function saveLayerStore(srcId, data) {
  try {
    localStorage.setItem(PREFIX + srcId, JSON.stringify(data));
  } catch (e) { console.warn('saveLayerStore failed', e); }
}

export function loadLayerStore(srcId) {
  try {
    const raw = localStorage.getItem(PREFIX + srcId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

export function clearLayerStore(srcId) {
  try { localStorage.removeItem(PREFIX + (srcId || '')); } catch (e) { /* ignore */ }
}
