import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerManager } from '../src/layers/layerManager.js';

describe('LayerManager', () => {
  it('添加/列表/可见性', () => {
    const lm = new LayerManager();
    const scene = new THREE.Scene();
    lm.attach(scene);
    const g = new THREE.Group();
    lm.add({ id: 'a', label: 'A', object3D: g });
    expect(lm.list()).toHaveLength(1);
    expect(g.parent).toBe(lm.root);
    expect(scene.children).toContain(lm.root);
    lm.setVisible('a', false);
    expect(g.visible).toBe(false);
    lm.setVisible('a', true);
    expect(g.visible).toBe(true);
  });
  it('重复 id 替换旧图层', () => {
    const lm = new LayerManager();
    const scene = new THREE.Scene(); lm.attach(scene);
    const g1 = new THREE.Group(), g2 = new THREE.Group();
    lm.add({ id: 'a', label: 'A', object3D: g1 });
    lm.add({ id: 'a', label: 'A2', object3D: g2 });
    expect(lm.list()).toHaveLength(1);
    expect(lm.list()[0].label).toBe('A2');
  });
  it('删除移除并清理 root 子节点', () => {
    const lm = new LayerManager();
    const scene = new THREE.Scene(); lm.attach(scene);
    const g = new THREE.Group();
    lm.add({ id: 'a', label: 'A', object3D: g });
    lm.remove('a');
    expect(lm.list()).toHaveLength(0);
    expect(lm.root.children).toHaveLength(0);
  });
  it('onChange 回调在增删改时触发', () => {
    const lm = new LayerManager();
    let n = 0; lm.onChange(() => n++);
    lm.add({ id: 'a', label: 'A', object3D: new THREE.Group() });
    lm.add({ id: 'b', label: 'B', object3D: new THREE.Group() });
    lm.setVisible('a', false);
    expect(n).toBe(3);
  });
});
