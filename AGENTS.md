# Agent 工作入口

本文件适用于整个仓库。先按用户指定范围工作，再按任务阅读下表中的文档；无需通读所有建筑或历史产物。

## 先定位任务

| 任务 | 最小阅读集合 |
|---|---|
| 新建或调整建筑 | [内容契约](docs/buildings.md) → [公共创作能力](docs/authoring.md) → 目标建筑的 manifest 与入口 |
| 预览、截图、调机位 | [执行流程](docs/agent-workflows.md) → [CLI 预览接口](docs/cli.md#agent-模式与脚本接口) |
| 写入或交付世界 | [执行流程](docs/agent-workflows.md) → [CLI](docs/cli.md)；Java 加读 [Java 导出](docs/java-world-export.md) |
| 修复工具 | [架构](docs/architecture.md) → 对应 `src/` 模块与 `tests/engine/` 测试 |
| 游戏验收 | [验收清单](docs/game-acceptance.md) |
| 仅修改文档 | [文档索引](docs/README.md)；按需只读源码核实行为，修改限于文档 |

## 工作约定

- 先检查 `git status --short`，保留已有改动。普通方案选择直接推进，不为已经授权的步骤重复请求确认。
- 命令从仓库根执行。推荐 `node dist/cli/index.js ...`，不需要全局 `npm link`；缺少编译产物或修改了 `src/` 时先 `npm run build`。
- `npm run build` 编译工具；`node dist/cli/index.js build <id>` 生成建筑。建筑 TS 在运行时加载，只改建筑通常无需重编工具。
- 仓库 README 的示例位于 `examples/demo-arch/`，用户建筑默认位于自己的 `buildings/<id>/`。使用 `bewright` 公共导出。不要向 CLI 增加建筑专用分支。用户要求原创时，不读取、复制或改造其他建筑作为设计来源。
- `Box`、`bounds`、`region` 与 `Structure.fill()` 是半开区间；authoring 的 `RectXZ` 是闭区间。显式空气会清除方块，VOID/未设置位置在 Bedrock 放置时保持原世界。
- 先查询具体状态的支持情况，不把预览几何支持等同于碰撞、导出或游戏支持。入口：`node dist/cli/index.js blocks --name <name>`。
- 默认不回读世界或结构文件，也不产出结构文件（`build --export` 才写）；`registry verify` 用于注册表与编码器的独立回读，世界级核验以进游戏为准（需要脚本化逐格比对时直接调用 `cache/sidecar/` 下的 sidecar）。
- 交付优先使用唯一命名的新世界。只在任务明确包含追加时写已有 Bedrock 世界；Java 始终创建新目录。不要用 `--force` 绕过正在运行的游戏，也不要把清理世界作为构建的附带步骤。
- 分别报告生成、外观预览、室内与通行、世界写入、实际游戏观察。没有当前世界的实机证据，就标记游戏内未验证；历史成功、静态检查、sidecar 成功都不能替代它。

## 外部副作用

- 只在本地或我们自己的 fork 改。未经用户当次明确授权，不向上游仓库 push、开 PR、开 issue 或发表评论。
- 上游依赖需要改动时，改 `XiaoYangx666/bedrock-world` fork，并把 `Cargo.toml` 的 `bedrock-world` 依赖 pin 到该 fork 的 commit；不向上游提 PR。
- 本地修复不代表上游需要，也可能不完整或不正确；是否上游化由用户 review 后决定。
- 绕过上游缺陷的改动放在本仓库（`tools/`、sidecar 等）或本地补丁里，并在说明中写明原因。

## 验证与完成

| 改动 | 验证范围 |
|---|---|
| 文档 | 检查相对链接、示例与当前实现的一致性、`git diff --check`、确认只改文档；不需要生成建筑或写世界 |
| 建筑 | 执行该建筑 `build`（含 `check()`），查看与改动相关的实际截图；按需跑建筑专项测试 |
| 工具源码 | 类型检查和相关测试；交付前运行 `npm run check`，重新编译后验证受影响 CLI 行为 |
| 世界交付 | 保存实际目标路径和命令结果；按用户要求完成对应版本的加载验收 |

遇到 `spawn EPERM` 先检查子进程/沙箱限制，不直接认定是代码回归。运行时问题见 [执行流程](docs/agent-workflows.md)。完成时说明改动、验证结果、产物位置和未完成的验收项，不把计划当成结果。
