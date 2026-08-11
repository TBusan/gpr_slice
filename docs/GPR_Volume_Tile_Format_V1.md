# GPR Volume Tile Format V1

> 面向 Web 端大规模三维探地雷达（GPR）数据的多分辨率 Volume Tile 数据格式设计。
>
> 版本：V1.0

---

## 1. 设计目标

GPR Volume Tile Format V1 主要解决：

1. 超大规模三维 GPR Volume 的存储。
2. 多级 LOD。
3. 按 Tile 流式加载、卸载和缓存。
4. Tile 保存原始振幅值，而不是颜色。
5. 前端动态调整 ColorMap、Gain、Threshold、Opacity 等样式。
6. 同一套 Volume 支持 A-Scan、B-Scan、C-Scan 和 3D Volume Rendering。
7. 可映射到 Three.js `Data3DTexture`。
8. 支持时间轴/深度轴、空间坐标系以及 XYZ 非等比例采样。

核心思想：

```text
GPR Volume
    ↓
Multiscale LOD
    ↓
3D Volume Tiles
    ↓
INT16 / FLOAT32 原始值
    ↓
HTTP Streaming
    ↓
Three.js / WebGPU
    ↓
Volume Rendering + Dynamic Style
```

---

# 2. 总体架构

V1 采用：

> **多尺度规则体数据 + 固定大小 3D Tile + 原始数值 + Statistics + Ghost Border + 压缩 + 独立 Style**

```text
GPR Dataset
│
├── metadata.json
│
├── LOD 0
│   ├── Tile
│   ├── Tile
│   └── ...
│
├── LOD 1
│   ├── Tile
│   └── ...
│
├── LOD 2
│   └── ...
│
└── LOD N
```

数据、LOD、渲染样式严格分离：

```text
Raw GPR Volume
       │
       ├── Multiscale / LOD
       │       └── Volume Tiles
       │
       └── Runtime Style
               ├── ColorMap
               ├── Gain
               ├── Threshold
               ├── Contrast
               └── Opacity
```

---

# 3. 核心数据模型

```text
Dataset
   │
   ├── Level / LOD
   │
   ├── Tile
   │
   └── Voxel
```

### Dataset

整个 GPR 数据集。

### Level / LOD

一种空间采样分辨率。

### Tile

可独立加载、卸载和缓存的 3D Volume Block。

### Voxel

一个体素振幅值。

---

# 4. 为什么采用 3D Volume Tile

GPR 三维数据本质上是：

```text
X × Y × Z
```

通常：

```text
X = 测线方向
Y = 测线间距 / 横向空间
Z = 时间或深度
```

二维地图栅格瓦片只有：

```text
X × Y
```

无法完整表达 Volume。

因此 V1 使用：

```text
3D Tile = X × Y × Z
```

同一套数据即可支持：

```text
A-Scan
B-Scan
C-Scan
3D Volume
```

---

# 5. Tile Size

推荐 V1 默认：

```text
128 × 128 × 32 voxels
```

Metadata：

```json
{
  "tile": {
    "size": [128, 128, 32]
  }
}
```

GPR 三个方向的采样密度通常不同，因此不建议直接套用普通 Volume Rendering 的 `64³`。

V1 实现时建议通过真实数据测试：

```text
64 × 64 × 32
128 × 128 × 32
128 × 128 × 64
```

最终根据：

- Tile 文件大小
- HTTP 请求数量
- GPU Texture 数量
- GPU Cache 命中率
- Ray Marching 性能

确定默认参数。

---

# 6. Volume Dimensions

`dimensions` 表示 voxel 数量，不是物理尺寸。

例如：

```json
{
  "dimensions": [20480, 10240, 512]
}
```

表示：

```text
X = 20480 voxels
Y = 10240 voxels
Z = 512 voxels
```

实际空间尺寸由：

```text
dimensions × spacing
```

确定。

---

# 7. Spatial Metadata

