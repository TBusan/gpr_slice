// lod/tileCache.js —— LRU 缓存，淘汰时回调 dispose

export class TileCache {
  constructor(limit = 256) {
    this.limit = limit;
    this.map = new Map(); // key -> entry (插入序即 LRU 序，get 会刷新)
    this.evicted = [];
    this.listeners = new Set();
  }

  onEvict(fn) {
    this.listeners.add(fn);
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e); // 刷新为最近使用
    }
    return e || null;
  }

  set(key, entry) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    this.trim();
  }

  delete(key) {
    this.map.delete(key);
  }

  trim() {
    while (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      const entry = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      for (const fn of this.listeners) fn(entry);
    }
  }

  size() {
    return this.map.size;
  }
}
