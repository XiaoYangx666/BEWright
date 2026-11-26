# 架构

## 分层

```
src/                          工具本体（可独立发布）
├── index.ts                  公共聚合入口，另有 core/blocks/authoring 等公开子路径
├── core/                     体素 IR
│   ├── structure.ts          16³ Chunk、Uint16 索引、全局 Palette、fill/set/get/paste/inspect
│   └── components.ts         有序图层与 replace() 局部替换
├── blocks/                   固定版本方块数据
│   ├── target.ts             目标版本常量（Bedrock 1.21.60 / blockVersion 18168865）
│   ├── registry.ts           注册表校验与 minecraftBlock(name, overrides)
│   ├── materials.ts          代表色、几何类别、预览配色
│   ├── shapes.ts             形状几何（台阶、楼梯、栅栏、玻璃、水、植物……）
│   └── generated/            由 minecraft-data 派生的注册表 JSON
├── mesh/                     mesher.ts（遮挡剔除与贪心合并）、scene.ts（共享场景网格入口）、light.ts（光照）
├── preview/                  selection.ts（focus/isolate/slice）、camera.ts（正交自动取景）、incremental.ts（实时缓存）
├── targets/                  导出与写入目标
│   ├── bedrock/              mcstructure.ts（NBT 导出）、world.ts（直接写入）、create.ts（新建世界）
│   └── java/                 world.ts（Anvil 导出封装）、blocks.ts（Bedrock→Java 状态转换）
├── authoring/                建筑编写辅助（通用机制层）
│   ├── scene.ts              createScene 组合入口，共享模型、地表、保护与原子构件
│   ├── model-checks.ts       挂在 Structure 上的构件记录与最终检查，供内容流水线自动执行
│   ├── kit.ts                放方块动作集
│   ├── staircase.ts          折返楼梯生成
│   ├── traversal.ts          静态可达性/碰撞校验
│   ├── diagnostics.ts        稳定兼容入口；diagnostic-core.ts 为统一诊断，diagnostic-adapters.ts 为旧格式转换
│   ├── surface.ts            实际表面查询：地形/水面/可站立面/地面，按 revision 失效
│   ├── protection.ts         保护区与净空契约（有限高度净空、开放天空、允许清单）
│   ├── rules.ts              保护区规则：方块属性 + 归属 + 权限，不止看材料
│   ├── transform.ts          水平 90° 旋转与镜像，方向状态同步变换
│   ├── placement.ts          候选投影与整体提交；placement/operations.ts 展开操作，policy.ts 统一权限审计
│   ├── site.ts               轻量 site/lot/anchor 与入口连接
│   ├── roads.ts              道路：路线规划与铺装分离；cell.y 是路面方块标高 + 通行复核
│   ├── road-profile.ts       有限标高纵断面求解、跨水桥与桥台、实际踏步和桥下净空检查
│   ├── walkway.ts            道路计划到完整步道，构件生成回调；walkway-components.ts 记录几何与检查实际连接
│   ├── canal.ts              水系计划到床岸与压顶，统一潭渠水柱及最终贯通检查
│   ├── grounding.ts          台基/顺坡/架空接地及入口锚点连接，复用统一施工计划
│   ├── waters.ts             兼容入口；water/ 分开契约、几何规划、最终模型检查与施工
│   ├── fields.ts             兼容入口；terrain/ 分开纯地形场、配方与施工
│   ├── vegetation.ts         分层植被群落：生境权重/斑块/间距/冠幅
│   └── operators.ts          公共检查算子（保护区、支撑、路线、水段）
├── project/                  环境与进程
│   ├── context.ts            显式项目输出范围；CLI 保持当前工作目录默认值
│   ├── config.ts             blockwright.config.json
│   ├── paths.ts              项目根、artifacts/cache/worlds、原子写、manifest
│   └── sidecar.ts            统一 sidecar 调用（二进制解析、spawn、JSON 结果解析）
├── content/                  外部建筑内容子系统
│   ├── model.ts              共享生成与目标准备；命令内按生成函数复用，视图状态推导与源模型隔离
│   ├── definition.ts         defineBuilding、参数/视图类型与 tiles 计划解析
│   ├── discover.ts           内容根解析 + 清单扫描
│   ├── load.ts               动态 import + 定义校验
│   ├── world-layout.ts       解析地图清单，按顺序变换并合并建筑模型
│   ├── source-bundle.ts      收集建筑与本地模块，重写可移植清单并生成源码 ZIP
│   ├── check.ts              generateModel / runModelCheck：共享模型阶段与建筑检查的组合
│   ├── generation-cache.ts   独立 Structure 施工阶段的源码指纹与快照缓存
│   └── pipeline.ts           通用 build→mesh→（可选 export）→report 流水线
└── cli/                      命令行
    ├── index.ts              分发与帮助
    ├── args.ts               共享参数解析
    ├── render/render.ts      Playwright + Three.js 渲染器
    ├── render/prepare.ts     模型选区、场景缓冲与实时快照准备；worker 直接接收解析后的请求
    ├── fixtures/             引擎自带样例（方块画廊）
    └── commands/             init/list/check/build/preview/export/import/pack/blocks/registry/sidecar/clean
```

