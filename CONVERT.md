# PLY 转 Potree 格式转换记录

## 背景

需要将 `resources/bridge/BridgeDemoFile.ply` 转换为 Potree v2 格式，保存到 `resources/bridge/potree/` 目录。

转换工具为项目 `converter/` 目录下的 PotreeConverter 2.1.1（Windows 可执行文件）。

## 问题：PotreeConverter 不支持 PLY 格式

直接执行：

```bash
./converter/PotreeConverter.exe ./resources/bridge/BridgeDemoFile.ply -o ./resources/bridge/potree
```

输出 `#points: 0`，转换失败。PotreeConverter 2.1.1 无法解析 PLY 文件。

## PLY 文件分析

用 `head -c 1000` 查看文件头部：

```
ply
format binary_little_endian 1.0
comment Created by Open3D
element vertex 47995445
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
property int labelCol3
property int labelCol2
property int labelCol1
property int labelCol0
end_header
```

- **点数**: 47,995,445（约 4800 万）
- **格式**: binary_little_endian
- **每点字节数**: 3×float(12) + 3×uchar(3) + 4×int(16) = **31 字节**
- **文件大小**: 1.49 GB（header 300 字节 + 数据 1,487,858,826 字节）
- **自定义属性**: `labelCol0-3` 是 Open3D 生成的标签列，PotreeConverter 不认识

## 解决方案：PLY → LAS → Potree

PotreeConverter 2.1.1 支持 LAS 格式，因此采用两步转换：

### 第一步：PLY 转 LAS

使用 Python + numpy + laspy 编写转换脚本。核心逻辑：

1. **解析 PLY header**，获取点数和 header 大小
2. **扫描坐标范围**（分批读取，每批 500 万点），确定 LAS 文件的 offset
3. **分批写入 LAS**，将 RGB 从 8bit 扩展到 16bit（LAS 标准要求）

```python
import numpy as np
import laspy

PLY_PATH = "BridgeDemoFile.ply"
LAS_PATH = "BridgeDemoFile.las"
HEADER_SIZE = 300  # PLY header 字节数
NUM_POINTS = 47995445
POINT_SIZE = 31
CHUNK_SIZE = 5_000_000

# 定义 PLY 二进制结构
dtype = np.dtype([
    ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
    ("r", "u1"), ("g", "u1"), ("b", "u1"),
    ("l3", "<i4"), ("l2", "<i4"), ("l1", "<i4"), ("l0", "<i4"),
])

# 第一遍：扫描坐标范围
mins = np.array([np.inf, np.inf, np.inf])
maxs = np.array([-np.inf, -np.inf, -np.inf])
with open(PLY_PATH, "rb") as f:
    f.seek(HEADER_SIZE)
    remaining = NUM_POINTS
    while remaining > 0:
        batch = min(CHUNK_SIZE, remaining)
        raw = f.read(batch * POINT_SIZE)
        data = np.frombuffer(raw, dtype=dtype)
        xyz = np.column_stack([data["x"], data["y"], data["z"]])
        mins = np.minimum(mins, xyz.min(axis=0))
        maxs = np.maximum(maxs, xyz.max(axis=0))
        remaining -= batch

# 创建 LAS header
header = laspy.LasHeader(point_format=2, version="1.2")
header.offsets = mins.tolist()
header.scales = [0.001, 0.001, 0.001]

# 第二遍：写入 LAS
with laspy.open(LAS_PATH, mode="w", header=header) as writer:
    with open(PLY_PATH, "rb") as f:
        f.seek(HEADER_SIZE)
        remaining = NUM_POINTS
        while remaining > 0:
            batch = min(CHUNK_SIZE, remaining)
            raw = f.read(batch * POINT_SIZE)
            data = np.frombuffer(raw, dtype=dtype)
            point_record = laspy.ScaleAwarePointRecord.zeros(batch, header=header)
            point_record.x = data["x"]
            point_record.y = data["y"]
            point_record.z = data["z"]
            point_record.red = data["r"].astype(np.uint16) * 257    # 8bit → 16bit
            point_record.green = data["g"].astype(np.uint16) * 257
            point_record.blue = data["b"].astype(np.uint16) * 257
            writer.write_points(point_record)
            remaining -= batch
```

关键细节：
- **LAS point_format=2**: 包含 xyz + rgb，是最简单的带颜色格式
- **RGB 8→16bit**: LAS 标准中 RGB 是 uint16，乘以 257（`0xFF * 257 = 0xFFFF`）实现无损扩展
- **分批处理**: 每次 500 万点，避免内存溢出
- **labelCol 属性被丢弃**: LAS 格式不需要这些自定义标签

### 第二步：LAS 转 Potree

```bash
./converter/PotreeConverter.exe ./resources/bridge/BridgeDemoFile.las -o ./resources/bridge/potree
```

输出：

```
#points: 47'995'445
sampling method: poisson
duration: 5.068s
throughput: 9.5M points/s
```

### 第三步：清理中间文件

删除临时的 LAS 文件和 Python 脚本：

```bash
rm resources/bridge/BridgeDemoFile.las
rm resources/bridge/ply_to_las.py
```

## 最终输出

`resources/bridge/potree/` 目录：

| 文件 | 大小 | 说明 |
|------|------|------|
| `metadata.json` | 3.4 KB | 点云元数据（坐标范围、属性定义、层级信息） |
| `hierarchy.bin` | 633 KB | 八叉树层级结构（节点索引） |
| `octree.bin` | 1.2 GB | 点云数据（所有 LOD 层级的点） |

## 加载方式

```javascript
import { PotreeLoader } from "potree";

let octree = await PotreeLoader.load("./resources/bridge/potree/metadata.json");
```

## 依赖

- Python 3.x
- numpy (`pip install numpy`)
- laspy (`pip install laspy`)
- PotreeConverter 2.1.1（`converter/PotreeConverter.exe`）
