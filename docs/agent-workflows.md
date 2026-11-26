# Agent 执行流程

命令从仓库根执行。先明确目标建筑与任务范围；只改文档时跳过环境安装、编译、生成和世界写入。

## 1. 准备与发现

```powershell
git status --short
node --version
# 缺少依赖时执行 npm ci；package.json 要求 Node >=23.6
# dist 缺失或 src 改动后执行：
npm run build
node dist/cli/index.js list --json
```

确定建筑 id 后再用 `list --detailed` 加载定义，查看参数和机位；普通 `list` 只发现清单。工具编译与建筑生成是两件事。全局安装不是前置条件，直接运行编译入口也能避免 launcher 额外启动子进程。

## 2. 生成与预览

将下面的 `demo-arch` 替换为目标 id；每次 build、preview、export/import 都传入相同的 `--param k=v`，这些命令会分别加载并生成模型，不会自动沿用上次参数。

```powershell
$buildingId = 'demo-arch'
node dist/cli/index.js build $buildingId
node dist/cli/index.js preview $buildingId --list
node dist/cli/index.js preview $buildingId --name review
node dist/cli/index.js blocks --building $buildingId --report
```

检查构建摘要和建筑目录 `output/previews/` 中的实际 PNG。需要保存详细构建检查时用 `build --report`。`build` 默认执行建筑 `check()`，普通预览、导入及 Java 导出不代替这一步。

需要持续迭代时，在单独终端启动：

```powershell
node dist/cli/index.js preview $buildingId --agent --port 4100
```

另一个终端读取状态并保存截图：

```powershell
Invoke-RestMethod http://127.0.0.1:4100/state
Invoke-WebRequest http://127.0.0.1:4100/screenshot -OutFile artifacts/agent-review.png
```

修改后先确认 `/state` 构建成功、revision 已更新，再截取当前模型；错误时服务可能保留上次成功画面。外观、入口、室内和玩家高度路线分别观察。机位与光照参数见 [CLI 接口](cli.md#agent-模式与脚本接口)。截图首次启动无头浏览器，返回 409 表示构建未就绪。

只改建筑文件会触发热更新；修改工具 `src/` 后重新 `npm run build` 并重启预览服务，不能仅靠 `--watch-path src` 保证使用新工具。结束后停止本次启动的服务。

## 3. 世界交付（仅在任务包含交付时）

先检查 `blockwright.config.json` 和相关环境变量，选择实际目标版本、存档根与唯一目录名。不要把配置中的个人路径复制成通用默认值。需要 Rust 写入器且 `cache/sidecar/` 缺失时运行 `node dist/cli/index.js sidecar build`。

Bedrock 新世界示例；原点、出生点需按建筑调整，下面坐标不是通用建筑推荐值：

```powershell
$worldFolder = 'BEWright-' + $buildingId + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
node dist/cli/index.js import $buildingId --new-world $worldFolder --folder $worldFolder --origin "0,64,0" --spawn "0,66,0" --dry-run
# 检查计划后，在本次任务已授权的目标执行同一命令，去掉 --dry-run。
```

默认直接从模型写世界，不需要先导出再传 `--file`。Bedrock `--origin` 对应放置区域最小点，x/z 需按 16 对齐；默认新世界出生点为 `0,-60,0`，不会自动使用建筑 `spawn`。旋转后的出生点也需按实际位置选择。

Java 新世界示例：

```powershell
node dist/cli/index.js export $buildingId --edition java --name $worldFolder --folder $worldFolder
```

Java 保留模型世界坐标，目标目录必须不存在；`import --edition java --world DIR` 也创建新世界，不追加。Java 导出没有 `--dry-run`；需要计划时使用 `import --edition java --dry-run`，并在正式执行时保持路径、名称等参数一致。详见 [Java 导出](java-world-export.md)。

多个建筑写入同一张地图时，准备 [导入清单](cli.md#用清单导入多个建筑)，通过 `import --layout FILE --dry-run` 核对实际组合范围和覆盖数量。正式写入时用 `--local --folder NAME` 生成隔离世界，或明确提供已有 Bedrock 存档路径。需要恢复其中一处时，复用同一清单，通过 `--world DIR --only ID` 重导该处。

需要机器可读写入结果时用 `--json`，需要保存导入记录时显式传 `--report FILE`。单建筑 Bedrock dry-run 只解析计划，单建筑 Java dry-run 会构建模型。清单 dry-run 会生成并校验组合模型。实机验收需在客户端加载世界。

## 4. 完成记录

交付时记录建筑 id、参数、源码版本（含未提交改动说明）、截图和实际世界路径，确保来自同一次模型版本。按 [游戏验收](game-acceptance.md) 分别记录两版结果。没有实机观察就写“游戏内未验证”，不要为补齐报告自动回读。

交付可编辑的多建筑地图时，用 `bewright pack --layout FILE` 生成源码 ZIP。在另一个目录解压，用包根的 `layout.json` 执行 `bewright import --layout ./layout.json --local --dry-run`，核对建筑实例、落点与组合范围。需要分享源码运行时读取的额外文件时，用 `--include` 收进包。[源码打包](cli.md#bewright-pack---layout-file)

## 故障定位

| 现象 | 下一步 |
|---|---|
| 找不到编译入口或工具行为仍旧 | `npm run build`，重新启动 CLI/预览 |
| 找不到建筑或重复 id | `list --json`，检查 manifest 与内容根；多个内容根是合并发现 |
| `spawn EPERM` | 区分 launcher、tsx/esbuild、浏览器或 Rust 子进程受限；CLI 优先直接运行 `dist/cli/index.js`，测试仍可能需要可启动子进程的环境 |
| 没有浏览器 | `--no-render` 仅生成网格；截图仍需安装浏览器或设置 `BROWSER_CHANNEL`，不能把网格当成视觉检查 |
| 修改后截图不变 | 查 `/state` 的 error/revision，再查监听目录；工具源码修改需重编并重启 |
| 洋红占位或无法导出 | `blocks --name <name>` 或 `blocks --building <id> --report`，逐项看注册表、预览、碰撞及版本转换 |
| 游戏正在运行、世界已存在 | 关闭对应游戏再写入，或选新的隔离目标；不自动使用 `--force` 或删除旧世界 |
| 实机方块或坐标异常 | 保留该次参数和报告；确需逐格定位时用 `cache/sidecar/` 下的 sidecar 回读已写入区域再与重建模型比对（[验收清单](game-acceptance.md)）；工具不再提供结构文件回读的 CLI 入口 |
