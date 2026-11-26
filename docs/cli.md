# CLI 参考

先把工具编译成 `dist/`，之后用纯 `node` 运行（不依赖 `tsx`/esbuild）：

```powershell
npm run build
node dist/cli/index.js <command> [options]  # 仓库内推荐，不需要全局安装
# 可选 npm link 后使用 bewright
```

`bewright` 直接执行 `dist/cli/index.js`。在源码仓库使用前先执行 `npm run build`。
`npm link` 是指向本仓库的全局符号链接，无需反复 link；修改工具 `src/` 后仍需重新 `npm run build`，常驻预览需重启。建筑 TS 在运行时加载。

`bewright` 是安装后的命令。源码示例使用编译入口。源码仓库自带的 `demo-arch` 支持 `height` 参数、`front` 机位及 `arch` 和 `base` 组件。

安装包用户从自己的工作区运行 `node ./node_modules/bewright/dist/cli/index.js <command>`。工作区是执行命令的目录。接受 `<building>` 的命令可传 id、目录路径（例如 `./my-building`）或清单路径。

## `bewright init [id]`

在当前目录下建立 `buildings/<id>/`，包含最小清单和 `building.mts`。默认 id 为 `starter`，可用 `--name` 指定显示名称。首次运行时，如果没有 `.gitignore`，会创建一份用于排除本地配置和生成目录。建筑目录已存在时退出，保留已有文件。

## `bewright list`

列出所有内容根里发现的建筑。

```powershell
node dist/cli/index.js list                # id / name / editions / 来源 / 路径
node dist/cli/index.js list --detailed         # 额外加载入口，显示 views 与 params
node dist/cli/index.js list --json
node dist/cli/index.js list --content D:\mc-buildings
```

## `bewright check <building>`

只做**生成 + 检查**：不网格化、不截图、不导出、不回读、不写世界。这是最快的静态闸门，`bewright build` 内部走的是同一条检查链路，所以两者检查的永远是"那一次生成的模型"。

```powershell
node dist/cli/index.js check demo-arch
node dist/cli/index.js check demo-arch --json --report cache/reports/arch-check.json
node dist/cli/index.js check demo-arch --outline            # 逐条打印规则
node dist/cli/index.js check demo-arch --strict             # 警告也算失败
node dist/cli/index.js check demo-arch --no-check           # 跳过构件与建筑检查，标准模型规则照跑
```

| 选项 | 说明 |
|---|---|
| `--param k=v` | 覆盖建筑参数（可重复） |
| `--no-check` | 跳过场景注册的构件检查与建筑自己的 `check()`；标准模型诊断仍然执行 |
| `--strict` | 把警告（例如未确认的预览几何）也算作失败 |
| `--json` | 输出机器可读报告 |
| `--report FILE` | 额外把 JSON 报告写到项目内路径 |
| `--outline` | 逐行打印每条诊断，而不是摘要 |

**退出码**：`0` 通过 · `1` 检查失败或报出错 · `2` 用法/配置错误（建筑不存在、参数非法）。「检查未执行」永远不会是 `0`。

报告里 `stages` 明确写出这次真正执行了什么（`generate` / `model` / `buildingCheck` / `mesh` / `screenshot` / `export` / `readback` / `world`），没跑的阶段是 `false`，不会被当成通过。

## `bewright build <building>`

生成模型、缓存视图网格并执行场景构件与建筑检查。默认打印一行摘要。`--export` 把 Bedrock 结构文件放在建筑的 `output/bedrock/`，超出单文件上限时按声明的分片方案输出。

正常流程**不做任何回读验证**；标准模型诊断、场景构件检查与建筑 `check()` 构成静态检查阶段。`createScene` 的构件会自动注册检查，无需另写建筑 `check()`。检查与 `bewright check` 共用同一执行机制，**不会重复生成模型**。