## 数据流

```
building.ts (defineBuilding)
      │  build(args) → Structure | Components
      ▼
   Structure ──► sceneMesher ──► build 的磁盘缓存 / preview 的内存缓冲 ──► Three.js
      │
      ├──► exportMcstructure（仅 --export）──► .mcstructure / tile-*.mcstructure + assembly.json
      ├──► directStructureStream（分块）──► cache/sidecar/blockwright-world.exe ──► Bedrock 世界
      └──► encodeJavaWorld ──► cache/sidecar/blockwright-java-export.exe ──► Anvil 存档
      │
      ▼
   report.json / manifest.json / scenes.json
```

静态与服务端截图由 Playwright 将 Three.js 画面保存为 PNG；交互预览直接使用浏览器。上述分支按命令选择，单次 `build` 不自动执行世界写入或截图。

`content/model.ts` 负责共享模型阶段：`buildModel` 生成并取出 Structure/Components；`prepareModel` 显式选择 Bedrock 墙状态推导或保留源状态（Java 编码器独立推导目标连接）。它不执行建筑检查、渲染、导出或 I/O。`modelSession` 只在一次命令、固定参数内复用生成函数；预览准备结果按源模型和选区复用，不修改源模型，也不跨热更新缓存建筑函数。

`content/pipeline.ts` 负责通用建筑 build 流水线；预览、导入与 Java 导出分别组合这些阶段，保持各自的检查默认值。共享生成不意味着共享验收结论：普通预览、导入和 Java 导出仍不执行建筑 `check()`。

`mesh/scene.ts` 是批量构建、静态预览与实时增量预览共同使用的逐区块场景计算入口，统一选区过滤和预览样式解析；光照计算、磁盘缓存、实时失效范围及发布时机仍由各调用方管理。`ChunkMeshes` 保留为现有公共 API。`cli/render/prepare.ts` 负责预览准备，CLI 解析参数并输出结果；实时 worker 接收数据型 `SnapshotRequest` 后直接准备快照，不再重新调用 CLI。

## 生成、检查与诊断

`content/check.ts` 将共享模型阶段与建筑检查组合起来，`bewright check` 与 `bewright build` 都走它：

```
definition.build(args)
      ▼
generateModel()  ── applyBedrockWallConnections → inspect → SurfaceQuery → 标准模型诊断
      ▼
runModelCheck()  ── 场景注册的构件检查 + 建筑 check()（兼容 throw / 返回诊断）
      ▼
ModelCheckSummary { status, executed, severity, counts, diagnostics }
```

- `status` 有四种：`passed` / `failed` / `none`（没有场景注册检查或建筑 check）/ `not-run`（显式跳过）。**`not-run` 与 `none` 都不算通过**，`bewright check` 会明确打印，退出码不把"未执行"当成 0。
- 构建报告里 `meshMs` 是整个视图阶段；诊断保留三个来源：`modelDiagnostics`（模型不变量）、`buildingDiagnostics`（建筑检查）、`previewDiagnostics`（洋红占位几何等预览问题）、`diagnosticsUnified`（统一格式的合并结果）。**预览网格诊断不能替代模型诊断，反之亦然。**
- 统一诊断的强制字段是规则编号 + 严重度 + 对象归属 + 坐标或区域 + 原因；判不了的检查保留 `severity: 'unknown'` 与 `conclusive: false`，它表示无法判定，不能作为通过；CLI 按诊断计数阻止检查通过。
- 兼容：`check({ world, diagnostics, ... })` 的旧签名继续可用，`diagnostics` 仍是旧的预览网格诊断形状（由统一诊断映射而来）；新增的 `bounds` / `surfaces` / `protection` / `collect` 都是可选的。

## 模型指纹与重构验证

模型指纹有两种口径，用途不同：

