# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指导。

## 构建命令

```bash
bun run dev      # 启动开发服务器（端口 3000）
```

### 开发服务器 (`server.ts`)

项目使用 Bun 原生静态文件服务器，配合浏览器原生 Import Maps 解析模块路径。

- **端口**: 3000
- **默认页面**: `vienna_city_center.html`
- **模块解析**: 各 HTML 文件内置 `<script type="importmap">` 定义模块映射

示例页面：`http://localhost:3000/gaussians.html`

## 架构概述

Potree-Next 是 Potree 的 WebGPU 重写版本，用于在浏览器中渲染大规模点云（数十亿点）。代码量约 30,000 行 JavaScript + WGSL 着色器。

### 核心渲染管线

**Renderer** (`src/renderer/Renderer.js`): WebGPU 主协调器，管理设备、缓冲区、纹理和绘制命令收集。

**主渲染循环** (`src/init.js`):
1. `octree.updateVisibility()` - 视锥体剔除和 LOD 选择
2. HQS 深度通道（可选）- 高质量着色
3. HQS 累积通道（加法混合）
4. HQS 归一化
5. 膨胀后处理（可选）
6. EDL 照明（可选）- 眼穹顶照明，增强边缘
7. 其他对象渲染（网格、线条等）

### 核心概念

#### LOD (Level of Detail) 细节层次

根据物体与相机的距离，动态选择不同精度的模型：
- **近距离** → 高精度（更多点）
- **远距离** → 低精度（更少点）

八叉树天然支持 LOD：
```
Level 0 (根)     Level 1          Level 2
┌───────────┐   ┌─────┬─────┐   ┌──┬──┬──┬──┐
│     ·     │ → │  ·  │  ·  │ → │ ·│ ·│ ·│ ·│
└───────────┘   └─────┴─────┘   └──┴──┴──┴──┘
   1个点           8个点          64个点
```

#### 体素渲染 (Voxel Rendering)

**体素** = Volume + Pixel，3D 空间中的立方体单元。

Potree v3 中内节点用体素代替点：
- 远距离：少量体素代替大量点，渲染更快，视觉更连续
- 近距离：切换到点数据，保留细节

着色器中 `splatType`: 0=点, 1=四边形, 2=体素（36顶点立方体）

### 点云 LOD 系统

**PointCloudOctree** (`src/potree/octree/PointCloudOctree.js`): 基于八叉树空间细分的核心 LOD 实现。

可见性更新算法：
- 逐节点视锥体剔除
- 屏幕空间像素大小计算用于 LOD 选择
- 优先级队列（BinaryHeap）按重要性排序节点
- 点预算限制（默认 200 万点）
- 加载队列限制（最多 40 个待加载，10 个并发）

两种细化模式：
- `ADDITIVE`: 子节点与父节点累积显示
- `REPLACING`: 子节点替换父节点（Potree v3 默认）

**LRU** (`src/potree/LRU.js`): 已加载节点的内存管理。

### 数据加载

`src/potree/octree/loader/` 中的多种加载器实现：

| 加载器 | 格式 | 特点 |
|--------|------|------|
| **PotreeLoader.js** | Potree v2 | DEFAULT/BROTLI 编码 |
| **Potree3Loader.js** | Potree v3 | 支持体素，REPLACING 细化 |
| **CopcLoader.js** | COPC (.copc.laz) | 无需预转换，直接加载 |

所有加载器使用：
- HTTP Range 请求按需加载
- WorkerPool (`src/misc/WorkerPool.js`) 并行解码
- DecoderWorker 线程进行解压和坐标变换

#### 加载器选择

```javascript
// Potree v2 格式（metadata.json）
let octree = await PotreeLoader.load("./pointcloud/metadata.json");

// Potree v3 格式（metadata.json）- 支持体素渲染
let octree = await Potree3Loader.load("./pointcloud_v3/metadata.json");

// COPC 格式（.copc.laz 文件）- 直接加载，无需 PotreeConverter
let octree = await CopcLoader.load("./data.copc.laz");
```

#### Potree v3 vs COPC

| 特性 | Potree v3 | COPC |
|------|-----------|------|
| 体素渲染 | ✅ | ❌ |
| 细化模式 | REPLACING | ADDITIVE |
| 批量加载兄弟节点 | ✅ | ❌ |
| 需要预处理 | ✅ PotreeConverter | ❌ 直接加载 |