```powershell
node dist/cli/index.js build demo-arch
node dist/cli/index.js build demo-arch --param height=6
node dist/cli/index.js build demo-arch --report --out artifacts/arch-build --param height=6
node dist/cli/index.js build demo-arch --export            # 需要结构文件时才加
```

| 选项 | 说明 |
|---|---|
| `--param k=v` | 覆盖建筑参数（可重复） |
| `--out DIR` | 产物目录覆盖 |
| `--cache DIR` | 网格缓存目录覆盖 |
| `--export` | 额外导出 Bedrock 结构文件：`<id>.mcstructure`；声明了 `tiles` 时写分片与 `assembly.json` |
| `--structure-version 1\|2` | `.mcstructure` 布局版本，默认 `1`；`2` 用 IntArrayTag 存 `block_indices` 并省略空的第二层，实际大小随模型变化，需要 Bedrock 26.50（1.26.50）及以上才能加载 |
| `--no-check` | 跳过场景注册的构件检查与建筑自己的 `check()` |
| `--strict` | 把检查警告也算作失败 |
| `--json` | 输出完整报告 |
| `--report` | 写入 `scenes.json`、`report.json` 和 `manifest.json`，默认放在 `output/diagnostics/`，与 `--export` 同用时放在结构目录 |

退出码：0 构建完成且无阻断诊断 / 1 检查失败 / 2 用法错误。建筑未声明检查或传入 `--no-check` 时仍可返回 0，检查状态以终端摘要或 `--json` 中的 `check` 字段为准。网格缓存在 `cache/meshes/<id>/`。

报告里的诊断分为模型、建筑检查和预览：`modelDiagnostics`（模型不变量）、`buildingDiagnostics`（建筑检查，含对象与坐标）、`previewDiagnostics`（洋红占位几何等预览问题）、`diagnosticsUnified`（三者合并）；`check.diagnostics` 保存检查的完整结论。`diagnostics` 字段保留旧的预览网格诊断形状以兼容既有读者。

## `bewright preview <building>`

渲染无头 PNG 到建筑的 `output/previews/`，每个视图输出一条路径。`--no-render` 只生成内存网格。

静态预览的网格只留在内存里发给渲染器，不写磁盘：同一次命令里内容相同的视图（例如只差机位的全模型视图）复用同一份网格，所有视图共用一次浏览器进程。

```powershell
node dist/cli/index.js preview demo-arch --name demo-arch
node dist/cli/index.js preview demo-arch --list                  # 列出建筑声明的视图
node dist/cli/index.js preview demo-arch --view-name front       # 用声明视图的机位与配色
node dist/cli/index.js preview demo-arch --all-views           # 一次渲染所有声明视图
node dist/cli/index.js preview demo-arch --focus arch --cut y:5 --name arch-cut
node dist/cli/index.js preview demo-arch --isolate arch --name arch-only
node dist/cli/index.js preview demo-arch --hide arch --name arch-base
node dist/cli/index.js preview demo-arch --view top --name arch-top
node dist/cli/index.js preview demo-arch --param height=6 --name tall-arch
```

