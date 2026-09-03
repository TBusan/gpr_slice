import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

describe('smoke', () => {
  it('three.js 可在 node 导入', () => {
    expect(new THREE.Vector3(1, 2, 3).length()).toBeCloseTo(Math.sqrt(14));
  });
});