建议：

```json
{
  "spatial": {
    "origin": [500000.0, 3200000.0, 0.0],
    "spacing": [0.05, 0.05, 0.02],
    "coordinateSystem": {
      "type": "EPSG",
      "code": 4547
    }
  }
}
```

字段含义：

- `origin`：整个 Volume 的世界坐标原点。
- `spacing`：LOD0 的 voxel spacing。
- `coordinateSystem`：空间参考系。

对于 CGCS2000 等投影坐标，应结合 Web Renderer 的 Local Origin / RTC 方案避免大坐标带来的 GPU 精度问题。

---

# 8. 坐标轴设计

V1 不应假设 Z 永远是深度。

GPR 原始数据通常首先是：

```text
Time
```

经过介质速度等处理后才可能转换成：

```text
Depth
```

因此建议显式定义：

```json
{
  "axis": {
    "x": "distance",
    "y": "distance",
    "z": "time"
  }
}
```

或者：

```json
{
  "axis": {
    "x": "distance",
    "y": "distance",
    "z": "depth"
  }
}
```

## 时间轴

```json
{
  "time": {
    "unit": "ns",
    "sampleInterval": 0.05
  }
}
```

## 深度轴

```json
{
  "depth": {
    "unit": "m"
  }
}
```

---

# 9. LOD 设计

LOD 表示不同的空间采样分辨率。

例如：

```json
{
  "levels": [
    {
      "level": 0,
      "scale": [1, 1, 1],
      "dimensions": [20480, 10240, 512],
      "spacing": [0.05, 0.05, 0.02]
    },
    {
      "level": 1,
      "scale": [2, 2, 2],
      "dimensions": [10240, 5120, 256],
      "spacing": [0.10, 0.10, 0.04]
    },
    {
      "level": 2,
      "scale": [4, 4, 4],
      "dimensions": [5120, 2560, 128],
      "spacing": [0.20, 0.20, 0.08]
    }
  ]
}
```

---

# 10. XYZ 独立 LOD Scale

这是 GPR V1 的重要设计。

不要强制所有轴按照相同比例降采样。

允许：

```json
{
  "scale": [2, 2, 1]
}
```

甚至：

```json
{
  "scale": [2, 2, 4]
}
```

例如：

```text
LOD0
1 × 1 × 1

LOD1
2 × 2 × 1

LOD2
4 × 4 × 2

LOD3
8 × 8 × 4
```

原因是：

```text
X/Y = 平面空间分辨率
Z   = 时间/深度分辨率
```

三者物理意义不同。

因此格式本身不应硬编码成标准八叉树。

---

# 11. LOD Downsampling

LOD 可以通过低分辨率重采样生成：

```text
LOD0
  ↓
Downsample
  ↓
LOD1
  ↓
Downsample
  ↓
LOD2
```

GPR 不能简单套用普通图片的平均值，因为振幅通常存在正负值。

例如：

```text
+100
-100
+100
-100
```

简单平均会得到：

```text
0
```

可能导致强反射在低 LOD 中消失。

可考虑：

### Average

```text
newValue = mean(values)
```

优点：平滑。

缺点：正负振幅可能抵消。

### Max Abs

```text
newValue = value with maximum abs(value)
```

可以保留强反射。

### Min / Max

同时保留：

```text
minAmplitude
maxAmplitude
```

更适合后续做空域跳过和高级 LOD。

V1 至少应保存 Tile 级 Min/Max。

---

# 12. Tile Index

Tile 使用：

```text
level / x / y / z
```

定位。

例如：

```text
0/0/0/0
0/1/0/0
0/0/1/0
1/0/0/0
```

推荐路径：

```text
tiles/{level}/{x}/{y}/{z}.gvt
```

---

# 13. `.gvt` Tile 文件

V1 使用：

```text
.gvt
```

作为 GPR Volume Tile 文件扩展名。

结构：

