# Potree WebGPU 点云渲染技术分析报告

## 一、整体架构概览

### 1.1 渲染流程总览

从 `tunnel.html` 入口开始，整个系统的调用链如下：

````
tunnel.html (HTML入口)
  └─ Potree.init(canvas)
       ├─ 初始化 Renderer (WebGPU设备)
       ├─ 创建 Camera + OrbitControls
       ├─ 创建 Scene (场景图)
       └─ 启动渲染循环 requestAnimationFrame(loop)
            ├─ update() - 更新相机和控制器
            └─ renderNotSoBasic() - 执行多通道渲染

### 1.2 核心模块分工

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| **入口协调** | `src/init.js` | 初始化系统、主渲染循环 |
| **WebGPU管理** | `src/renderer/Renderer.js` | 设备、缓冲区、纹理、命令编码 |
| **点云核心** | `src/potree/octree/PointCloudOctree.js` | LOD可见性更新、八叉树遍历 |
| **数据加载** | `src/potree/octree/loader/PotreeLoader.js` | HTTP Range请求、元数据解析 |
| **Worker解码** | `src/potree/octree/loader/DecoderWorker_default.js` | 并行解压、坐标变换 |
| **材质系统** | `src/potree/PointCloudMaterial.js` | 属性映射、着色器重编译 |
| **着色器生成** | `src/potree/octree/pipelineGenerator.js` | 动态注入映射函数到WGSL |
| **后处理** | `src/potree/hqs_normalize.js`, `src/potree/EDL.js` | HQS归一化、眼穹顶照明 |

---

## 二、渲染管线详解

### 2.1 主渲染循环 (src/init.js::renderNotSoBasic)

每一帧执行以下步骤：