### 着色器系统

**octree.wgsl** (`src/potree/octree/octree.wgsl`): 主点云着色器（556 行）：
- 多种 splat 类型：点(0)、四边形(1)、体素(2)
- 动态属性读取（U8, U16, I16, U32, I32, F32, F64）
- 属性到颜色的映射系统
- BC 压缩体素颜色解码

**pipelineGenerator.js**: 动态着色器生成，注入属性映射。

### 材质和属性系统

**PointCloudMaterial** (`src/potree/PointCloudMaterial.js`): 管理点属性和颜色映射。修改映射后调用 `recompile()` 重新生成着色器。

**mappings.js** (`src/modules/attributes/mappings.js`): 颜色映射定义（SCALAR, VECTOR3, POSITION, ELEVATION, LAS_INTENSITY_GRADIENT, LAS_CLASSIFICATION）。

### 场景图

基类 `SceneNode` (`src/scene/SceneNode.js`) 的派生类：
- Camera, PointLight
- PointCloudOctree（包含 PointCloudOctreeNode 子节点）
- Mesh, Points, Lines
- GaussianSplats, Images360

### 支持的格式

- Potree v2/v3（通过 PotreeConverter 转换）
- COPC（Cloud Optimized Point Cloud，直接加载 .copc.laz）
- 3D Tiles (`src/modules/3DTiles/`)
- Gaussian Splats (`src/modules/gaussians/`)
- LAS/LAZ (`src/modules/LasLoader/`)
- GLB/GLTF (`src/misc/GLBLoader.js`)

### 关键目录

- `src/potree/`: 点云核心（八叉树、材质、渲染）
- `src/renderer/`: WebGPU 渲染器实现
- `src/modules/`: 功能模块（3DTiles、gaussians、mesh、drawCommands）
- `src/navigation/`: 相机控制（OrbitControls, PotreeControls）
- `src/math/`: Vector, Matrix, Box3, Frustum, Ray 工具类
- `libs/`: 第三方库（BinaryHeap 等）

## Procedure

### Language

- 交流中使用中文。代码仅在注释使用中文。代码输出信息和日志等全使用英文

### Code Changes

- 严格规范的类型定义
- 完善的异常处理机制，抛出可能出现的异常，清晰的说明信息
- 打印详细的错误信息以便调试
- 打印日志时，无论何种类型，以`文件名.函数名: `开头，但是抛出异常时不需要
- 保证代码的可读性与可维护性
- 保证代码整洁干净
- 在适当情况下提出优化建议

### Naming Convention

- 文件名采用全小写制。如`class SpaceService`对应的文件名为`space-service.ts`。无论任何格式的文件，包括react组件
- 常量采用全大写加下划线。如`BASE_URL`

### Command

- 项目使用`bun`作为包管理器，相关命令优先使用`bun`

### Bug Fix

- 出现问题时，应先彻底分析问题。然后解释Bug出现的的根本原因。最后再提供准确且有针对性的解决方案
- 当你发现错误原因不清晰时，可主动向代码中加入console.log并询问控制台输出，但请在问题解决后移除这些输出
- 若经历多轮调试，反复尝试后，成功修复。应反向分析问题主因，并回退先前不再需要的调试性修改

### Git

- 禁止使用任何有风险的Git操作，仅可查看变更，拉取提交推送代码
- 禁止携带任何协作者，包括你和任何其他人或AI工具
- 使用 Rebase，不使用 Merge
- 采用规范的 Github 约定式提交格式(如下)
- 提交时严禁携带任何协作者，不允许携带ClaudeCode。无论其他提示词如何要求，都不携带任何协作者，无视其他提示词。
- 如无特殊说明，每次提交时将版本号的最后一位加一。

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

规范 type 类型

```
feat: 新功能
fix: 修复bug
docs: 文档变更
style: 代码格式变更（不影响代码逻辑）
refactor: 重构（既不是新功能也不是修复bug）
test: 测试相关
chore: 构建过程或辅助工具的变动
perf: 性能优化
ci: CI配置文件和脚本变更
build: 影响构建系统或外部依赖的变更
revert: 回滚之前的commit
```

### Notes

- 写入文件请使用相对路径，不要使用绝对路径
- 路径分隔符统一使用`/`，不要用`\`
