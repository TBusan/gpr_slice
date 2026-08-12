// render/brickRenderer.js —— 单个瓦片 -> Data3DTexture + Box + ray-marching ShaderMaterial
//
// 正确性关键：
// 1. Box 几何 = 瓦片【核心区】AABB，shader 只对核心区做 ray 积分；
//    ghost 边界只用于三线性插值采样（防接缝双重累积，规格书 §20）。
// 2. shader 输出预乘颜色 + 累积 alpha，混合用 One/OneMinusSrcAlpha
//    （front-to-back 背向排序合成，见 volumeScene 排序）。

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

varying vec3 vWorldPos;

uniform sampler3D uVolume;
uniform vec3  uStoreSize;   // 存储尺寸（含 ghost）
uniform vec3  uCoreSize;    // 核心尺寸
uniform float uGhost;
uniform vec3  uBoxMin;      // 核心区世界最小角
uniform vec3  uBoxSize;     // 核心区世界尺寸
uniform sampler2D uColorMap;
uniform float uMinValue;
uniform float uMaxValue;
uniform float uGain;
uniform float uGamma;
uniform float uThresholdMin;
uniform float uThresholdMax;
uniform float uOpacity;
uniform float uSteps;

// 单位立方体 [0,1]^3 的 slab 求交（中心 0.5、半边长 0.5）
vec2 rayBox(vec3 ro, vec3 rd) {
  vec3 ro2 = ro - 0.5;
  vec3 m = 1.0 / rd;
  vec3 n = m * ro2;
  vec3 k = abs(m) * 0.5;
  vec3 t1 = -n - k;
  vec3 t2 = -n + k;
  float tn = max(max(t1.x, t1.y), t1.z);
  float tf = min(min(t2.x, t2.y), t2.z);
  return vec2(tn, tf);
}

void main() {
  vec3 ro = (cameraPosition - uBoxMin) / uBoxSize;   // 相机在局部坐标
  vec3 rd = (vWorldPos - uBoxMin) / uBoxSize - ro;   // 指向片元的局部方向

  vec2 tb = rayBox(ro, rd);
  float tNear = max(tb.x, 0.0);
  float tFar = tb.y;
  if (tFar <= tNear) { gl_FragColor = vec4(0.0); return; }

  int steps = int(uSteps);
  float denom = float(max(steps - 1, 1));
  vec3 accC = vec3(0.0);   // 预乘颜色
  float accA = 0.0;

  for (int i = 0; i < 512; i++) {
    if (i >= steps) break;
    float t = mix(tNear, tFar, float(i) / denom);
    vec3 lp = ro + rd * t;                              // 核心区局部 0..1
    vec3 tc = (lp * uCoreSize + uGhost) / uStoreSize;   // -> 存储区纹理坐标
    float val = texture(uVolume, tc).r;

    if (val < uThresholdMin || val > uThresholdMax) continue;
    val *= uGain;
    float n = clamp((val - uMinValue) / max(uMaxValue - uMinValue, 1e-6), 0.0, 1.0);
    n = pow(n, uGamma);
    vec4 cm = texture(uColorMap, vec2(n, 0.5));
    float a = cm.a * uOpacity;
    float contrib = a * (1.0 - accA);                    // front-to-back
    accC += cm.rgb * contrib;                            // 预乘
    accA += contrib;
    if (accA >= 0.99) break;
  }
  gl_FragColor = vec4(accC, accA);
}
`;

function stepsFor(coreSize) {
  const m = Math.max(coreSize[0], coreSize[1], coreSize[2]);
  return Math.max(64, Math.min(320, m));
}

// 创建瓦片 mesh。opts.linear 控制浮点纹理线性过滤；opts.geometry 共享单位立方体。
// style 提供初始 uniform 值（每帧由 volumeScene.syncStyle 同步）。
export function createBrickMesh(tile, meta, style, opts = {}) {
  const { header, f32 } = tile;
  const g = meta.ghost;
  const coreSize = [header.width - 2 * g, header.height - 2 * g, header.depth - 2 * g];
  const storeSize = [header.width, header.height, header.depth];

  const texture = new THREE.Data3DTexture(f32, storeSize[0], storeSize[1], storeSize[2]);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  const filter = opts.linear ? THREE.LinearFilter : THREE.NearestFilter;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;

  const li = meta.levelInfo(header.level);
  const [sx, sy, sz] = li.spacing;
  const [ox, oy, oz] = meta.origin;
  const wmin = new THREE.Vector3(
    ox + header.x * meta.tileW * sx,
    oy + header.y * meta.tileH * sy,
    oz + header.z * meta.tileD * sz
  );
  const size = new THREE.Vector3(coreSize[0] * sx, coreSize[1] * sy, coreSize[2] * sz);

  const geo = opts.geometry || new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uVolume: { value: texture },
      uStoreSize: { value: new THREE.Vector3(...storeSize) },
      uCoreSize: { value: new THREE.Vector3(...coreSize) },
      uGhost: { value: g },
      uBoxMin: { value: wmin.clone() },
      uBoxSize: { value: size.clone() },
      uColorMap: { value: style.colorMap },
      uMinValue: { value: style.minValue },
      uMaxValue: { value: style.maxValue },
      uGain: { value: style.gain },
      uGamma: { value: style.gamma },
      uThresholdMin: { value: style.thresholdMin },
      uThresholdMax: { value: style.thresholdMax },
      uOpacity: { value: style.opacity },
      uSteps: { value: opts.steps != null ? opts.steps : stepsFor(coreSize) },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(wmin);
  mesh.scale.copy(size);
  mesh.userData = {
    key: `${header.level}/${header.x}/${header.y}/${header.z}`,
    center: wmin.clone().addScaledVector(size, 0.5),
    header,
  };

  return { mesh, texture };
}
