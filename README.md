# BEWright

Minecraft 程序化建筑工具链：**生成 → 预览 → 导出或写入 Java / Bedrock 世界**。

`src/` 包含引擎与 CLI。源码仓库提供 [拱门示例](examples/demo-arch/building.ts)，用于演示构建、检查和预览。自己的建筑可放进工作区，并以独立目录或布局 ZIP 分享。

## 在自己的目录使用

需要 Node.js 23.6 或更新版本。拿到 `bewright-0.0.1.tgz` 后，在自己的工作目录执行：

```powershell
npm init -y
npm install --save-exact "D:/downloads/bewright-0.0.1.tgz"
$bewright = './node_modules/bewright/dist/cli/index.js'
node $bewright init starter
node $bewright build starter
node $bewright preview starter --watch
```

已有建筑时，把整个目录放入工作区的 `buildings/`，或直接运行 `node $bewright build ../my-building`。加载建筑会执行目录中的 JS 或 TS，使用可信来源。每座建筑的预览、结构文件和本地世界集中在自己的 `output/`。分享时发送整个建筑目录即可。

在编辑器里编写 TypeScript 时，工作区可另装 `typescript` 和 `@types/node`，并使用 NodeNext 模块解析。

新建筑从 `bewright` 导入 API。使用原有 `blockwright` 导入名的建筑仍可由 `bewright` 加载。

写世界需要 Rust/Cargo 和本机 C/C++ 编译工具。单建筑使用 `import --local` 后，存档位于该建筑的 `output/bedrock-worlds/` 或 `output/java-worlds/`，可以复制到对应版本的游戏存档目录。

```powershell
node $bewright sidecar build
node $bewright import starter --local --dry-run
node $bewright import starter --local
```

分享工具时，从源码仓库执行 `npm ci` 和 `npm pack`。包带编译后的 CLI、类型声明和 Rust 写入器源码。分享单个建筑时，发送其目录和它依赖的共享模块即可。

## 将多个建筑放进一张地图

按下方链接将清单示例保存为 `tour.json`，也可以写入自己的建筑 ID、参数、落点和朝向。先用 `--dry-run` 查看生成范围和重叠，再执行导入。清单模式的 `--local` 把存档写到工作区的 `worlds/bedrock/` 或 `worlds/java/`。 [清单示例与参数](docs/cli.md#用清单导入多个建筑)

```powershell
node dist/cli/index.js import --layout tour.json --local --folder tour --dry-run
node dist/cli/index.js import --layout tour.json --local --folder tour
node dist/cli/index.js import --layout tour.json --world worlds/bedrock/tour --only east
```

最后一条只重导清单中 ID 为 `east` 的实例，写入前会备份 Bedrock 存档。重建整张地图时复用清单，换一个 `--folder` 生成新存档。使用安装包时，将示例中的 `dist/cli/index.js` 换为上面的 `$bewright`。

分享可编辑的地图源码时，运行 `node dist/cli/index.js pack --layout tour.json`。ZIP 包含清单、引用的建筑和可静态解析的本地模块，解压后可以修改并用 BEWright 重建。[源码打包](docs/cli.md#bewright-pack---layout-file)

## 在源码仓库开发

```powershell
npm ci
npm run build                         # 编译工具到 dist/，不生成建筑
node dist/cli/index.js list --detailed
node dist/cli/index.js build demo-arch  # 生成模型并执行检查，缓存预览网格
node dist/cli/index.js preview demo-arch --name demo-arch
```

`build` 默认只打印构建和检查摘要。需要 `.mcstructure` 时加 `--export`，要留报告时加 `--report`。世界写入按 [执行流程](docs/agent-workflows.md) 选择目标、原点与出生点。工具源码修改后重新编译，建筑 TS 在运行时加载。

## 能力

- **生成**：`Structure` / `Components` 体素模型、通用屋顶、树木、地形、水系、道路与施工计划。
- **创作**：`createScene` 共享地表、保护区与自动构件检查；常量材料直接传值，形状可通过回调替换。入门见 [开始创作](docs/authoring-guide.md)。
- **预览**：Three.js 交互预览与 Playwright 截图，支持组件选择、剖切、声明机位和可选简化光照。
- **导出**：Bedrock `.mcstructure` 及分片装配记录；Java Anvil 新世界。
- **写入**：从建筑模型或多建筑清单生成世界，支持追加已有 Bedrock 存档及按实例重导。
- **检查**：标准模型诊断、建筑自有 `check()`，以及注册表、预览、碰撞和目标状态转换的分项查询。

方块注册表目标固定为 Bedrock 1.21.60，Java 输出目标固定为 26.1.2 / DataVersion 4790。具体状态是否受支持，以 `node dist/cli/index.js blocks --name <name>` 的当前结果为准。

## 文档入口

Agent 从 [AGENTS.md](AGENTS.md) 开始；完整导航与各文档职责见 [文档索引](docs/README.md)。

新增建筑看 [内容契约](docs/buildings.md) 与 [公共创作能力](docs/authoring.md)；使用命令看 [CLI 参考](docs/cli.md)；修改工具看 [架构](docs/architecture.md)；交付世界看 [执行流程](docs/agent-workflows.md) 与 [游戏验收](docs/game-acceptance.md)。

## 目录结构

```text
src/          工具源码和 CLI
tools/        编译脚本和 Rust 写入器源码
examples/     可直接运行的拱门示例
tests/        引擎测试
docs/         使用和开发文档
```

工具运行时使用 `dist/` 和 `cache/`。建筑交付文件在各自的 `output/`，`artifacts/` 用于历史交付和显式指定的输出。`npm run build` 重新生成 `dist/`，`bewright clean` 可预览缓存的清理范围。

## 验证边界

`npm run check` 执行类型检查与引擎测试。模型检查、外观预览、世界写入和游戏验收分别记录。无头静态截图使用 SwiftShader，交互预览使用浏览器可用的 WebGL 后端。

预览不模拟完整游戏物理、流体更新或 Minecraft 材质包。缺少当前世界的实机证据时，状态保持“游戏内未验证”。