**阶段1：场景图遍历与分类**
```javascript
// 深度优先遍历场景树，按类型分组
let stack = [scene.root];
while(stack.length > 0) {
    let node = stack.pop();
    // 按 renderLayer 和 constructor.name 分类
    // 结果：renderables = Map<nodeType, [nodes]>
}
````

**阶段2：LOD可见性更新**

```javascript
for (let octree of octrees) {
  octree.updateVisibility(camera, renderer);
  // 视锥体剔除 + 屏幕空间像素大小计算
  // 优先级队列排序 + 点预算限制
  // 触发异步节点加载
}
```

**阶段3：渲染通道序列**

根据配置执行不同的渲染路径：

| 通道            | 条件                      | 目标                        | 作用                  |
| --------------- | ------------------------- | --------------------------- | --------------------- | ------- | -------------- |
| **HQS深度通道** | `hqsEnabled=true`         | `fbo_hqs_depth`             | 记录最近深度值        |
| **HQS累积通道** | `hqsEnabled=true`         | `fbo_hqs_sum` (rgba16float) | 加法混合累积颜色+权重 |
| **HQS归一化**   | `hqsEnabled=true`         | `fbo_0` 或 `screenbuffer`   | 除以权重得到最终颜色  |
| **前向渲染**    | `!hqs && !edl && !dilate` | `screenbuffer`              | 直接渲染到屏幕        |
| **中间渲染**    | `edl                      |                             | dilate`               | `fbo_0` | 渲染到中间缓冲 |
| **其他对象**    | 总是执行                  | 当前目标                    | 渲染Mesh、Lines等     |
| **EDL照明**     | `edlEnabled=true`         | `screenbuffer`              | 边缘增强后处理        |
| **高斯溅射**    | 有GaussianSplats          | 独立RT+合成                 | 3D高斯渲染            |

### 2.2 HQS (High Quality Splatting) 原理

HQS通过三通道实现高质量点渲染：

**通道1：深度通道**

- 目的：记录每个像素的最近深度
- 深度写入：`depthWriteEnabled: true`
- 深度测试：`depthCompare: "greater-equal"`

**通道2：累积通道**

- 目的：累加所有点的加权颜色
- 混合模式：`srcFactor: "one", dstFactor: "one"` (加法混合)
- 格式：`rgba16float` (支持大于1的值)
- 深度：复用通道1的深度，`depthLoadOp: "load"`

**通道3：归一化通道** (`hqs_normalize.js`)

- 读取累积纹理和深度
- 对每个像素：在窗口内找最近深度点
- 高斯加权平均：`color = sum(color * weight) / sum(weight)`
- 输出最终颜色 + 深度

---

## 三、LOD系统核心算法

### 3.1 八叉树可见性更新 (PointCloudOctree.js::updateVisibility)

**数据结构**

```javascript
// 优先级队列：按屏幕空间重要性排序
let priorityQueue = new BinaryHeap((x) => 1 / x.weight);
```

**算法流程**

1. **初始化**：将根节点推入优先级队列
2. **循环处理**：

   ```javascript
   while (priorityQueue.size() > 0) {
     let { node, weight } = priorityQueue.pop();

     // 未加载？加入加载队列（最多40个）
     if (!node.loaded) {
       loadQueue.push(node);
       continue;
     }

     // 视锥体剔除
     let insideFrustum = frustum.intersectsSphere(nodeSphere);
     if (!insideFrustum && node.level > 2) continue;

     // 标记可见
     visibleNodes.push(node);

     // 计算子节点权重并入队
     for (let child of node.children) {
       let pixelSize = calculateScreenSpaceSize(child);
       if (pixelSize < minNodeSize) continue;

       priorityQueue.push({ node: child, weight: pixelSize });
     }
   }
   ```

3. **权重计算公式**

   ```javascript
   // 屏幕空间像素大小
   let distance = camera.position.distanceTo(node.center);
   let fov = toRadians(camera.fov);
   let slope = Math.tan(fov / 2);
   let projFactor = 1 / (slope * distance);
   let pixelSize = nodeRadius * projFactor * framebufferHeight;

   // 中心权重加成：屏幕中心的节点优先级更高
   let screenU = projectToNDC(node.center).x; // [-1, 1]
   let screenV = projectToNDC(node.center).y;
   let distanceToCenter = sqrt(screenU² + screenV²);
   let centerWeight = clamp(1 - distanceToCenter, 0, 1) + 0.5;

   weight = pixelSize * centerWeight;
   ```

### 3.2 细化模式 (Refinement)

**ADDITIVE 模式** (Potree v2 默认)

- 父节点和子节点同时显示
- 适合：点数据，远近都显示完整细节
- 缺点：重复渲染，性能较低

**REPLACING 模式** (Potree v3 默认)

- 子节点加载完成后替换父节点
- 实现逻辑：
  ```javascript
  if (anyChildVisible && allChildrenLoaded) {
    // 隐藏父节点，只显示子节点
    node.visible = false;
    for (let child of node.children) {
      child.visible = true;
    }
  }
  ```
- 适合：体素数据，避免重复渲染

### 3.3 LRU内存管理

**触发时机**：每帧调用 `PointCloudOctree.clearLRU(renderer)`

**清理策略**：

```javascript
// 条件：缓存超过10个节点 && 最老节点超过100ms未访问
if (lru.items.size >= 10 && newest.timestamp - oldest.timestamp > 100) {
  let node = lru.oldest;
  node.traverse((n) => {
    renderer.disposeGpuBuffer(n.geometry.buffer); // 释放GPU缓冲
    n.geometry = null;
    n.loaded = false;
    lru.remove(n);
  });
}
```

---

## 四、数据加载流程

### 4.1 加载器架构 (PotreeLoader.js)

**初始化流程**

```javascript
// 1. 加载元数据
let response = await fetch("metadata.json");
let metadata = await response.json();

// 2. 解析属性定义
let attributes = parseAttributes(metadata.attributes);
// 结果：PointAttributes { attributes: [position, rgba, intensity, ...] }