| 选项 | 说明 |
|---|---|
| `--list` | 列出建筑声明的视图（名称/视角/机位/配色键）后退出 |
| `--out DIR` | 覆盖 PNG 输出目录 |
| `--report` | 保存静态预览诊断和渲染数据 |
| `--view-name <name>` | 使用声明视图：其 region、相机（view/direction/eye/target/fit）与 style |
| `--all-views` | 渲染全部声明视图，产物名即视图名。同一个模型只生成一次、只差机位的视图只网格化一次，全部视图共用一次浏览器；不写任何磁盘缓存 |
| `--focus <id>` | 按组件取景，保留附近上下文 |
| `--isolate a,b` | 只显示指定组件 |
| `--hide a,b` | 隐藏指定组件 |
| `--padding N` | focus 上下文宽度，默认 3 |
| `--cut axis:max` | 保留 `axis < max` |
| `--slice axis:min:max` | 保留 `min <= axis < max` |
| `--view iso\|top\|front\|side` | 未用声明视图时的临时相机 |
| `--style natural\|contrast` | 预览配色；声明视图的 style 会叠在其上 |
| `--name <slug>` | 产物名，默认 `preview` |
| `--width/--height N` | 视口尺寸，默认 1280×960 |
| `--no-render` | 只生成网格，不启动浏览器 |
| `--check` | 静态预览执行当前主模型检查，红框标错误、黄框标未知/警告，选区外不显示；不支持 watch/agent 或其他生成函数的视图 |
| `--light` | 启用方块光与天空光传播；**默认关闭**，开关会改变光照通道与着色 |
| `--ambient N` | 光照环境亮度下限，默认 0.18（范围 0–0.9） |
| `--exposure N` | 光照整体亮度倍率，默认 1（范围 0.4–2.5） |
| `--curve N` | 光照衰减曲线指数，默认 1.45（范围 0.6–3） |
| `--day N` | 天空光白天系数，默认 1（0=夜晚，1=正午；范围 0–1） |
| `--agent` | 常驻 agent 模式：等同 `--watch`，但页面无人用面板，且服务端机位与截图可脚本化 |
| `--watch` | 常驻交互预览；打印本机 URL，监听源码并局部更新网格 |
| `--port N` | 常驻预览端口；默认 0 自动选择空闲端口 |
| `--watch-path <目录>` | 额外监听共享源码目录，可重复；需要 `--watch` |

组件参数（`--focus/--isolate/--hide`）只对返回 `Components` 的建筑有效。浏览器默认用已安装的 Chrome；用 `BROWSER_CHANNEL=msedge` 或 `chromium` 切换，或先 `npx playwright install chromium`；无浏览器时用 `--no-render`。

常驻模式示例：`node dist/cli/index.js preview demo-arch --watch --port 4100 --view-name front`。
页面的机位下拉框可直接切换同一模型的声明机位和四个全景方向，不重新生成或下载网格。
需要不同 `build` 或裁切区域的声明视图会禁用并提示单独加载，避免把另一模型的机位误用于当前画面。
“开始巡览”会在可用机位之间平滑切换并停留；鼠标操作、Esc、窗口失焦会停止巡览。
WASD 前后左右移动，Q/E 升降，Shift 加速；速度滑块控制移动速度。这是观察移动，不做碰撞限制。
可命名保存最多 50 个机位、删除自存机位，并保存当前画面的 PNG；机位存放在当前浏览器本地。
“方块支持情况”展示当前区域实际出现的状态、数量和各环节结果，悬停查看具体原因，点击坐标定位示例方块。
打开输出的 `http://127.0.0.1:4100/`，拖动旋转、右键平移、滚轮缩放。热更新保留当前机位，
同一浏览器和端口刷新页面也会恢复机位；“重置机位”回到声明视图。按 Ctrl+C 停止服务。
常驻页面使用浏览器可用的 WebGL 后端，不强制软件渲染；打开页面无需启动 Playwright，服务端截图会按需启动它。

默认递归监听该建筑目录内的 JS/TS/JSON。目录外的辅助代码需要 `--watch-path ./shared`。
每次重新启动短生命周期的生成进程，确保辅助模块不会因 ESM 缓存而过期；**模型仍全量生成**，
网格和浏览器几何体按区块增量更新。比较方块语义而非临时材质编号，修改影响的区块及相邻区块
才重新网格化；区域或配色变化会重新生成网格。区块数据直接从内存提供，每区块一个二进制请求，
没有逐区块磁盘文件。生成或网格失败时保留上次成功画面，修复源码后自动恢复。

`--watch` 选择一个视图，不支持组合 `--all-views`、`--list`、`--no-render`。静态 PNG 预览是另一条路径
（见上一节）：网格只在内存里交给渲染器，不落盘，也不需要常驻服务。日志的 `meshMs` 包含区块比较、
网格与打包，`lightMs` 为本次光照修复，`totalMs` 还包含生成进程及模型传输；这些都不是游戏帧率或
浏览器显示耗时。