```text
┌─────────────────────────────┐
│ Header                      │
├─────────────────────────────┤
│ Statistics                  │
├─────────────────────────────┤
│ Optional metadata           │
├─────────────────────────────┤
│ Compressed voxel data       │
└─────────────────────────────┘
```

---

# 14. Tile Header

建议固定 Header：

```text
Offset  Field
------  ----------------
0x00    Magic
0x04    Version
0x06    Flags

0x08    Level
0x0A    Reserved

0x0C    X
0x10    Y
0x14    Z

0x18    Width
0x1A    Height
0x1C    Depth

0x1E    DataType
0x1F    Compression

0x20    DataOffset
0x24    DataLength
```

---

# 15. Magic

建议：

```text
GPRV
```

对应：

```text
0x47505256
```

用于快速判断文件类型。

---

# 16. Tile Data Type

V1 支持：

```text
INT8
UINT8
INT16
UINT16
INT32
FLOAT32
```

重点支持：

```text
INT16
FLOAT32
```

原因：

- GPR 数据常可用 INT16 表示。
- 科学计算或处理后的数据可能需要 FLOAT32。

---

# 17. Scale / Offset

为了减少数据量，可以采用：

```text
physicalValue =
    storedValue × scale + offset
```

例如：

```json
{
  "value": {
    "type": "int16",
    "scale": 0.01,
    "offset": 0
  }
}
```

存储：

```text
1000
```

实际值：

```text
1000 × 0.01 = 10
```

这样可以在适当情况下将 FLOAT32 数据量化为 INT16。

---

# 18. Tile Statistics

每个 Tile 至少保存：

```text
min
max
```

建议：

```text
min
max
mean
```

例如：

```json
{
  "statistics": {
    "min": -32768,
    "max": 29873,
    "mean": 23.42
  }
}
```

---

# 19. Statistics 的作用

Statistics 不只是用于显示。

## Tile Culling

例如：

```text
threshold = 500
```

某 Tile：

```text
max = 200
```

可以直接跳过。

## Empty-space Skipping

Ray Marching 可以利用：

```text
min / max
```

判断 Brick 是否可能包含目标信号。

## LOD 优化

可以结合：

```text
Screen Space Error
+
Tile Statistics
```

优化请求。

---

# 20. Ghost Border

V1 建议：

```json
{
  "ghost": 1
}
```

实际 Tile：

```text
128 × 128 × 32
```

存储：

```text
130 × 130 × 34
```

外围额外 voxel 主要用于：

- 三线性插值
- Tile 边界采样
- Ray Marching
- 减少 Tile 接缝

示意：

```text
┌──────────────────────┐
│ G G G G G G G G      │
│ G ┌────────────────┐G│
│ G │                │G│
│ G │ 128×128×32     │G│
│ G │                │G│
│ G └────────────────┘G│
│ G G G G G G G G      │
└──────────────────────┘
```

---

# 21. 压缩

V1 支持：

```text
NONE
GZIP
ZSTD
```

推荐：

```text
ZSTD
```

原因：

- GPR 数据通常具有较好的压缩潜力。
- 解压速度较快。
- 压缩率通常优于 GZIP。
- 适合服务端生成和 Web 流式加载。

GPU 专用压缩格式不纳入 V1。

---

# 22. Dynamic Style

**Style 不应存储在 Tile 中。**

Tile 只保存：

```text
Amplitude
```

不保存：

```text
Color
Opacity
Threshold
Gain
Contrast
Gamma
```

前端可以动态设置：

```javascript
const style = {
    colorMap: 'blue-red',
    minValue: -1000,
    maxValue: 1000,
    thresholdMin: 100,
    thresholdMax: 800,
    gain: 1.5,
    gamma: 1.0,
    opacity: 0.8,
    depthRange: [0, 5]
};
```

这样修改显示样式不需要重新生成或下载 Tile。

---

# 23. 推荐渲染流程