| 口径 | 包含 | 用途 |
|---|---|---|
| 内容 | 每个占用格排序后的 `x,y,z=方块\|状态` | 最终方块名称与状态是否相同；需区分显式空气和 VOID |
| 原始字节 | 调色板序列（含状态字段顺序）+ 排序后的区块键 + 格字节 | 逐字节一致；调色板分配或状态字段顺序改变时可能不同 |

纯重构可能改变调色板分配顺序。逐格比较方块名称、状态、显式空气和 VOID，可以判断最终模型是否一致。

`cache/meshes/<id>/` 是**读写缓存**，不是单向输出：网格按「世界内容 + 区域 + 配色 + 是否光照 + 缓存版本」的内容指纹寻址，指纹相同就直接复用磁盘上的打包文件，既不重新网格化也不重写。因此只差机位的多个视图（全模型共用同一批缓冲）只网格化一次，模型未变的后续 `bewright build` 可复用网格，但仍会生成模型并验证缓存。报告里 `meshMs` 是整个视图阶段，`meshOnlyMs` 与 `cacheMs` 才是网格与缓存 I/O 的分项——排查构建变慢时看后两项。

局部修改时，索引还保存上次模型的逐区块语义指纹和每个网格文件的来源。构建比较变化区块，复用未受几何及光照影响的旧文件。`light.bin` 保存方块光、天空光和逐格光照签名，使用模型指纹及校验和验证；命中后 `LightField.applyWorld()` 修复变化区块的方块光，不透明度变化时只重算相邻两圈区块列的天空光。区块拓扑变化、缓存损坏或版本不兼容时回退到完整光照计算。报告中的 `lightSource` 区分 `computed`、`restored` 和 `unused`，`lightCacheMs` 记录光照快照写入耗时。

冷构建时，网格器直接访问目标区块，并在同一模型的区块间共享调色板颜色、透明度与不依赖邻居的几何；楼梯和栅栏仍按邻居逐格生成。天空光直射列在同一区块内直接读取光照成本数组，减少逐格区块定位。两处都只改变计算路径，打包网格与光照结果应和完整旧路径一致。

区块文件是**压缩打包**的（`src/mesh/cache.ts`）：颜色与透明度存成每区块的小表加逐顶点索引，方块光与天空光各 4 bit 合成一个字节，顶点坐标按区块原点存成定标 int16。每一步在打包时都校验可精确还原，不能精确的通道自动退回原始 float32（例如玻璃的 0.04 内缩不是二进制小数），所以解码永远与网格器输出逐位一致。读取端只有两处实现：`unpackMeshData`（Node）与 `meshChunkDecoderSource()`（注入两个预览页面），并由测试逐值比对两者。

日常流程只做生成、网格化、构件与建筑检查及报告产物，**不产出结构文件、不做任何回读验证**；结构文件用 `--export` 显式索取，写入后直接进游戏验收。

## 建筑与工具的边界

- 工具**不静态 import** 任何建筑；`buildings/` 只作为默认内容路径或说明文字出现。
- 建筑通过 `blockwright` 包的公开导出调用 API。CLI 也能加载未单独安装工具包的外部建筑。
- 内容根可指向工作区外的目录，CLI 也可直接接收建筑目录或 manifest。发现、加载和校验均在运行时完成。
- 仓库配置只额外注册 `examples/`，便于从仓库根运行文档命令。引擎测试使用仓库示例与独立夹具。

详见[建筑内容契约](buildings.md)。

## authoring 内部边界

建筑继续从 `blockwright` / `blockwright/authoring` 使用公共 API；原来的 `fields.ts`、`waters.ts`、`placement.ts` 导出保持兼容。内部按阶段定位实现：

推荐通过 `createScene` 组织新内容。`scene.ts` 只组合下表中的既有规划、施工与检查能力，不依赖内容发现、CLI、网格或世界写入。任意造型通过同一个 `BlockKit` 写入施工记录；`StructureKit` 用相同动作直接生成独立构件。材料回调只在规划时执行，提交应用已验证操作。构件返回的计划供后续几何引用，最终检查读取实际 `Structure`。

`model-checks.ts` 保存对象归属、解析后的状态和语义检查。后续显式场景操作接管被修改的格，仍保留道路通行、水体连续等语义检查；绕过场景直接修改造成的差异报告对象和坐标。返回原来的 `scene.world` 才保留这些检查，复制或合并体素不会自动转移检查记录。