### agent 模式与脚本接口

`node dist/cli/index.js preview <building> --agent --port 4100` 启动常驻服务，页面隐藏人工面板，
机位与光照完全由接口驱动。以下接口在 `--watch` 与 `--agent` 下都可用：

```powershell
# 状态：revision、status、error、views、support、metrics、lighting（含 day）、light、agent、pose、chunks 版本
Invoke-RestMethod http://127.0.0.1:4100/state

# 光照参数（实时生效，不重建）；light 字段切换光照传播（触发一次重建）
Invoke-RestMethod http://127.0.0.1:4100/lighting -Method Post `
  -Body '{"ambient":0.05,"curve":2}' -ContentType 'application/json'
Invoke-RestMethod http://127.0.0.1:4100/lighting -Method Post `
  -Body '{"light":true}' -ContentType 'application/json'

# 服务端机位：所有页面（含截图）跟随此视角
Invoke-RestMethod http://127.0.0.1:4100/camera -Method Post `
  -Body '{"eye":[113,178,78],"target":[98,70,110]}' -ContentType 'application/json'

# 截图：返回 PNG；可选 eye/target/ambient/exposure/curve/day/width/height，
# eye 缺省用当前机位；构建未就绪返回 409。首次调用会按需启动无头浏览器。
Invoke-WebRequest "http://127.0.0.1:4100/screenshot?eye=113,178,78&target=98,70,110&day=0.15&width=1280&height=960" -OutFile shot.png
```

agent 的完整闭环：改建筑源码 → 服务自动增量重建（耗时取决于模型与环境）→
`POST /lighting` 调氛围（零重建）→ `POST /camera` 取景 → `GET /screenshot` 自查 → 再改。
`/screenshot` 需要本机安装 Chrome（或 `BROWSER_CHANNEL` 指定通道）；仅运行服务与交互页面不会启动 Playwright。

### 预览光照

预览**默认不做光照**（平色、最快）。加 `--light` 或 `POST /lighting {"light":true}` 启用后，
计算两通道逐格光：**方块光**由萤石、灯笼等光源按注册表 `emitLight` 向外传播（空气每格衰减 1，
实心方块挡光，透光材质按 `filterLight` 衰减；营火熄灭、蜡烛未点燃、海泡菜死亡等状态例外不发光）；
**天空光**按高度图从上向下灌满露天格子（穿水与树叶按过滤值衰减），再从露天与阴影的交界向
屋檐、门洞、室内横向衰减。着色器取 `max(方块光, 天空光 × 白天系数)`，"白天"滑块在 0（夜晚）
到 1（正午）之间实时切换。方块光按变化增量修复；不透明度改变时重算受影响区块列及两圈邻列的天空光，区块拓扑改变时回退到完整计算。这是简化模型：没有材质纹理与体积光，用于判断明暗分布、屋檐阴影和
补灯位置，不等同游戏内画面。"环境亮度"不是天空光，它是预览专用的最低可见度下限
（类似游戏里的亮度/γ 设置）：遮光建筑（如封顶深井）的天空光本来就该是 0，井内亮度
只由光源加这个下限决定，想要深渊感就把环境亮度压到 0–0.05。

启用后可调（均不触发网格重建）：

- 常驻页面滑块：环境亮度、曝光、衰减、白天，实时生效；
- URL 参数携带初始值：`http://127.0.0.1:4100/?ambient=0.05&exposure=1.2&day=0.3`；
- 供 agent 与脚本使用的 HTTP 接口，改动即时同步到所有打开的页面：

```powershell
Invoke-RestMethod http://127.0.0.1:4100/lighting
Invoke-RestMethod http://127.0.0.1:4100/lighting -Method Post `
  -Body '{"ambient":0.05,"exposure":1.1,"day":0.3}' -ContentType 'application/json'
