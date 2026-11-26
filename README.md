# BEWright

Minecraft 程序化建筑工具链：**生成 → 预览 → 导出或写入 Java / Bedrock 世界**。

`src/` 包含引擎与 CLI。源码仓库提供 [拱门示例](examples/demo-arch/building.ts)，用于演示构建、检查和预览。自己的建筑可放进工作区，并以独立目录或布局 ZIP 分享。

## 快速开始

从 GitHub 克隆仓库。需要 Node.js 23.6 或更新版本。

```sh
git clone https://github.com/XiaoYangx666/BEWright.git
cd BEWright
npm ci
npm run build
node dist/cli/index.js build demo-arch
node dist/cli/index.js preview demo-arch --watch
```

打开预览命令打印的本地地址，即可查看仓库自带的拱门示例。需要导出 Bedrock 结构文件时，在构建命令末尾加 `--export`。

运行 `node dist/cli/index.js init starter` 可在 `buildings/starter/` 创建自己的建筑。已有建筑时，可以放入 `buildings/` 或向命令传入其目录路径。加载建筑会执行目录中的 JS 或 TS，使用可信来源。每座建筑的预览、结构文件和本地存档都放在自己的 `output/` 下。建筑可连同所需的共享模块一起分享。[创作入门](docs/authoring-guide.md)

## 写入世界存档

直接写入世界需要 Rust 写入器。先用 Rust/Cargo 和本机 C/C++ 编译工具构建写入器，再选择目标版本。

```sh
node dist/cli/index.js sidecar build
node dist/cli/index.js import demo-arch --local
node dist/cli/index.js import demo-arch --edition java --local
```

示例存档分别位于 `examples/demo-arch/output/bedrock-worlds/` 和 `examples/demo-arch/output/java-worlds/`，可以复制到对应版本的游戏存档目录。[世界写入流程](docs/agent-workflows.md)

## 将多个建筑放进一张地图

按下方链接将清单示例保存为 `tour.json`，也可以写入自己的建筑 ID、参数、落点和朝向。先用 `--dry-run` 查看生成范围和重叠，再执行导入。清单模式的 `--local` 把存档写到工作区的 `worlds/bedrock/` 或 `worlds/java/`。 [清单示例与参数](docs/cli.md#用清单导入多个建筑)

```powershell
node dist/cli/index.js import --layout tour.json --local --folder tour --dry-run
node dist/cli/index.js import --layout tour.json --local --folder tour
node dist/cli/index.js import --layout tour.json --world worlds/bedrock/tour --only east
```

最后一条只重导清单中 ID 为 `east` 的实例，写入前会备份 Bedrock 存档。重建整张地图时复用清单，换一个 `--folder` 生成新存档。

分享可编辑的地图源码时，运行 `node dist/cli/index.js pack --layout tour.json`。ZIP 包含清单、引用的建筑和可静态解析的本地模块，解压后可以修改并用 BEWright 重建。[源码打包](docs/cli.md#bewright-pack---layout-file)

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
