// layers/layerManager.js —— 图层状态机（与数据源解耦：scene 上挂一个 root.Group，存 three 对象引用）
import * as THREE from 'three';

export class LayerManager {
  constructor() {
    this.layers = new Map(); // id -> { id, label, object3D, builtin, visible }
    this.root = new THREE.Group();
    this.root.name = 'layers';
    this._scene = null;
    this._cbs = new Set();
  }
  attach(scene) { this._scene = scene; scene.add(this.root); }
  add({ id, label, object3D, builtin = false, visible = true }) {
    if (this.layers.has(id)) this.remove(id);
    const layer = { id, label, object3D, builtin, visible };
    object3D.visible = visible;
    this.root.add(object3D);
    this.layers.set(id, layer);
    this._emit();
    return layer;
  }
  remove(id) {
    const l = this.layers.get(id);
    if (!l) return;
    if (l.object3D.parent) l.object3D.parent.remove(l.object3D);
    this.layers.delete(id);
    this._emit();
  }
  setVisible(id, v) {
    const l = this.layers.get(id);
    if (!l || l.visible === !!v) return;
    l.visible = !!v; l.object3D.visible = !!v;
    this._emit();
  }
  get(id) { return this.layers.get(id) || null; }
  list() { return [...this.layers.values()]; }
  onChange(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  _emit() { for (const cb of this._cbs) cb(this.list()); }
}