```

- 静态 PNG 用 `--light --ambient/--exposure/--curve/--day` 定格参数（不带 `--light` 即关闭）。

光照关闭时跳过光场计算；启用后首次构建计算完整光场。调亮度参数不重建网格，开关光照传播会触发重建。耗时随模型和运行环境变化；调整模型后可查看实时预览的 `/state`，其中记录光照和网格耗时。

浏览器回归测试（先 `npm run build`，安装 Chrome）：
`$env:BLOCKWRIGHT_LIVE_BROWSER_TEST='1'; node --conditions=bewright-src --import tsx --test tests/engine/live-preview-browser.test.ts`。
可用 `BLOCKWRIGHT_BROWSER_CHANNEL` 指定另一个已安装的 Playwright 浏览器通道。

## `bewright export <building> --edition bedrock|java`

```powershell
node dist/cli/index.js export demo-arch --edition bedrock --output out/demo-arch.mcstructure
node dist/cli/index.js export demo-arch  --edition java --name "拱门" --seed 71329
```

- `bedrock`：默认写到建筑的 `output/bedrock/`，`--output` 可直接指定单文件路径。`--structure-version 1|2` 选结构布局版本，默认 `1`。`2` 使用 IntArrayTag，可省略空第二层，要求 Bedrock 26.50（1.26.50）及以上。
- `java`：默认在建筑的 `output/java-worlds/<id>/` 生成 Anvil 存档。`--output` 指定世界目录，或用 `--worlds-dir` 指定 saves 目录。用 `--folder` 可另存一个版本。

导出默认只打印结果路径。`--json` 输出机器可读结果，Bedrock 的 `--report` 可保存构建元数据。

Java `export` 不执行 `check()`，且没有 `--dry-run`；Java 计划请用 `import --edition java --dry-run`，验收直接在客户端加载。

## `bewright import <building> --edition bedrock|java`

写入 Bedrock 世界（新建或追加），或导出 Java 存档。

```powershell
node dist/cli/index.js import demo-arch --new-world "验收世界"
node dist/cli/index.js import demo-arch --world worlds/test/existing --origin "0,64,0" --dry-run
node dist/cli/index.js import --file examples/demo-arch/output/bedrock/demo-arch.mcstructure --world worlds/test/existing
node dist/cli/index.js import demo-arch --edition java --new-world "拱门验收"
node ./node_modules/bewright/dist/cli/index.js import ../my-arch --local --dry-run
node ./node_modules/bewright/dist/cli/index.js import ../my-arch --local
```

> PowerShell 会把裸写的 `0,64,0` 拆成三个参数，坐标一律加引号：`--origin "0,64,0" --spawn "0,-59,0"`。
> 值以负号开头时（例如 `--origin "-256,0,-256"`）解析器会把它当成下一个选项，改用等号形式：`--origin="-256,0,-256"`。

| 选项 | 说明 |
|---|---|
| `--world DIR` | Bedrock：追加已有世界并备份；Java：指定新世界输出目录，必须不存在 |
| `--local` | 单建筑使用其 `output/bedrock-worlds/` 或 `output/java-worlds/`。清单模式使用工作区的 `worlds/bedrock/` 或 `worlds/java/`。仅提供 `--file` 时使用工作区的 `worlds/bedrock/` |
| `--worlds-dir DIR` | 新世界所在的根目录：Bedrock 为 `minecraftWorlds`，Java 为 `saves` |
| `--new-world NAME` | 新世界显示名 |
| `--folder NAME` | 新世界文件夹名 |
| `--origin x,y,z` | Bedrock 放置原点。默认 `0,64,0`，使用 `--local` 时默认 `0,-60,0`。x/z 必须为 16 的倍数 |
| `--spawn x,y,z` | 新世界出生点。Java 默认取建筑声明。Bedrock `--local` 在未旋转且有可用的建筑出生点时换算坐标，否则在平地上从原点向西两格出生。Bedrock 其他模式默认 `0,-60,0` |
| `--rotation 0\|90\|180\|270` / `--dimension 0\|1\|2` | Bedrock 放置旋转与目标维度；镜像仅公共写入 API 支持，CLI 无 `--mirror` |
| `--file FILE` | 直接放置已有 `.mcstructure`；sidecar 只接受布局版本 1（v2 文件请用 `--structure-version 1` 重新导出，或改用不带 `--file` 的直接写入） |
| `--only ID[,ID...]` | 清单模式：只写入选中的放置项，可重复或逗号分隔 |
| `--except ID[,ID...]` | 清单模式：排除放置项，可与 `--only` 组合 |
| `--backup-dir DIR` | 写入已有世界前把整档备份到 DIR，默认放在世界同级的父目录 |
| `--skip-verify` | 跳过写入后的逐格回读与存档保留报告（默认执行） |
| `--dry-run` | 预演并打印 JSON。单建筑 Bedrock 只解析放置计划，清单模式会生成并校验组合模型 |
| `--json` | 输出完整写入结果，默认只打印世界路径 |
| `--report FILE` | 保存写入记录到指定文件 |
| `--force` | Minecraft 正在运行时仍继续 |

单建筑 Bedrock 正式导入会在创建新世界前生成模型、推导墙状态并校验写入方块和锚点。初始化或写入阶段失败可能留下部分存档。`--file` 提前检查文件和锚点。单建筑 Java 的 `--dry-run` 会生成模型，正式写入时才编码。

单建筑 Bedrock 导入按 `tiles.placement.batchSize` 的 X/Z 边长分批写入。Bedrock 的 JSON 结果用 `placedBlocks` 统计实际写入格数，含显式空气。`regionCells` 是写入器放置包围盒的体积，含未设置格。 [分片契约](buildings.md#分片-tiles)

单建筑 Java 导入保留模型坐标。需要执行建筑 `check()` 时，先对所用建筑运行 `build`。

> 单建筑导入**默认不回读**：写入完成后直接进游戏验收。世界表现异常（方块缺失、围栏/墙连接不对等）需要逐格定位时，用 `cache/sidecar/` 下的 sidecar（如 `blockwright-world-export` / `blockwright-world-diagnose`）把区域回读后自行比对。
>
> 清单模式写入**已有 Bedrock 世界**时默认对比：`worldOverwrites` 列出目标格当前方块与模型不一致的情况（按方块名统计，`matched` 为已经一致的格数，空气不计入覆盖），`verification` 给出写入后的逐格回读，`preservation` 对比 `level.dat` 哈希与玩家记录键。写入时这两份报告来自同一次写入：覆盖统计在写入器读取待合并区块时顺手完成，校验在每批提交后回读该批区块。`--dry-run` 只做分析、不写入；`--skip-verify` 只跳过回读。对比全程不导出 `.mcstructure`，写入前世界必须处于关闭状态。

### 用清单导入多个建筑

把建筑及其落点写到仓库根目录的 `tour.json`：

```json
{
  "name": "双拱门游览",
  "spawn": [14, -59, 3],
  "seed": 7,
  "placements": [
    { "id": "west", "building": "demo-arch", "origin": [10, -60, 2] },
    { "id": "east", "building": "demo-arch", "origin": [96, -60, 7], "rotation": 90 }
  ]
}
```

- `name` 和 `spawn` 必填，`seed` 默认是 0。新世界可以用 `--new-world`、`--spawn` 和 `--seed` 覆盖这些值。
- `id` 是清单中唯一的放置名称，可用重复的 `--only ID` 或逗号列表 `--only a,b` 选中多项，仍按清单顺序执行；`--except a,b` 排除放置项。`building` 可填建筑 ID、相对于清单的建筑目录或 manifest 路径。`params` 可选，格式为 `{"参数名": 值}`。
- `origin` 是旋转后放置边界的最小坐标。x/z 使用 32 位整数，一格为单位。`rotation` 为 0、90、180 或 270，俯视顺时针，默认 0。清单写入主世界，Y 范围为 -64 到 319。Bedrock 使用建筑声明的放置区域，Java 使用建筑的 `bounds`。
- 后列建筑的已设置格覆盖前列建筑或存档里的对应格。未设置的位置保留原方块，显式空气会清除方块。加 `--skip-air` 可忽略所有显式空气。重新导入会应用当前源码写出的方块，缩小建筑后若要清理旧方块，需在源码中为旧位置明确写入空气。

```powershell
node dist/cli/index.js import --layout tour.json --local --folder tour-test --dry-run
node dist/cli/index.js import --layout tour.json --local --folder tour-test
node dist/cli/index.js import --layout tour.json --world worlds/bedrock/tour-test --only east
node dist/cli/index.js import --layout tour.json --world /path/to/existing --only cafe,promenade,poolrooms --backup-dir /data/backups --dry-run
node dist/cli/index.js import --layout tour.json --local --folder tour-rebuilt
node dist/cli/index.js import --layout tour.json --edition java --local --folder tour-java
```

清单的 `--dry-run` 会生成组合模型。每项的 `overlaps` 统计覆盖前列实例的格数，顶层的 `explicitAir` 统计最终模型里的显式空气。已有 Bedrock 存档在写入前整档备份一次，写入失败时错误会给出备份路径。Java 需要新存档目录。首次使用清单写入 Bedrock 时，先运行 `node dist/cli/index.js sidecar build` 更新写入器。

## `bewright pack --layout FILE`

从地图清单生成可编辑的源码 ZIP。包内的 `layout.json` 保留位置、旋转、参数、出生点和种子，并使用相对于包根的建筑路径。`source/` 保留建筑目录、目录内的资源，以及入口递归引用的本地 ESM 模块路径。`README.md` 给出重建命令。

```powershell
node dist/cli/index.js pack --layout tour.json
node dist/cli/index.js pack --layout tour.json --output artifacts/tour.zip --include ./shared/data
```

| 选项 | 说明 |
|---|---|
| `--output FILE` | ZIP 路径，默认 `artifacts/<清单名>-source.zip`。清单名为 `layout.json` 时取所在目录名 |
| `--root DIR` | 包中源码路径的基准目录，默认当前工作区。建筑和本地引用须位于这个目录内 |
| `--include PATH` | 额外文件或目录，可重复。用于代码运行时读取的外部资源、计算得到的模块路径等 |
| `--content DIR` | 额外的建筑发现根，可重复 |
| `--json` | 打印路径、实例数、建筑数、包体积和识别到的外部模块引用 |

建筑的 `output/`、`node_modules/`、本机配置和环境文件不会进入 ZIP。包会保留 Node 的模块类型。如果源码依赖自定义包导入别名或额外的 npm 依赖，可以用 `--include` 补充所需的包配置和文件，接收方在构建前安装所需依赖。

解压后，修改 `source/` 里的建筑源码，或在包根的 `layout.json` 调整摆放位置。接收方从包根运行以下命令。使用本地安装时，可以把 `bewright` 换成 `node <BEWright 安装目录>/dist/cli/index.js`。

```powershell
bewright import --layout ./layout.json --local --dry-run
bewright sidecar build
bewright import --layout ./layout.json --local --folder tour-rebuilt
```

写入存档时需要对应版本的 Rust 写入器。已构建写入器的工作区可以跳过 `bewright sidecar build`。

## `bewright blocks`

```powershell
node dist/cli/index.js blocks --search log --limit 10
node dist/cli/index.js blocks --report  # 写 artifacts/block-coverage.json
node dist/cli/index.js blocks --name oak_stairs --states '{"weirdo_direction":2,"upside_down_bit":true}'
node dist/cli/index.js blocks --building demo-arch --report
```

`--name` 使用固定注册表默认值补全省略的状态；非法状态也会列出失败原因。
`--building` 检查建筑实际放置的完整状态，不包括没有使用的调色板条目，附带数量与示例坐标；
支持 `--content` 和 `--param`。`--report` 将结果保存到 `artifacts/block-coverage.json`。
普通 `blocks --search` 查询也会在每个默认方块中附上 `support`。

结果分别列出注册表校验、`material()` 简便选材、预览几何、通行碰撞、基岩状态编码和 Java 状态转换。
各列直接调用当前实现，不维护额外的支持白名单。简便选材失败不会被当作预览失败；
Java 的 `mapped` 仅表示转换器接受该状态，不表示客户端兼容性已经验收。
基岩编码支持也不包含方块实体数据、世界写入或游戏内验证。

## `bewright registry generate|verify`

```powershell
node dist/cli/index.js registry generate           # 从 minecraft-data 重建 src/blocks/generated/bedrock-registry.json
node dist/cli/index.js registry verify             # 导出 gallery + 全部默认状态（v1/v2 各一份）并独立回读
```

## `bewright sidecar build`

```powershell
node dist/cli/index.js sidecar build               # 用 Cargo 编译工具自带的 Rust 源码，安装到工作区 cache/sidecar/
node dist/cli/index.js sidecar build --debug
```

## `bewright clean`

默认 dry-run。`--apply` 会实际删除；仅在清理属于当前任务范围、已核对目标路径时使用，尤其是包含游戏存档的 `--game`。

```powershell
node dist/cli/index.js clean               # 统计可重建缓存和 artifacts/ 内超过 24 小时的临时文件
node dist/cli/index.js clean --apply       # 清理上述范围
node dist/cli/index.js clean --artifacts --apply
node dist/cli/index.js clean --worlds      # 另外列出本地世界和备份
node dist/cli/index.js clean --sidecar     # 另外列出已编译的 Rust 写入器
node dist/cli/index.js clean --game --keep 1
```

普通 `clean` 保留 `cache/sidecar/` 下的写入器，Cargo 中间文件可重新编译。`--game` 只识别带有效 BEWright 创建标记的世界。清掉网格缓存后，需要使用旧网格的脚本可重新运行 `build`。

## 工作区配置

`blockwright.config.json` 可以提交并共享。机器专用的存档路径可记在同目录的 `blockwright.local.json`，由工作区的 Git 忽略规则排除。本地配置按版本覆盖 `worldDirectories`，并可覆盖 `contentRoots`。`BLOCKWRIGHT_CONFIG` 可直接指定一份配置。配置内的相对路径从该文件所在目录解析。

## 环境变量

| 变量 | 作用 |
|---|---|
| `BLOCKWRIGHT_CONTENT_PATH` | 额外内容根，系统路径分隔符分隔 |
| `BLOCKWRIGHT_CONFIG` | 配置文件路径，默认 `blockwright.config.json` |
| `BLOCKWRIGHT_WORLDS_DIR` | Bedrock 存档根的兼容变量；专用变量优先 |
| `BLOCKWRIGHT_JAVA_WORLDS_DIR` | Java `saves` 目录 |
| `BLOCKWRIGHT_BEDROCK_WORLDS_DIR` | Bedrock `minecraftWorlds` 专用存档根 |
| `BLOCKWRIGHT_BIN_DIR` | 指定写入器二进制目录，覆盖工作区与工具自带的 `cache/sidecar/` 查找 |
| `BROWSER_CHANNEL` | `chrome` / `msedge` / `chromium` |
| `BLOCKWRIGHT_DEBUG` | 打印错误堆栈 |

Windows PowerShell 下推荐直接用 `node dist/cli/index.js ...`；需要调用全局启动器时可使用 `bewright`。