| 职责 | 实现 | 依赖约束 |
|---|---|---|
| 带种子采样、场组合、权重选择和统计 | `terrain/fields.ts` | 纯计算，不加载施工、放置或碰撞检查 |
| 地形骨架、山体横断面与整地配方 | `terrain/recipe.ts` | 只依赖纯地形场，输出高度与统计接口 |
| 地形材料解析、挖填记录与提交 | `terrain/build.ts` | 复用 `construction.ts`，材料回调仍只在规划阶段执行 |
| 水段、列、端口与规则声明 | `water/contracts.ts` | 公共数据契约，供各阶段共享 |
| 水体几何与端口连接规划 | `water/plan.ts` | 不加载施工；表面查询仅为调用方提供的输入 |
| 容水边界、连续性与出入口复查 | `water/check.ts` | 读取最终模型与碰撞几何，不加载施工 |
| 河床、岸线、水体记录与提交 | `water/build.ts` | 复用施工计划，保持先床岸、后水体的写入顺序 |
| 对象归属、覆盖权限与保护区审计 | `placement/policy.ts` | `construction.ts` 与放置规划共用；不依赖地表投影或变换 |
| 候选变换与显式空气展开 | `placement/operations.ts` | 输出写入与挖除计划，由 `placement.ts` 做地形投影与提交 |

`Structure` 仍是唯一体素权威；拆分不建立新的世界容器、事务或缓存。内部实现引用具体阶段，避免经兼容入口重新加载完整施工链。`tests/engine/authoring-boundaries.test.ts` 检查这些运行时依赖方向；行为兼容还需检查最终逐格名称、状态、显式空气与写入顺序。

## 运行方式（为什么先编译）

`npm run build`（`tools/build.mjs` 和 `tools/tsconfig.build.json`）清理旧输出，用 **tsc** 把 `src/` 编译到 `dist/`，再复制注册表 JSON。之后 CLI 用纯 `node` 运行：

```
node dist/cli/index.js <command>
```

编译入口避免 CLI 运行时依赖 `tsx` / esbuild 的子进程与管道。npm 安装的 `bewright` 直接使用 `dist/cli/index.js`。

`dist/cli/index.js` 和实时预览 worker 启动时注册 `resolve-hooks.ts`。相对的 `.js` / `.mjs` 解析失败后改试 `.ts` / `.mts`。外置建筑找不到 `blockwright` 包时，回退到启动当前 CLI 的工具包。

`package.json` 用条件导出把类型与运行时分流：

```json
".": { "bewright-src": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" }
```

`npm test` 带 `--conditions=bewright-src`，让测试与建筑都走 `src/`，避免 src/dist 双实例导致 `instanceof` 失效。

## sidecar

Rust 程序在 `tools/blockwright-world/`，五个二进制：`blockwright-world`（写入）、`-export`（回读）、`-diagnose`、`-init`（新建世界）、`blockwright-java-export`。全部通过 `src/project/sidecar.ts` 调用，统一处理：

- 二进制从 `BLOCKWRIGHT_BIN_DIR`、工作区或工具安装目录解析。缺失时用 `bewright sidecar build` 构建工具包自带的 Rust 源码。
- stdin payload、UTF-8 stdout/stderr、非零退出码
- 最后一行 JSON 结果的解析与 `ok` 校验

`blockwright-world` 的直接写入由 `tools/blockwright-world/src/direct.rs` 按调色板下标读入方块记录。旋转或镜像单建筑时切换到 `bedrock-world` 库的 `write_to_world_blocking`，由库同步变换方块朝向。写入更新涉及的 subchunk、高度图（随 biome 记录）、`FinalizedState` 与必要的 `Version` 记录。

单建筑 Bedrock 导入会在创建存档前完成模型生成、墙状态推导、放置锚点和区域内方块状态校验。单建筑 Bedrock dry-run 只解析目标及批次，`--file` 放置先检查文件及锚点。初始化或写入阶段失败可能留下部分存档。

