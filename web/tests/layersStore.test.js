import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveLayerStore, loadLayerStore, clearLayerStore } from '../src/io/layerStore.js';

// 内存 localStorage 桩
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => Array.from(mem.keys())[i] || null,
  get length() { return mem.size; },
};

describe('layerStore', () => {
  beforeEach(() => { mem.clear(); });
  afterEach(() => { mem.clear(); });

  it('空存储 → load 返回 null', () => {
    expect(loadLayerStore('nokey')).toBeNull();
  });

  it('保存/读取 builtin layer 可见性 + 相机', () => {
    saveLayerStore('demo', {
      builtinVisibility: { gizmos: true, scan: false },
      camera: { x: 10, y: 20, z: 30 },
      style: { colorMapName: 'viridis', opacity: 0.8 },
    });
    const got = loadLayerStore('demo');
    expect(got.builtinVisibility).toEqual({ gizmos: true, scan: false });
    expect(got.camera).toEqual({ x: 10, y: 20, z: 30 });
    expect(got.style.colorMapName).toBe('viridis');
  });

  it('数据源隔离：srcA 的保存不影响 srcB', () => {
    saveLayerStore('A', { builtinVisibility: { gizmos: false } });
    saveLayerStore('B', { builtinVisibility: { gizmos: true } });
    expect(loadLayerStore('A').builtinVisibility.gizmos).toBe(false);
    expect(loadLayerStore('B').builtinVisibility.gizmos).toBe(true);
  });

  it('损坏 JSON → 返回 null 不抛', () => {
    localStorage.setItem('gpr_slice_layerStore_xx', '{not json');
    expect(loadLayerStore('xx')).toBeNull();
  });
});
