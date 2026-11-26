# 建筑内容契约

BEWright 把建筑当作**外部内容**：工具本体 `src/` 不包含任何具体建筑，也不静态 import 建筑代码。每个建筑是一个独立文件夹，通过清单被发现，通过 `defineBuilding()` 声明自己的一切。

## 目录结构

```
buildings/pavilion/
├── blockwright.building.json   # 发现用清单（必需）
├── building.ts                 # 入口模块，export default defineBuilding({...})
├── check.ts                    # 可选：该建筑自己的校验函数
├── README.md                   # 可选：建筑说明
└── output/                     # 按命令生成
    ├── previews/               # PNG
    ├── bedrock/                # .mcstructure，超限时为分片与 assembly.json
    ├── bedrock-worlds/         # 本地基岩存档
    └── java-worlds/            # 本地 Java 存档
```

建筑可作为内容根的直接子目录，也可将含 manifest 的建筑目录本身指定为内容根。
源码仓库用根配置注册 `examples/` 下的示例。独立工作区默认扫描自己的 `buildings/`。

要分享源码和现有结果，可以复制或压缩整个建筑目录。收到后用 `bewright import ./pavilion --local` 从源码生成独立世界，也可直接复制 `output/` 内的存档到游戏目录。单个基岩结构文件可用结构方块或 `bewright import --file` 放置。超大建筑的分片由 `assembly.json` 记录摆放信息，整座写入可直接使用建筑目录。为方便复现，建筑 README 可记录使用的参数、目标版本和出生点。

