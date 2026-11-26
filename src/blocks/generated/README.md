# minecraft-data 派生数据来源

`bedrock-registry.json` 由 `node dist/cli/index.js registry generate`（`src/cli/commands/registry.ts`）从锁定的 npm 包 minecraft-data 3.115.0 生成，目标为 Bedrock 1.21.60。保留来源项目、包版本、目标版本、数据哈希和记录数。运行时仅加载这份 JSON，不加载整个 minecraft-data 包。

来源项目：PrismarineJS minecraft-data / node-minecraft-data；包作者字段为 Romain Beaumont。npm 包声明 MIT；上游 README 的 License 段也声明 MIT，并注明部分数据由 wiki.vg、minecraft.gamepedia.com 手工或自动提取，来源许可要求可能影响许可。

- https://github.com/PrismarineJS/minecraft-data#license
- https://github.com/PrismarineJS/node-minecraft-data
- https://github.com/PrismarineJS/minecraft-data/blob/master/doc/bedrock.md

没有下载、复制 Minecraft 游戏纹理或模型资产。本地 npm 发布包没有单独的 LICENSE 文件；此处保留实际可核实的上游声明与出处，不虚构缺失的版权年份或原始许可文件。

注意：碰撞数据含 Java 衍生数据，不能单独用作 Bedrock 视觉模型。数据中也没有每方块代表色。代表色是项目自行维护或按材质家族估算，不属于本派生数据文件。