```text
GPR Tile
   │
   ↓
HTTP
   │
   ↓
ArrayBuffer
   │
   ↓
Decode
   │
   ↓
Decompress
   │
   ↓
TypedArray
   │
   ↓
THREE.Data3DTexture
   │
   ↓
Volume Ray Marching
   │
   ↓
Dynamic Style
   │
   ├── Gain
   ├── Threshold
   ├── Contrast
   ├── ColorMap
   └── Opacity
   │
   ↓
Render
```

---

# 24. A-Scan / B-Scan / C-Scan

V1 不为 B-Scan、C-Scan 创建第二套数据。

全部从同一个 Volume Tile 中读取。

## A-Scan

固定：

```text
X
Y
```

读取：

```text
Z
```

## B-Scan

固定：

```text
Y
```

读取：

```text
X × Z
```

## C-Scan

固定：

```text
Z
```

读取：

```text
X × Y
```

## 3D Volume

直接使用：

```text
X × Y × Z
```

---

# 25. Tile 对 Slice 的支持

例如 C-Scan：

```text
Z = 200
```

只需要加载覆盖：

```text
Z = 200
```

的 Tile。

B-Scan：

```text
Y = 100
```

只需要加载覆盖：

```text
Y = 100
```

所在空间范围的 Tile。

因此 Tile Index 天然支持 Slice Streaming。

---

# 26. LOD Parent / Child

如果：

```text
scale = [2, 2, 2]
```

一个 Parent 对应理论上的：

```text
8 Children
```

```text
Parent
   │
   ├── 000
   ├── 001
   ├── 010
   ├── 011
   ├── 100
   ├── 101
   ├── 110
   └── 111
```

如果：

```text
scale = [2, 2, 1]
```

则主要对应：

```text
4 Children
```

因此 Parent/Child 关系应根据：

```text
scale[x]
scale[y]
scale[z]
```

动态计算，而不是把格式硬编码为八叉树。

---

# 27. LOD Selection

前端 LOD Manager：

```text
Camera
   ↓
Screen Space Error
   ↓
LOD Selection
   ↓
Visible Tile Detection
   ↓
Tile Request
   ↓
GPU Cache
   ↓
Render
```

例如：

```text
Camera Far
    ↓
LOD3

Camera Medium
    ↓
LOD2

Camera Close
    ↓
LOD1

Camera Very Close
    ↓
LOD0
```

实际实现应允许多个 LOD 同时存在：

```text
LOD2 + LOD1 + LOD0
```

从而实现平滑渐进加载。

---

# 28. Metadata.json 完整示例

```json
{
  "format": "GPR-Volume-Tile",
  "version": "1.0",

  "dataset": {
    "id": "survey-001",
    "name": "GPR Survey"
  },

  "volume": {
    "dimensions": [20480, 10240, 512],
    "voxelType": "int16",
    "axisOrder": ["x", "y", "z"]
  },

  "spatial": {
    "origin": [500000.0, 3200000.0, 0.0],

    "coordinateSystem": {
      "type": "EPSG",
      "code": 4547
    },

    "axis": {
      "x": {
        "type": "distance",
        "unit": "m"
      },
      "y": {
        "type": "distance",
        "unit": "m"
      },
      "z": {
        "type": "depth",
        "unit": "m"
      }
    }
  },

  "tile": {
    "size": [128, 128, 32],
    "ghost": 1
  },

  "value": {
    "type": "int16",
    "scale": 0.01,
    "offset": 0,
    "globalMin": -327.68,
    "globalMax": 327.67
  },

  "levels": [
    {
      "level": 0,
      "scale": [1, 1, 1],
      "dimensions": [20480, 10240, 512],
      "spacing": [0.05, 0.05, 0.02]
    },
    {
      "level": 1,
      "scale": [2, 2, 2],
      "dimensions": [10240, 5120, 256],
      "spacing": [0.10, 0.10, 0.04]
    },
    {
      "level": 2,
      "scale": [4, 4, 4],
      "dimensions": [5120, 2560, 128],
      "spacing": [0.20, 0.20, 0.08]
    },
    {
      "level": 3,
      "scale": [8, 8, 8],
      "dimensions": [2560, 1280, 64],
      "spacing": [0.40, 0.40, 0.16]
    }
  ],

  "storage": {
    "tilePath": "tiles/{level}/{x}/{y}/{z}.gvt",
    "compression": "zstd"
  }
}
```

