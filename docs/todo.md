# BEWright TODO

- [ ] **P1：统一公共道路的楼梯高侧规则。**
  - 定位：[roads.ts](../src/authoring/roads.ts) 的 `recordRoadPaving`、`stairDirectionFor`，以及 [road-profile.ts](../src/authoring/road-profile.ts)。
  - 已复现：`planRoad → paveRoad` 按 `cell.rise !== 0` 选台阶，下坡会选中低侧格；较新的 `planRoadProfile` 使用高侧格规则，两条公共路径行为分叉。
  - 验收：三宽路从 `[0,16,0]` 到 `[18,10,0]` 当前有 6 处一格踏步交界；修复后应形成连续半格踏步。补齐四向升降、平段、平台和转角回归，两条公共路径采用一致规则。

- [ ] **P1：公共通行检查读取真实踏步交界，覆盖路线全宽。**
  - 定位：[roads.ts](../src/authoring/roads.ts) 的 `roadPassability` 与 [traversal.ts](../src/authoring/traversal.ts)。
  - 已复现：反转正常上坡中的一格楼梯，会产生一格碰撞交界，但 `roadPassability` 返回空诊断；其高差比较读取计划 `cell.y`，没有读取朝向对应的交界高度。
  - 验收：检测反向楼梯、缺失路面、边侧净空占用及转角冲突；明确区分连续步行与允许跳跃；未知碰撞保持 `unknown`。

- [ ] **P1：修复显式 AIR 被当成支撑。**
  - 定位：[reachability.ts](../src/authoring/reachability.ts) 的 `modelIssues`、`lanternSupportErrors`。
  - 已复现：y=10 的悬挂灯笼，上方 y=11 显式写入 AIR，标准模型诊断仍为空；`!world.get(...)` 无法区分空气状态对象与实体支撑。
  - 验收：缺失格与显式空气均不能提供支撑；检查实际碰撞接触，覆盖落地/悬挂灯笼、错误状态和未知形状，不能仅以“存在对象”或“不是 AIR”判断。

- [ ] **P2：补充自定义施工的最终检查。**
  - 复用 [场景接口](../src/authoring/scene.ts)、保护区和 `checkSupport`。
  - 验收：为自定义构件声明支撑、窗洞与通行净空，在最终模型中定位问题。

- [ ] **P2：构建报告表达检查覆盖范围。**
  - 定位：[check.ts](../src/content/check.ts) 与 [CLI build](../src/cli/commands/build.ts)。
  - 本次暴露：`passed` 只表示已执行规则没有发现问题，零错误没有说明窗洞、柱脚、路线全宽、无跳跃通行是否被检查。
  - 验收：记录对象/规则覆盖与未检查项；缺少契约明确标为未检查，不能由“0 个错误”推断全面通过。继续区分生成、预览、世界写入与实际游戏验收。