// 3. 创建八叉树根节点
let octree = new PointCloudOctree();
octree.boundingBox = metadata.boundingBox;
octree.root = new PointCloudOctreeNode("r");
octree.root.nodeType = NodeType.PROXY; // 延迟加载层级结构
```

**节点加载流程** (`loadNode` 方法)

```javascript
async loadNode(node) {
    // 1. 并发控制
    if (nodesLoading >= 10) return;  // 最多10个并发
    if (!rateLimiter.tryAcquire()) return;

    // 2. PROXY节点：先加载层级结构
    if (node.nodeType === NodeType.PROXY) {
        await loadHierarchy(node);  // 从 hierarchy.bin 读取子节点信息
    }

    // 3. 获取Worker并发送加载任务
    let worker = WorkerPool.getWorker("DecoderWorker_default.js");
    worker.postMessage({
        url: "octree.bin",
        byteOffset: node.byteOffset,
        byteSize: node.byteSize,
        numPoints: node.numPoints,
        pointAttributes, scale, offset
    });

    // 4. Worker返回解码后的数据
    worker.onmessage = (e) => {
        node.geometry = new Geometry();
        node.geometry.buffer = e.data.buffer;  // GPU可用的ArrayBuffer
        node.loaded = true;
    };
}
```

### 4.2 Worker解码器 (DecoderWorker_default.js)

**核心任务**：将服务器的紧凑格式转换为GPU友好的布局

**数据布局转换**

服务器格式（交错布局）：

```
Point0: [X, Y, Z, R, G, B, A, Intensity, ...]
Point1: [X, Y, Z, R, G, B, A, Intensity, ...]
Point2: [X, Y, Z, R, G, B, A, Intensity, ...]
```

GPU格式（分离布局）：

```
Positions:  [X0, Y0, Z0, X1, Y1, Z1, X2, Y2, Z2, ...]
Colors:     [R0, G0, B0, A0, R1, G1, B1, A1, ...]
Intensity:  [I0, I1, I2, ...]
```

**转换代码逻辑**

```javascript
// 遍历每个属性
for (let attribute of pointAttributes.attributes) {
  if (attribute.name === "position") {
    // 坐标变换：整数 → 浮点 + 缩放 + 偏移
    for (let j = 0; j < numPoints; j++) {
      let X = view.getInt32(j * byteSize + offset, true);
      let x = X * scale[0] + offset[0] - min[0];
      targetView.setFloat32(numPoints * offset + j * 12, x, true);
    }
  } else {
    // 其他属性：直接复制到分离位置
    for (let j = 0; j < numPoints; j++) {
      let sourceOffset = j * byteSize + offset;
      let targetOffset = numPoints * offset + j * attribute.byteSize;
      // 复制字节
    }
  }
}
```

**统计信息计算**（仅根节点）

- 计算每个属性的 min/max/mean
- 用于材质系统的颜色映射范围

---

## 五、材质与着色器系统

### 5.1 材质系统架构 (PointCloudMaterial.js)

**核心概念**

```javascript
class PointCloudMaterial {
    attributes: Map<name, PointAttribute>;      // 可用属性列表
    attributeSettings: Map<name, Settings>;     // 每个属性的设置
    mappings: Array<Mapping>;                   // 注册的映射函数
    selectedMappings: Map<attributeName, Mapping>; // 当前选中的映射
    needsCompilation: boolean;                  // 是否需要重新编译着色器
}
```

**属性注册流程**

```javascript
// 1. 初始化时注册所有属性
material.init(pointcloud);
for (let attr of pointcloud.attributes.attributes) {
  material.registerAttribute(attr); // position, rgba, intensity, ...
}