清单导入由 `cli/commands/import-layout.ts` 调度。各实例经坐标与方向状态变换后按清单顺序写入同一个 `Structure`。Bedrock 在组合结果上推导墙连接，再向直接写入器提交方块记录，跳过没有写入格的区块；已有世界写入前备份一次，新世界在临时目录写完后发布。Java 将组合模型交给同一套 Anvil 导出器，目标必须是新目录。清单 dry-run 会生成组合模型并校验目标方块。 [命令与覆盖规则](cli.md#用清单导入多个建筑)

源码打包沿用清单导入的建筑定位规则。打包器读取 manifest 和源码，递归解析入口的本地 ESM 引用，保留工作区相对目录结构，并为包根清单生成新的建筑路径。这个流程无需执行建筑入口或生成体素模型。[源码打包](cli.md#bewright-pack---layout-file)

## 项目与公共入口

`runBuild(loaded, { project: createProjectContext(root) })` 可显式选择产物与网格缓存的项目根；路径必须留在该根内，scenes/manifest 的相对路径也使用同一根。`fileRecord`、`manifest` 和 `describeBuilding` 支持对应上下文，manifest 的工具版本来自 BEWright 自身包。旧 `PROJECT_ROOT`/`ARTIFACT_ROOT`/`CACHE_ROOT`/`WORLD_ROOT` 和不传上下文的调用保持默认行为。

CLI 以当前工作目录作为工作区，用于发现内容、配置和写入产物。工具自己的运行时、浏览器依赖及 Rust 源码从工具安装目录解析。生成阶段缓存写入工作区，可读取工作区外的源文件作为指纹输入。程序化传入的 `ProjectContext` 用于指定构建输出，CLI 的其他工作区设置仍由进程当前目录决定。

## 产物与缓存边界

| 路径 | 内容 | 可重建 |
|---|---|---|
| 建筑的 `output/` | PNG、结构或本地世界。报告通过 `--report` 按需生成 | 截图、结构和报告可重建 |
| `artifacts/` | 历史交付和显式指定的输出 | 视文件内容而定 |
| `cache/meshes/<id>/` | 每区块一个压缩打包二进制 + `index.json` 索引 | 是 |
| `cache/generation/` | 建筑显式接入的生成阶段快照 | 是 |
| `worlds/` | 本地清单存档、隔离测试世界及备份 | 依据源码、清单及存档游玩记录判断 |
| `cache/cargo/` | Cargo 编译中间文件 | 是（`bewright sidecar build`） |
| `cache/sidecar/` | 当前安装的 Rust 二进制 | 是（`bewright sidecar build`），普通清理会保留 |
| `src/blocks/generated/` | 随源码交付的注册表 | `bewright registry generate` |

## 检查与目标边界

- `build` 默认执行标准模型诊断、场景注册的构件检查与建筑 `check()`；`check` 是只生成与检查的入口。命令退出码、跳过检查及结构格式选项见 [CLI](cli.md)。公共检查算子在最终 `Structure` 上检查保护区、支撑、通行与水段契约，建筑特有规则留在建筑中。
- 预览形状的盒体由 `shapes.ts` 定义；方块到模型的映射结合自动满方块判定、状态族规则与手写条目。覆盖情况用 `blocks --building <id> --report` 查询，不在文档固定数量。
- Bedrock 墙状态由 `blocks/connections.ts` 在导出或写入前按邻居推导，仅相对两向连接的直段降低柱头。Java 编码器独立推导连接；当前墙的 `up` 按连接方向数量判断，详见 [Java 语义边界](java-world-export.md#语义边界)，不能假定两版规则完全相同。
- 写入报告的 `placedBlocks` 是实际写入格数（含显式空气），`regionCells` 是包围盒体积。独立回读用于专项诊断：`registry verify` 检查编码器，世界逐格定位直接调用 sidecar；日常交付默认不回读。
- 模型检查、截图、编码与写入均不能替代客户端加载和玩家通行；按 [游戏验收](game-acceptance.md) 保存本次世界的证据。

## 测试布局

```
tests/engine/      引擎测试（IR、注册表、网格、相机、导出、sidecar、Java 转换、traversal）
tests/fixtures/  独立测试夹具
```

`npm test` 运行引擎测试，`npm run check` 先做类型检查再运行引擎测试。

### 群落施工边界

`vegetation.ts` 在统一施工的稀疏视图上规划树木、灌木和地被。物种生成器返回局部 `Structure` 构件，整株检查根部、连通性、实际占格、保护区和生境掩码后记录；后续层可读先前计划的树冠，最终一次提交。生成失败不留下部分植被。`woodland.ts` 仅组合默认构件、最终地表、生境与斑块场，不维护第二份世界；自定义物种仍可注入生成器。

### 水体网格

水体网格按相邻几何剔除内部面，包括跨 Chunk 邻接；不同水位保留未被完全覆盖的侧面，region 剖面显露裁切面。此优化不改变方块或流体状态。网格缓存版本已更新，旧缓存自动失效。透明材质保持双面显示，不能用全局单面渲染替代内部面剔除。