---

# 29. `.gvt` 文件结构

```text
┌─────────────────────────────┐
│ Fixed Header                │
├─────────────────────────────┤
│ Statistics                  │
│   min                       │
│   max                       │
│   mean                      │
├─────────────────────────────┤
│ Compressed Voxel Data       │
└─────────────────────────────┘
```

Header：

```text
0x00   magic       4
0x04   version     2
0x06   flags       2

0x08   level       2
0x0A   reserved    2

0x0C   x           4
0x10   y           4
0x14   z           4

0x18   width       2
0x1A   height      2
0x1C   depth       2

0x1E   dataType    1
0x1F   compression 1

0x20   dataOffset  4
0x24   dataLength  4
```

---

# 30. 推荐数据目录

```text
dataset/
│
├── metadata.json
│
└── tiles/
    │
    ├── 0/
    │   ├── 0/
    │   │   ├── 0/
    │   │   │   ├── 0.gvt
    │   │   │   ├── 1.gvt
    │   │   │   └── ...
    │   │   └── ...
    │   └── ...
    │
    ├── 1/
    │   └── ...
    │
    ├── 2/
    │   └── ...
    │
    └── 3/
        └── ...
```

---

# 31. Web Streaming

浏览器首先：

```http
GET /dataset/metadata.json
```

然后根据：

```text
Camera
+
LOD
+
Visible Bounds
+
Slice
```

计算需要的 Tile。

例如：

```http
GET /dataset/tiles/2/15/8/3.gvt
GET /dataset/tiles/2/16/8/3.gvt
GET /dataset/tiles/2/15/9/3.gvt
```

服务器不需要实时执行 GPR 计算。

---

# 32. GPU 数据模型

Tile 解压后得到：

```text
TypedArray
```

再映射到：

```javascript
THREE.Data3DTexture
```

例如概念上的：

```javascript
const texture = new THREE.Data3DTexture(
    data,
    width,
    height,
    depth
);

texture.needsUpdate = true;
```

实际实现需要根据：

```text
voxelType
```

选择对应的：

```text
Texture Format
Texture Type
Internal Format
```

并考虑 WebGL2/WebGPU 对 3D 整数纹理和浮点纹理的支持。

---

# 33. Shader 数据处理

Shader 不应该关心：

```text
LOD
Tile 文件格式
ZSTD
HTTP
```

Shader 只负责：

```text
Raw Value
    ↓
Scale / Offset
    ↓
Gain
    ↓
Normalize
    ↓
Threshold
    ↓
ColorMap
    ↓
Opacity
    ↓
Ray Accumulation
```

推荐参数：

```javascript
uniform float uValueScale;
uniform float uValueOffset;

uniform float uGain;

uniform float uMinValue;
uniform float uMaxValue;

uniform float uThresholdMin;
uniform float uThresholdMax;

uniform float uOpacity;
uniform float uGamma;
```

---

# 34. Raw GPR → Volume Tile Pipeline

完整数据生产流程：

```text
Raw GPR
   │
   ↓
Decode
   │
   ↓
Trace / Channel
   │
   ↓
Geometry / Position
   │
   ↓
Regular Volume
   │
   ↓
LOD Generation
   │
   ↓
Tile Generation
   │
   ├── Ghost
   ├── Min/Max
   ├── Scale/Offset
   └── Compression
   │
   ↓
.gvt
```