// 2. 注册映射函数
material.registerMapping(MAPPINGS.SCALAR);
material.registerMapping(MAPPINGS.VECTOR3);
// 每个映射包含：condition, inputs, wgsl代码
```

### 5.2 动态着色器生成 (pipelineGenerator.js)

**生成流程**

```javascript
async function makePipeline(renderer, {octree, flags}) {
    // 1. 加载基础着色器模板
    let shaderSource = await fetch("octree.wgsl").then(r => r.text());

    // 2. 生成映射枚举
    let template_mapping_enum = "";
    octree.material.mappings.forEach((mapping, i) => {
        template_mapping_enum += `const MAPPING_${128 + i} = ${128 + i}u;\n`;
    });

    // 3. 生成映射选择分支
    let template_mapping_selection = "";
    mappings.forEach((mapping, i) => {
        template_mapping_selection += `
            if(attrib.mapping == MAPPING_${128 + i}) {
                color = map_${128 + i}(pointID, attrib, node, position);
            }`;
    });

    // 4. 注入映射函数实现
    let template_mapping_functions = "";
    mappings.forEach((mapping, i) => {
        // 将 "fn map(...)" 替换为 "fn map_128(...)"
        template_mapping_functions += mapping.wgsl.replaceAll(/fn .*\(/g, `fn map_${128 + i}(`);
    });

    // 5. 替换模板占位符
    shaderSource = shaderSource.replace("<<TEMPLATE_MAPPING_ENUM>>", template_mapping_enum);
    shaderSource = shaderSource.replace("<<TEMPLATE_MAPPING_SELECTION>>", template_mapping_selection);
    shaderSource = shaderSource.replace("<<TEMPLATE_MAPPING_FUNCTIONS>>", template_mapping_functions);

    // 6. 创建着色器模块和管线
    let module = device.createShaderModule({code: shaderSource});
    let pipeline = await device.createRenderPipelineAsync({...});
}
```

### 5.3 着色器模板结构 (octree.wgsl)

**Uniform缓冲区**

```wgsl
struct Uniforms {
    worldView: mat4x4<f32>,
    proj: mat4x4<f32>,
    screen_width: f32,
    screen_height: f32,
    pointSize: f32,
    // ...
}
```

**属性描述符**

```wgsl
struct AttributeDescriptor {
    offset: u32,        // 在缓冲区中的字节偏移
    type: u32,          // 数据类型 (U8, U16, F32, ...)
    numElements: u32,   // 元素数量 (1=标量, 3=向量)
    mapping: u32,       // 映射函数ID (128+)
    range_min: f32,
    range_max: f32,
}
```

**顶点着色器核心逻辑**

```wgsl
@vertex
fn main_vertex(@builtin(vertex_index) vertexID: u32) -> VertexOutput {
    // 1. 读取节点信息
    let nodeID = vertexID / node.numElements;
    let pointID = vertexID % node.numElements;

    // 2. 读取位置（根据splatType不同有不同逻辑）
    let position = readPosition(pointID, node);

    // 3. 投影变换
    let worldPos = node.world * vec4(position, 1.0);
    let clipPos = uniforms.proj * uniforms.worldView * worldPos;

    // 4. 计算点大小
    let pointSize = uniforms.pointSize * (uniforms.screen_height / clipPos.w);

    return VertexOutput(clipPos, pointSize, pointID, nodeID);
}
```

**片段着色器核心逻辑**

```wgsl
@fragment
fn main_fragment(input: VertexOutput) -> FragmentOutput {
    // 1. 读取属性值
    let attrib = attributeDescriptors[uniforms.activeAttribute];
    let value = readAttribute(input.pointID, attrib, node);

    // 2. 应用映射函数（动态注入的代码）
    var color = vec4<f32>(1.0);
    <<TEMPLATE_MAPPING_SELECTION>>  // 这里会被替换为 if-else 分支

    // 3. 输出颜色和ID
    return FragmentOutput(color, input.pointID + nodeOffset);
}
```

---

## 六、关键渲染概念

### 6.1 Splat类型

系统支持三种点渲染模式：

| 类型       | 值  | 拓扑            | 顶点数 | 用途                        |
| ---------- | --- | --------------- | ------ | --------------------------- |
| **POINTS** | 0   | `point-list`    | 1/点   | 标准点云，GPU原生点精灵     |
| **QUADS**  | 1   | `triangle-list` | 6/点   | 四边形广告牌，自定义形状    |
| **VOXELS** | 2   | `triangle-list` | 36/点  | 立方体体素，Potree v3内节点 |

**体素渲染优势**

- 远距离：用少量体素代替大量点，性能更好
- 视觉连续：避免点之间的空隙
- 数据压缩：内节点用BC压缩存储颜色

### 6.2 EDL (Eye-Dome Lighting)

**原理**：通过深度差异增强边缘，提升点云的立体感

**算法步骤** (EDL.js)

```javascript
// 1. 对每个像素采样8个方向的邻居深度
let sampleOffsets = [
  (0, 1),
  (0.707, 0.707),
  (1, 0),
  (0.707, -0.707),
  (0, -1),
  (-0.707, -0.707),
  (-1, 0),
  (-0.707, 0.707),
];

// 2. 计算深度响应
let response = 0;
for (let offset of sampleOffsets) {
  let neighborDepth = readLinearDepth(offset);
  response += max(log2(depth) - log2(neighborDepth), 0);
}
response /= 8;

// 3. 应用阴影
let edlStrength = 0.2;
let shadow = exp(-response * 300 * edlStrength);
color.rgb *= shadow;
```

**效果**：深度变化大的区域（边缘）变暗，增强轮廓

### 6.3 点预算 (Point Budget)

**作用**：限制每帧渲染的最大点数，保证帧率稳定

**实现方式**

```javascript
// 在可见性更新中累计点数
let numPoints = 0;
while (priorityQueue.size() > 0) {
  let node = priorityQueue.pop();

  visibleNodes.push(node);
  numPoints += node.numElements;

  // 超过预算？停止展开子节点
  if (numPoints > Potree.settings.pointBudget) {
    break;
  }

  // 否则继续展开
  for (let child of node.children) {
    priorityQueue.push(child);
  }
}
```

**默认值**：200万点 (2,000,000)

### 6.4 属性映射系统

**映射函数结构** (mappings.js)

```javascript
const MAPPING_SCALAR = {
  name: "scalar",
  condition: (attr) => attr.numElements === 1, // 单值属性
  inputs: ["value"],
  wgsl: `
        fn map(pointID: u32, attrib: AttributeDescriptor, ...) -> vec4<f32> {
            let value = readAttribute(pointID, attrib);
            let normalized = (value - attrib.range_min) / (attrib.range_max - attrib.range_min);
            let color = textureSample(colormap, sampler, vec2(normalized, 0.5));
            return color;
        }
    `,
};
```

**常用映射类型**

- `SCALAR`: 单值 → 颜色渐变（intensity, elevation）
- `VECTOR3`: 三值 → RGB（rgba, normal）
- `LAS_CLASSIFICATION`: 分类 → 预定义颜色表

---

## 七、WebGPU资源管理

### 7.1 Renderer核心职责 (src/renderer/Renderer.js)

**初始化流程**

```javascript
async init() {
    // 1. 获取WebGPU适配器和设备
    this.adapter = await navigator.gpu.requestAdapter();
    this.device = await this.adapter.requestDevice();

    // 2. 配置Canvas上下文
    this.context = canvas.getContext("webgpu");
    this.context.configure({
        device: this.device,
        format: "bgra8unorm",
        alphaMode: "opaque"
    });

    // 3. 创建屏幕缓冲区
    this.screenbuffer = new RenderTarget(this, {
        size: [canvas.width, canvas.height],
        colorDescriptors: [
            {format: "bgra8unorm"},      // 颜色
            {format: "r32uint"}          // 对象ID（用于拾取）
        ],
        depthDescriptor: {format: "depth32float"}
    });
}
```