一张地图包含多座建筑时，可用 `bewright pack --layout layout.json` 打包导入清单和它引用的建筑源码。清单记录各实例的参数、位置和朝向，以及地图出生点。[源码打包](cli.md#bewright-pack---layout-file)

仅运行 `bewright build` 时不会生成这个目录。构建报告通过 `--report` 按需写入，常规预览和导出只保存请求的结果。

## 清单 `blockwright.building.json`

```json
{
  "schemaVersion": 1,
  "id": "pavilion",
  "name": "BEWright Pavilion",
  "entry": "./building.ts",
  "editions": ["bedrock", "java"]
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 目前只支持 `1` |
| `id` | 是 | 小写 slug，全局唯一；重复会直接报错 |
| `name` | 是 | 人类可读名称，写入世界名与报告 |
| `entry` | 是 | 相对建筑目录的入口模块，必须留在目录内 |
| `editions` | 否 | `bedrock` / `java`，默认 `["bedrock"]` |
| `status` | 否 | `stable`（默认）或 `wip`；`wip` 建筑仍可被 `list` 发现、按 id 构建，但会被全量测试门跳过（`BLOCKWRIGHT_TEST_WIP=1` 可纳入） |

清单只用于**发现**，不承载生成逻辑；真正的配置在入口模块里，因此可以用 TypeScript 表达计算出来的视图、调色板和校验。

并行开发时给半成品加 `"status": "wip"`，它会被通用内容测试跳过；显式按 id 构建仍会执行，不应把 `wip` 当作所有批处理的过滤保证。

## 入口模块

以下为声明片段；`pavilion()` 是建筑自己的生成函数：

```ts
import { defineBuilding, Structure } from 'bewright';

export default defineBuilding({
  id: 'pavilion',
  name: 'BEWright Pavilion',
  description: '亭子：柱、梁、栏杆与可调屋顶',
  params: { roofRise: { type: 'int', default: 6, min: 1, max: 10 } },
  build: ({ roofRise }) => pavilion(Number(roofRise)),
  bounds: { min: [0, 0, 0], max: [40, 27, 32] },
  spawn: [20, 3, 16],
  views: [
    { name: 'pavilion', view: 'iso' },
    { name: 'section', region: { min: [0, 0, 16], max: [40, 27, 32] }, view: 'iso' },
  ],
  editions: ['bedrock', 'java'],
  artifacts: 'artifacts/pavilion',
});
```

一次命令、固定参数内，相同的 `build` 函数会被复用；视图的状态准备在分离快照上执行。生成函数应创建自己的模型；检查函数只检查，不修改模型。

建筑统一从 `blockwright` 或其公开子路径导入 API。独立项目可安装工具包以获得类型声明，也可让 `bewright` 直接加载外部目录。没有 `package.json` 的建筑目录推荐用 `.mts` 或 `.mjs` 声明 ESM；`bewright init <id>` 会创建最小示例。

### `BuildingDefinition` 字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 必须与清单一致 |
| `build(args)` | 是 | 返回 `Structure` 或 `Components`；固定参数应生成确定、完整的模型，不依赖调用次数 |
| `bounds` | 是 | 半开区间 `{min,max}`；导出、分片、导入都基于它 |
| `spawn` | 否 | 模型坐标中的出生点。Java 沿用原坐标。Bedrock 的 `import --local` 在未旋转、该点落入写入区域时换算为世界坐标；其他情况可用 `--spawn` 指定 |
| `params` | 否 | 参数声明，见下 |
| `views` | 否 | 预览/网格视图；省略时用 `bounds` 生成一个以 id 命名的 iso 视图 |
| `tiles` | 否 | 分片方案；`false` 禁用分片，单文件仍须满足体积上限 |
| `editions` | 否 | 默认 `["bedrock"]` |
| `artifacts` | 否 | 库调用 `runBuild` 的旧产物目录配置。CLI 使用建筑的 `output/`，也可用 `--out` 显式覆盖 |
| `cache` | 否 | 网格缓存目录，默认 `cache/meshes/<id>` |
| `check(ctx)` | 否 | 建筑自有校验；可抛错或返回结构化诊断 |

使用 [`createScene`](authoring-guide.md) 时返回 `scene.world` 即可。框架自动执行场景中注册的构件检查与额外断言，
即使建筑省略 `check()`，这部分检查仍会运行。建筑自有 `check()` 用于补充自己的场景规则。

### 参数 `params`

```ts
params: {
  roofRise: { type: 'int',     default: 6, min: 1, max: 10 },
  massing:  { type: 'boolean', default: false },
  scheme:   { type: 'string',  values: ['arctic', 'copper', 'midnight'], default: 'arctic' },
}
```

`type` 支持 `int | number | string | boolean`。命令行用 `--param k=v` 覆盖，工具负责类型转换、范围与枚举校验，并拒绝未声明的参数。参数名允许 camelCase。

### 视图 `views`

| 字段 | 说明 |
|---|---|
| `name` | 小写 slug，用于报告中的视图键与截图名；网格缓存按内容指纹寻址 |
| `build` | 该视图单独使用另一个模型（例如剖切或参数变体） |
| `region` | 该视图的预览网格范围，默认 `bounds`；不改变结构导出或世界写入区域 |
| `view` | `iso \| top \| front \| side`，默认 `iso` |
| `direction` / `eye` / `target` | 相机控制；有 `eye` 时使用透视相机 |
| `fit` | `geometry`（按可见顶点取景，默认）或 `bounds` |
| `style` | 仅预览用的颜色覆盖，不改变方块数据 |

声明视图通过 CLI 使用：

```powershell
node dist/cli/index.js preview <id> --list                 # 列出声明视图
node dist/cli/index.js preview <id> --view-name <name>     # 用该视图的机位与配色渲染
node dist/cli/index.js preview <id> --all-views            # 一次渲染全部
```

未显式传 `--style` 时，视图自己的 `style` 会叠加在 `natural` 之上；传了 `--style contrast` 则叠加在 `contrast` 之上。视图的 `build`（例如剖切或参数变体）同样会被使用。

### 分片 `tiles`

单个 `.mcstructure` 的体积上限是 `2_000_000` 方块。需要导出（`bewright build --export` / `bewright export`）且超过上限的建筑**必须**声明 `tiles`，否则会报错并提示；`assembly.json` 记录每片的文件名、偏移和尺寸。

`tiles` 把三件事分开表达，**导出分片大小不再隐式决定世界放置行为**：

```ts
// 旧写法（仍然支持，等价于下面导出与放置分批用同一个 size）
tiles: { size: 64, region: bounds, origin: bounds.min }

// 分开表达
tiles: {
  export:    { shard: 32, region: bounds },              // .mcstructure 分片
  placement: { region: bounds, origin: [0, 0, 0], batchSize: 64 }, // 世界放置与写入批次
}
```

| 字段 | 含义 |
|---|---|
| `export.shard` | 结构文件分片的 X/Z 边长，保留完整 Y 范围；只影响产物文件 |
| `export.region` | 导出覆盖的区域，默认 `bounds` |
| `placement.region` | 写入世界时使用的区域，默认同导出区域 |
| `placement.origin` | 公共 API 的默认放置锚点，缺省为旧 `origin` 或区域最小点；CLI 的 `--origin`（含默认值）覆盖它 |
| `placement.batchSize` | 当前按 X/Z 边长切分，保留完整 Y 范围，并非方块数量上限；显式方案缺省不分批 |

Bedrock 每个放置批次的 x/z 锚点都须按 16 对齐；采用 16 的倍数作为批次边长，并检查实际区域与放置原点。

Bedrock 单建筑导入直接写入模型，按 `placement` 的区域和批次设置执行。清单导入沿用该区域，使用清单中的 `origin` 确定落点，并将各实例组合后统一写入。旧配置的兼容映射由 `resolveTilePlan` 处理，`size` 同时指定导出分片与单建筑写入批次的 X/Z 边长。

### 校验 `check`

```ts
check: ({ world, model, args, inspect, diagnostics, surfaces, protection, bounds, collect }) => {
  verifyQinglanRoutes(world);                     // 抛错即失败（兼容旧写法）
  collect(regionDiagnostic('building.route', '…', box));  // 也可以只报诊断
  if (diagnostics.some(d => d.code === 'placeholder')) throw new Error('unsupported geometry');
}
```

`check` 由 `bewright build`、`bewright check` 和 `npm test` 的通用内容测试共同执行，因此新增建筑会自动纳入回归。上下文里 `world/model/args/inspect/diagnostics` 是原来的字段（保持兼容），新增的都是可选：

| 字段 | 用途 |
|---|---|
| `bounds` | 声明的模型范围 |
| `surfaces` | 实际表面查询：`terrain` / `water` / `standable` / `groundY`，按 `Structure.revision` 失效 |
| `protection` | 保护区与净空契约注册表 |
| `collect(diag)` / `report(diag)` | 在不抛错的前提下产出结构化诊断（同一函数） |

`check` 的返回值可以是 `void`（旧写法）、单条诊断、诊断数组，或 `{ diagnostics }` / `{ issues }`。

## 内容根发现顺序

1. 命令行 `--content DIR_OR_MANIFEST`（可重复）
2. 环境变量 `BLOCKWRIGHT_CONTENT_PATH`（多个路径用系统分隔符）
3. 工作区配置的 `contentRoots`
4. 当前工作区的 `buildings/`

这些来源合并发现，同一清单只加载一次。不同清单若声明同一个 `id`，按 id 查找会报错。传目录或清单路径可直接选择对应建筑，适合比较两个版本。配置中的相对路径从配置文件所在目录解析。

```powershell
node dist/cli/index.js list --content D:\mc-buildings --detailed
$env:BLOCKWRIGHT_CONTENT_PATH = 'D:\mc-buildings;E:\more-buildings'
node ./node_modules/bewright/dist/cli/index.js build ../mc-buildings/my-arch
node ./node_modules/bewright/dist/cli/index.js preview ../mc-buildings/my-arch/blockwright.building.json --watch
```