---

# 35. 原始 GPR 与规则 Volume 的边界

原始 GPR 通常不是天然的规则：

```text
X × Y × Z
```

而可能是：

```text
Survey Line 1
  ├── Trace 1
  ├── Trace 2
  └── ...

Survey Line 2
  ├── Trace 1
  ├── Trace 2
  └── ...
```

因此在进入 Tile Pipeline 前，需要解决：

```text
Raw Trace
    ↓
空间定位
    ↓
重采样 / 插值
    ↓
Regular X × Y × Z Volume
    ↓
LOD
    ↓
Tile
```

如果不同测线间距不规则，不能直接把数组索引当作规则 Y 坐标。

---

# 36. V1 不直接承载原始厂商格式

V1 的职责是：

> 定义已经进入规则 Volume 后的数据存储、LOD、分块和 Web 流式渲染格式。

不建议把：

```text
SEG-Y
DZT
DT1
RD3
其他厂商格式
```

直接塞进 `.gvt`。

推荐：

```text
SEG-Y / DZT / DT1 / RD3 / ...
              ↓
        GPR Preprocessor
              ↓
        Regular Volume
              ↓
        GPR Volume Tile
```

这样原始采集格式与 Web 渲染格式解耦。

---

# 37. 数据格式职责边界

```text
Raw Format
    ↓
负责：
设备数据 / Trace / Channel

GPR Volume Tile
    ↓
负责：
规则 Volume / LOD / Tile / Streaming

Renderer
    ↓
负责：
Camera / LOD Selection / GPU / Ray Marching

Style
    ↓
负责：
Color / Gain / Threshold / Opacity
```

---

# 38. V1 暂不包含

为了保持 V1 简洁可靠，暂不纳入：

```text
GPU compressed texture
自定义 GPU codec
完整八叉树数据库
数据库后端
Server-side rendering
颜色数据
多属性 Volume
实时重采样
实时 LOD 生成
```

这些可以放到 V2/V3。

---

# 39. 推荐技术栈

## 数据预处理

```text
Python
NumPy
SciPy
Zstandard
GDAL / PyProj（需要空间坐标时）
```

## Web Renderer

```text
Three.js
WebGL2
Data3DTexture
GLSL
```

未来：

```text
WebGPU
```

## HTTP

```text
HTTP/2
HTTP/3
CDN
Range Request（后续可选）
```

---

# 40. V1 完整架构

```text
                         GPR Raw Data
                              │
                              ↓
                    ┌──────────────────┐
                    │ GPR Preprocessor │
                    └────────┬─────────┘
                             │
                       Regular Volume
                             │
                             ↓
                    ┌──────────────────┐
                    │ LOD Generator    │
                    └────────┬─────────┘
                             │
                ┌────────────┼────────────┐
                ↓            ↓            ↓
              LOD0         LOD1         LOD2
                │            │            │
                ↓            ↓            ↓
              Tiles        Tiles        Tiles
                │            │            │
                └────────────┼────────────┘
                             ↓
                          .gvt
                             │
                             ↓
                           HTTP
                             │
                             ↓
                     ┌───────────────┐
                     │ GPR Tile      │
                     │ Loader        │
                     └───────┬───────┘
                             │
                    ┌────────┴────────┐
                    ↓                 ↓
                LOD Manager        Tile Cache
                    │                 │
                    └────────┬────────┘
                             ↓
                       Data3DTexture
                             │
                             ↓
                       Volume Shader
                             │
                    ┌────────┴────────┐
                    ↓                 ↓
                  Style            Slice
                    │                 │
                    ↓                 ↓
                3D Volume       A/B/C Scan
```

---

# 41. V1 核心原则

### 原则 1：数据和样式分离

```text
Tile = Raw Value
Style = Runtime
```

### 原则 2：LOD 和 Tile 分离

```text
LOD = Resolution
Tile = Spatial Block
```

