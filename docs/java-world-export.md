# Java 版存档导出

BEWright 可以把内存中的 `Structure` 导出为一个新的 Minecraft Java 版世界目录。当前目标固定为 Java 26.1.2（DataVersion 4790），输出包含 `level.dat`、`level.dat_old`、`session.lock`、`data/minecraft/world_gen_settings.dat` 和 `dimensions/minecraft/overworld/region/*.mca`。

## 存档目录配置

工作区的 `blockwright.local.json` 可保存两个版本的本机存档根目录：

```json
{
  "worldDirectories": {
    "java": "D:\\Minecraft\\saves",
    "bedrock": null
  }
}
```

`bedrock: null` 表示继续自动发现当前 Windows 用户的默认 Bedrock `minecraftWorlds`。Java 可用 `BLOCKWRIGHT_JAVA_WORLDS_DIR` 覆盖，Bedrock 可用 `BLOCKWRIGHT_BEDROCK_WORLDS_DIR` 覆盖；旧的 `BLOCKWRIGHT_WORLDS_DIR` 仍兼容 Bedrock。

## 使用

先构建 Rust sidecar：

```powershell
node dist/cli/index.js sidecar build
```

命令行导出（推荐）：

```powershell
node dist/cli/index.js export demo-arch --edition java --name "拱门" --seed 71329
node dist/cli/index.js import demo-arch --edition java --world "D:\Minecraft\saves\NewWorld"  # 目录必须不存在
node dist/cli/index.js import demo-arch --edition java --local  # 写到建筑的 output/java-worlds/
```

独立导出默认保存在建筑的 `output/java-worlds/<id>/`。`--world` 在 Java 分支表示新输出目录。

多个建筑生成一个 Java 存档时，用 `import --layout tour.json --edition java --local --folder tour-java`。各建筑的落点、朝向和世界出生点取自清单。此命令将存档写到工作区的 `worlds/java/tour-java/`。 [清单格式](cli.md#用清单导入多个建筑)

需要集成公共 API 时可直接调用（下面的 `scene.js` 属于调用方模块）：

```ts
import { exportJavaWorld } from 'bewright';
import { build, BOUNDS } from './scene.js';

const world = build();
const result = await exportJavaWorld(world, BOUNDS, {
  folderName: 'my-independent-world',
  name: 'BEWright Java World',
  spawn: [8, 5, 8],
  seed: 20260908,
});
console.log(result);
```

每个建筑项目自行构造自己的 `Structure` 并调用通用 API；BEWright 不绑定任何具体建筑或世界。默认目标是 `blockwright.config.json` 中 Java 存档根目录下的 `folderName`。

`exportJavaWorld()` 保留全局方块坐标。写入过的 Chunk 中，IR 的 `VOID` 与空气都会成为新世界中的空气；该语义不同于向已有 Bedrock 世界追加结构时的“不覆盖”。当前只创建主世界，只保证已写入 Chunk 的内容。

目标目录必须不存在；导出器通过同目录临时文件夹构建，成功后再重命名，拒绝覆盖任何已有存档。确有需要时仍可通过 `output` 指定完整目标路径，或通过 `worldsDir` 临时覆盖存档根目录。

## 语义边界

- 目标固定为 **Java 26.1.2**（DataVersion 4790）。**26.1.2 已把世界生成配置从 `level.dat` 拆成独立的 `data/minecraft/world_gen_settings.dat`**；该文件是必选项，缺失会导致客户端报 `Overworld settings missing` / `Unable to read or access the world gen settings file`，世界无法加载（安全模式也无效）。导出器总是生成它，其 overworld 维度为 `minecraft:flat`，并带 `features:0`、`lakes:0` 字段；这是导出器的格式目标，客户端加载仍须单独验收。
- `Structure` 的 X/Y/Z 世界坐标原样保留，包括负区块坐标；支持的 Y 范围为 -64 至 319。
- 写入过的区段中，未设置的体素会成为 Java 空气。显式空气也会创建对应区块，用于表达清空区域。
- 当前转换器覆盖同名普通方块，以及常用楼梯、台阶、朝向、门、床、树叶和水状态。无法可靠转换的 Bedrock 状态会报错。
- **栅栏/墙/铁栏杆的连接状态由导出器自动计算**：`*_fence`、`*_wall`、`*_bars`/`*_pane` 会扫描 4 个水平邻居并写入 `north/east/south/west/up`。栅栏用 `true/false`；铁栏杆用 `true/false`。场景只需写方块名即可自动相连。
- **墙（`*_wall`）的水平连接**：与**非空气、非树叶的已设置方块**连接（含石砖、墙体等），方向值用 `low`/`none`，完全由相邻方块决定（不受场景硬编码 `wall_connection_type` 影响）。
- **墙的 `up` 规则（当前实现）**：恰好有 2 个方向连接时写 `up:false`，其余数量写 `up:true`，覆盖场景的 `wall_post_bit`。当前未区分直段与转角的两向连接，与 Bedrock 的“仅直段降低柱头”规则不同；转角表现需另行在目标客户端验收。
- 第一阶段不导出实体、方块实体、生物群系细节、光照或高度图；Java 会在首次加载时补算派生数据。
- 世界目录与 NBT/Anvil 格式有自动化核验手段，但不等于客户端加载通过。每次交付按实际世界路径、客户端版本和截图记录结果；已有场景的历史成功不能替代新增或改动后的验收。
- **默认不回读**：导出后直接进游戏验收。需要脚本化核验（`level.dat`、`data/minecraft/world_gen_settings.dat`、Anvil 区块坐标与区段数）时，直接调用 `cache/sidecar/` 下的 sidecar（`blockwright-java-export` / `blockwright-world-diagnose`）；工具不再提供这一层的 CLI 入口。

## 依赖许可证

Rust 写入器使用 `anvil-nbt` 0.2.0。该 crate 使用 GPL-3.0-or-later；如果分发链接后的 `blockwright-java-export` 二进制，需要遵守相应 GPL 要求。