### 原则 3：不强制八叉树

使用：

```text
scale = [x, y, z]
```

描述各方向 LOD。

### 原则 4：Tile 固定尺寸

推荐：

```text
128 × 128 × 32
```

### 原则 5：Tile 保存 Statistics

至少：

```text
min
max
```

### 原则 6：支持 Ghost Border

默认：

```text
ghost = 1
```

### 原则 7：优先保存原始数值

保存：

```text
INT16 / FLOAT32
```

而不是：

```text
RGBA
```

### 原则 8：B/C Scan 不建立第二套数据

全部从 Volume 中切片。

### 原则 9：Raw GPR 和 Volume Tile 解耦

```text
SEG-Y / DZT / DT1
        ↓
Preprocessor
        ↓
GPR Volume
        ↓
GVT
```

### 原则 10：V1 优先简单可靠

先实现：

```text
Volume
+
LOD
+
Tile
+
HTTP
+
GPU
+
Shader
```

再做高级优化。

---

# 42. V1 后续演进

## V1.1

```text
Tile Index
HTTP Range
更完善的 Statistics
Tile Availability
```

## V2

```text
GPU Residency
LRU Cache
Empty-space Skipping
Brick Pool
Sparse Volume
```

## V3

```text
WebGPU
GPU Compression
Virtual Texture
Advanced Streaming
Out-of-core Volume Rendering
```

---

# 43. V1 最关键的三个待定事项

## 43.1 Tile Size

通过真实数据测试：

```text
64 × 64 × 32
128 × 128 × 32
128 × 128 × 64
```

重点考察：

- 单 Tile 文件大小
- HTTP 请求数量
- GPU Texture 数量
- GPU Cache 命中率
- Ray Marching 性能

## 43.2 LOD Scale

需要根据真实 GPR 数据确定：

```text
[2, 2, 2]
```

还是：

```text
[2, 2, 1]
[4, 4, 2]
[8, 8, 4]
```

依据：

```text
Trace spacing
Sample interval
Depth resolution
```

## 43.3 Raw GPR → Regular Volume

这是最重要的问题：

```text
原始 GPR Trace
       ↓
空间定位
       ↓
是否插值？
       ↓
Regular X × Y × Z Volume
       ↓
LOD
       ↓
Tile
```

这一层决定整个 GPR Tile Pyramid 如何生成。

---

# 44. 最终定义

GPR Volume Tile V1 可以定义为：

> 一种面向大规模 GPR 三维标量场的、多分辨率、空间分块、按需流式加载和 GPU Volume Rendering 的专用数据格式。

核心模型：

```text
                 GPR Volume
                     │
              Multiscale LOD
                     │
             ┌───────┼───────┐
             ↓       ↓       ↓
           LOD0    LOD1    LOD2
             │       │       │
             ↓       ↓       ↓
           3D Tile 3D Tile 3D Tile
             │       │       │
             ↓       ↓       ↓
          INT16 / FLOAT32
             │
          Min / Max
             │
           Ghost
             │
           ZSTD
             │
             ↓
            .gvt
             │
             ↓
           HTTP
             │
             ↓
        Three.js/WebGPU
             │
             ↓
        Data3DTexture
             │
             ↓
       Volume Ray Marching
             │
             ↓
       Dynamic GPR Style
```

---

# 45. 一句话总结

**GPR Volume Tile V1 =**

```text
多尺度规则 Volume
+
固定尺寸 3D Tile
+
XYZ 独立 LOD Scale
+
INT16 / FLOAT32 原始值
+
Tile Min/Max
+
Ghost Border
+
ZSTD
+
HTTP Streaming
+
Three.js Data3DTexture
+
Runtime Dynamic Style
```

这套格式可以作为后续：

```text
GPR Tile Generator
GPR Tile Loader
LOD Manager
GPU Brick Cache
Volume Ray Marcher
B/C Scan Renderer
```

的共同数据基础。
