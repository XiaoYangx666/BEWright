# 建筑公共创作能力（authoring）

框架在 `src/authoring/` 提供的公共创作件，供所有建筑调用。

推荐先读 [开始创作](authoring-guide.md)：`createScene` 组合本文的机制，统一施工与最终检查。
原始几何函数接受 `BlockKit`，既可直接写独立结构，也可在 `scene.draw` 中记录后整体提交。
原则：**通用机制进框架，调色板与组合风格留在建筑里**（建筑用子类或参数注入材料）。

生成、预览与交付步骤见 [执行流程](agent-workflows.md)；机位、截图和光照接口见 [CLI](cli.md#agent-模式与脚本接口)。下文代码为 API 片段，`kit`、`world` 和材料等由调用方创建；完整示例见 [组件示例](#组件示例)。

`fields.ts`、`waters.ts` 和 `placement.ts` 保留原有导出；地形、水系与操作审计的内部阶段见 [架构边界](architecture.md#authoring-内部边界)。筛选参数统一改为 `where`，旧地形排除谓词需要取反，见 [迁移说明](authoring-guide.md#旧调用的迁移)。

## 组件速查

| 任务 | 入口 |
| --- | --- |
| 放方块动作 | `kit.put/air/fill/ring/carve/line/slab/stair/log/leaf/lantern` |
| 统一创作入口 | `createScene` · 自动构件检查 · 固定材料或回调 · `draw` 自定义组合 |
| 双坡/四坡屋顶 | `alternatingGable`（常用浅坡一击）· `gableRoof` · `profileHipRoof` · 底层 `roofSurface`/`planRoof` |
| 屋面线（正脊/戗脊/檐口） | `ridgeLines(plan)` · `eaveLines(plan)` |
| 中式工艺屋顶 | `hipRoof`（戗脊/起翘/檐裙）· `hexRoof` · `eaveSoffit` · `finial` |
| 栏杆 | `railing` · `rectanglePath` · 布局查询 `planRailing` |
| 树 | `treePreset`（预设）· `tree`（可组合）· `branch` · `leafCluster` |
| 花草散布 | `scatterPlants` |
| 结构诊断 | `floatingRoofTiles` · `tree().floating` · `scatterPlants().skipped` |
| 双跑楼梯 | `buildSwitchbackStair`（返回净空契约，交通行检查验收） |
| 通行自检 | `standardIssues` · `walkableCells` · `checkTraversal` · `passableCell` |
| 材料与随机 | `resolveMaterial`（string/State 统一）· `coordinateRandom`（通道化确定性随机）· `voxelPath` |
| 统一诊断 | `DiagnosticSink` · `coordinateDiagnostic` · `cellDiagnostic` · `regionDiagnostic` · `formatDiagnostic` · `mergeDiagnostics` |
| 表面查询 | `SurfaceQuery`（`terrain` / `water` / `standable` / `groundY`）· `sample(kind,x,z)` · `slope` · `openSky` · `standableBelow` |
| 保护区与净空 | `ProtectionRegistry` · `add` / `addVoid` / `addOpenSky` · `check`（提交前）/ `audit`（最终模型） |
| 保护区规则 | `blockPattern` · `notPattern` · `names` · `suffix` · `matchProtectionRules` · `isConstructedName` |
| 地形感知放置 | `planPlacement` / `commitPlacement` / `placeObject`（整体提交）· `auditOperationCells`（所有权与保护区的唯一实现） |
| 统一施工计划 | `planConstruction` / `commitConstruction` · `structureIdentity` / `staleTargetReason` · `recordTerrain` / `recordWaterSystem` / `recordRoadPaving` |
| 组合配方 | `planValleyStream` / `buildValleyStream` / `checkValleyStream`（山脊—溪流—跌水—潭岸） |
| 完整步道 | `planWalkway` / `buildWalkway` / `checkWalkway`（共同路面、边梁、支柱、栏杆与灯具） |
| 水渠与护岸 | `planFinishedCanal` / `buildFinishedCanal` / `checkFinishedCanal`（复用水系计划，补齐潭渠衔接、实际岸线、压顶与最终检查） |
| 变换 | `transform` / `transformPosition` / `transformBox` / `transformState` · `inverseTransform` / `inverseTransformPosition` · 旋转 + 镜像 |
| 场地锚点 | `site()` · `Site` · `Lot` · `anchor` / `entrance` / `worldFacing` |
| 道路 | `planRoad` · `paveRoad` · `roadPassability` · `distanceToPolyline` · `routeCentreline` · `waypointHeightAt` |
| 道路纵断面与桥 | `planRoadProfile` / `recordRoadProfile` / `buildRoadProfile` / `checkRoadProfile` |
| 建筑接地 | `groundingFromLot` / `planGrounding` / `recordGrounding` / `buildGrounding` / `checkGrounding` / `entranceApproach` |
| 三层群落 | `plantGenerator` / `woodlandSpec` / `growWoodland` / `checkVegetation` |
| 水系 | `planWaterSystem` · `buildWaterSystem` · `checkWaterSystem` · `sealsWater` |
| 地形场 | `fbmNoise` · `simplex2D` · `terrainSkeleton` · `terrainRecipe` / `mountainHeight` / `buildTerrain` · `field`/`remap`/`addFields`/`blendFields`/`quantize` · `fieldSlope` / `fieldCurvature` · `selectSurfaceMaterial` |
| 植被群落 | `growVegetation` · `habitatWeight` |
| 公共检查算子 | `auditProtection` · `checkSupport` · `checkTerrainOverlap` · `checkRoute` · `checkRoadRoute` · `checkWater` |

## 统一诊断（`authoring/diagnostics.ts`）

框架里所有"生成后发现问题"的出口都归一到一种形状。强制字段是**规则编号 + 严重度 + 对象归属 + 坐标或区域 + 原因**，没有这四样报告就无法被机器消费或定位到格：

```ts
const sink = new DiagnosticSink();
sink.error('pad.occupied', '起点净空被占', { object: { kind: 'start-pad', id: 'A01' }, position: [85, 13, 43] });
sink.unknown('collision.unsupported', '碰撞形状未确认', { position: [1, 2, 3], conclusive: false });
```

- 严重度：`error` / `warning` / `unknown` / `info`。**`unknown` 表示判不了**，不能当作通过；`worstSeverity` 将它保留为未确认，CLI 将 `unknown` 计为阻断诊断，施工规划也会阻止提交。
- `formatDiagnostic` 输出 `规则 严重度 对象 @ 坐标 — 原因`，`mergeDiagnostics` 去重并稳定排序。
- 兼容：旧 `check()` 的 `throw`、字符串、字符串数组、`{ issues }`、单条诊断或诊断数组都能被 `normalizeCheckResult` / `runModelCheck` 归一。抛错仍是合法且推荐的失败方式。
- 想让 `throw` 同时带上机器可读诊断，用 `DiagnosticError`。

## 表面查询（`authoring/surface.ts`）

生成期的高度公式只是**生成输入**；挖潭、削坡、架桥之后唯一可信的是模型本身。`SurfaceQuery` 直接读 `Structure`，四类语义必须分清：

| 查询 | 含义 |
|---|---|
| `terrain(x,z)` | **地形表面**：完整地面方块，排除水面、树冠/枝叶/植物，以及人工构筑材料（`stone_bricks`、`_planks`、台阶、栅栏等） |
| `water(x,z)` | 水面（最高水体格） |
| `standable(x,z)` | 可站立顶面：碰撞几何，含桥面、台阶、半砖 |
| `groundY(x,z)` | **"这里的地面有多高"**：地形表面与水面中较高者 |

为什么需要第四个：潭内岩床在水下很多格，只取 `terrain` 会把湖面报成悬崖；只取 `water` 会把旱地报成湖。判断"水从多高落下"必须用 `groundY`。

- `standableBelow(x, z, ceiling)` 取严格低于 `ceiling` 的可站立面，**桥下选地表**就用它（`ceiling` 是排他的，桥面不会自己回答）。
- 缓存按 `Structure.revision` 失效，列结果按 `touched()` 区分"模型外"（返回 `null`）与"模型内被挖空"（停止下扫，返回 `null`）；过期缓存直接重建，不做静默继续使用。
- 扫描窗口上界取 `Structure.ceiling`（最高被显式写入的格，含显式空气），否则把一列挖到高于残留方块之后会漏读。

## 保护区与净空契约（`authoring/protection.ts`、`authoring/rules.ts`）

契约只声明"这段空间属于谁、必须满足什么"，**不维护第二份体素世界**：方块仍然只有 `Structure` 一份权威数据。

```ts
const zones = new ProtectionRegistry(bounds);
zones.add({
  id: 'A01', kind: 'start-pad', owner: 'entry',
  region: { min: [83, 11, 40], max: [90, 16, 47] },
  clearance: { minHeight: 5 },   // 有限高度净空
  openSky: true, skyFromY: 16, skyCeiling: 79,  // 开放天空：屋檐/招牌/树叶都算遮挡
});
zones.addVoid({ id: 'plaza', kind: 'clear', owner: 'me', region: box });  // 整块地保持空
```

- `check(world, occupation)` 在**提交前**判定一次提议；`audit(world)` 在**最终模型**上复查。两者共用同一个 `verdict()`，所以"事前拒绝"和"事后复查"不会互相矛盾。
- `state: null` 是"挖除"而不是"放方块"：挖空净空区不侵占空间，只有真的往里放方块才算。
- 净空区可以有 `allow` 清单（例如起点台面允许 `stone_bricks`）；没有清单时该区域只允许空气。
- `rules.ts` 是保护区规则的**可复用判据**，回答"哪些方块算这个对象的"。要点：替换与挖除**不能仅凭材料判断**——`blockPattern({ names: TERRAIN_NAMES })` 配合 `notPattern(names('stone_bricks'))` 才能把天然岩壁与人工石径分开。

## 地形感知放置（`authoring/placement.ts`）

**生成候选 → 校验写入与挖除计划 → 整体提交**：

```ts
const report = placeObject(world, {
  prefab: treeKit.s, origin: [x, y, z],
  object: { kind: 'tree', id: 'A01-tree', owner: 'lobby' },
  bounds: BOUNDS,
  surface: surfaces, maxSlope: 2, maxFoundation: 4, maxCut: 6,
  protection: zones, rules: [terrainProtection],
  overlapAllowed: (existing) => existing?.name === 'minecraft:stone_bricks',
});
if (!report.accepted) console.log(report.diagnostics.map(formatDiagnostic));
```

- `planPlacement` 是**纯函数**：它不写世界，所以被拒绝的候选对目标模型零修改（可用 `inspect().revision` 断言）。`commitPlacement` 只负责写，不再做任何可能中途失败的判断。
- 计划是**一次性增量**：`PlacementPlan.baseRevision` 记录规划时的 `Structure.revision`，`commitPlacement` 发现模型已被别人改动就抛错要求重规划，而不是把过期决策盖到新模型上。`placeObject` 内部"规划 + 立即提交"，永远命中同一个 revision。
- 拒绝一定带可定位原因：`placement.out-of-bounds` / `placement.occupied` / `placement.slope` / `placement.foundation-too-deep` / `placement.excavation-too-deep` / `placement.no-surface` / `placement.untransformable-state` / `placement.empty-candidate`，以及 `protection.*`。
- 地表投影（`surface` + `surfaceKind`）、限深地基（`maxFoundation`）、限量削填（`maxCut`）、坡度限制（`maxSlope`）、越界与支撑都可选开启。
- `maxCut` 表示"这次操作持有削填权限"：体积内被地形占用的格按削填预算处理，而不是判成无权覆盖。
- **树的完整枝干与冠幅**都要通过检查：把整棵树建成独立 prefab 再交给 `planPlacement`，越界的树冠会被 `placement.out-of-bounds` 拒绝。
- `accept()` 返回 `written` / `removed` / `unchanged`（都按**实际变化**计数，不是按写入格数）。

## 统一施工计划（`authoring/construction.ts`）

地形、水系、岸线与道路铺装共用同一条施工路径，**几何设计计划**与**已解析材料的施工计划**是两件事：

```ts
const plan = planConstruction(world, {
  id: 'pond', object: 'water-system',
  protection: registry,             // 保护区与规则在这一层判定（复用放置的所有权审计）
  excavationAuthorized: true,       // 这次操作持有削填权限
  build: (sink) => {                // ← 所有用户回调只在这里执行
    recordWaterSystem(sink, waterPlan, materials);
  },
});
if (!plan.feasible) throw new Error(plan.diagnostics.map(formatDiagnostic).join('\n'));
commitConstruction(world, plan);    // 只写，不再执行任何回调
```

- **回调只在计划阶段跑**：材料、表皮、掩码回调在 `planConstruction` 期间执行完毕并完成注册表校验；返回非法方块状态或中途抛错都会变成 `construction.material` / `construction.callback` 诊断，计划不可行，目标模型零修改。`commitConstruction` 只应用已经验证过的写入与挖除。
- **计划绑定目标模型**：`targetIdentity` 是模型**实例**身份（两个 revision 相同的模型也不能互认），`baseRevision` 是规划时的 `Structure.revision`。提交到别的模型或模型已变动都会被 `staleTargetReason` / `commitConstruction` 拒绝。`commitPlacement` 用同一套身份与 revision 检查。
- **影响范围与归属**：计划记录 `object`、`region`/`bounds`、解析后的写入与挖除、保护区结论（`violations`）与全部诊断。
- **合并规则显式**（并汇总成一条 `construction.merge` info 诊断，不靠循环顺序静默覆盖）：
  - 同格写同样的方块 → 计重复，幂等；
  - 层替换（terrain → bed/bank/water/road）→ 计 `replaced`，不告警；
  - 先填后挖（terrain → 水体/道路）→ **挖除优先**，计 `excavated`；其他组合逐格 warning；
  - 先挖后填 → **写入优先**（该格不再清除），计 `refilled`；
  - 水体写入别人声明的河床格 → `construction.bed-flooded` **error**（设计冲突，不是顺序问题）；
  - 岸线材料写入已计划的水体格 → 水优先，记 `construction.shore-over-water`（info）。
- **只读视图**：`sink.get` / `sink.groundY` 读的是"**原模型 + 待提交操作**"，岸线这类后续阶段因此看到的是施工后的地表，而不是初始高度场。挖除中的格按显式空气返回。
- **显式空气与回调纯度**：提交挖除时写入 AIR，即使目标格原本未设置也保留清除意图，不能改成 VOID。最终每个坐标只有一个操作。sink 不暴露可写 Structure；规划开始记录 revision，检测回调通过外部引用修改目标时拒绝提交。回调不得自行修改目标，框架不回滚这种外部副作用。
- **便捷入口保留**：`buildTerrain` / `buildWaterSystem` / `paveRoad` 内部完成"规划 → 校验 → 提交"，失败时目标模型逐格不变；需要把多个阶段并成一组时用 `recordTerrain` / `recordWaterSystem` / `recordRoadPaving` 写进同一个 sink。
- 不承诺进程崩溃级事务：事务边界就是调用方声明的那个接合组（`buildValleyStream` 是其中之一），也不要求整个建筑采用巨型事务。

## 组合配方（`authoring/recipes.ts`）

```ts
const plan = planValleyStream({
  id: 'valley-stream', seed: 12,
  region: { min: [0, 0, 0], max: [96, 48, 80] },
  floorY: 6, springY: 18, poolY: 10, ridgeTop: 30,
  poolDepth: 3, streamHalfWidth: 1,
  materials: { rock, soil, surface, water, bed, bank },
});
const report = buildValleyStream(world, plan);   // 地形 + 水系 + 岸线作为一个接合组
checkValleyStream(world, plan);                   // 最终模型上重新执行水体契约
```

- 场景骨架按场地比例推导：山脊 → 沿溪流整形的高地 → 垂直跌水 → 深潭 → 场地边界出口。`gradeTerrain` 负责沿轮廓渐变削填，高地两侧融回原山体；矩形台地原语继续保留，但不是此自然配方的默认形态。
- `plan` 自带设计输入快照（`plan.spec`，复制 region 与材料回调表）；材料回调在施工规划阶段解析。`buildValleyStream(world, plan)` 只收一份输入。设计 error/unknown 与合成水体检查都在提交前阻断施工。
- 岸线 `band` 是到潭体的最近 Chebyshev 距离，先聚合最小距离再选材，改变水柱遍历顺序不会改变岸线。
- 水段可声明 `externalOutlet: { bounds, facing }`：其出口湿截面必须位于边界且朝向场景外，仅该截面的朝外面免做封闭检查，侧壁与河床仍必须封闭。这是场景接口，不保证写入任意游戏地形后水流稳定。
- 组内任何一步失败（材料回调抛错、水体或岸线进入保护区、水体契约不成立）都不会留下已施工的山体：`report.committed === false`，目标模型内容与 revision 不变。

`gradeTerrain(source, grades)` 接收目标标高、轮廓有符号距离和过渡宽度：距离 <= 0 为核心区，过渡带双向平滑削填，Infinity 排除该列，可形成有意保留的断崖。多个 grade 按声明顺序组合；它是生成输入，施工后查询仍读取模型。

## 变换（`authoring/transform.ts`）

```ts
const spec = transform(90, 'x');           // 水平 90° 旋转 + 镜像
transformPosition([1, 2, 0], spec);        // [0, 2, 1]
transformBox(box, spec);                   // 半开区间按格变换，不差一格
transformState(minecraftBlock('oak_stairs', { weirdo_direction: 0, upside_down_bit: false }), spec);
// → { states: { weirdo_direction: 2, … }, untransformed: [], remapped: true }
```

- 约定：`weirdo_direction` 等方向状态用仓库的 0=+X 1=-X 2=+Z 3=-Z 编号；`rotation` 是俯视顺时针；`mirror: 'x'` 表示**以 X 轴为法向的镜面**（保留 X、翻转 Z）。
- **方向状态必须同步变换**：`weirdo_direction`、`facing_direction`、`pillar_axis`、`minecraft:cardinal_direction`、`ground_sign_direction`、`rail_direction`、`torch_facing_direction`、`lever_direction`、`orientation`、`rotation` 都有映射。
- 映射不了的方向状态（未知键、非默认状态，例如 `torch_facing_direction: 'unknown'`）会进入 `untransformed`，`planPlacement` 据此**拒绝整个候选**并报 `placement.untransformable-state`——绝不静默保留错误朝向。
- `inverseTransform(spec)` / `inverseTransformPosition(position, spec, anchor, offset)` 是 `transform` / `transformPosition` 的精确逆：变换按"先旋转再镜像"组合，逆变换就要反过来组合，四分之一圈还会把镜面法向从 `x` 换成 `z`（否则 `worldToLocal(localToWorld(p))` 在镜像 90° 上会返回 `(-x,-z)`）。`Lot.worldToLocal` 用的就是这个逆。
- 只支持水平 90°/180°/270° 与水平镜像；不做垂直翻转。

## 场地与锚点（`authoring/site.ts`）

轻量，**不是通用场景图**：只有"一个原点 + 一个变换 + 若干地块 + 入口连接"。

```ts
const valley = site({
  id: 'valley', bounds: {...}, origin: [100, 10, 200],
  lots: [{
    id: 'pavilion-west', kind: 'pavilion', bounds: {...}, origin: [46, 11, 110],
    transform: transform(90),
    anchors: [{ local: [0, 0, 2], facing: 2, role: 'entrance' }],
  }],
});
const lot = valley.lot('pavilion-west')!;
lot.localToWorld([2, 0, 0]);   // 局部坐标 → 世界
lot.worldToLocal(world);       // 逆变换
lot.boundsToWorld();           // 半开区间仍然按格
lot.entrance();                // { position, facing（声明朝向）, worldFacing（变换后朝向） }
```

`facing` 与 `worldFacing` 刻意分开：旋转后的地块不能悄悄按错误方向连路，调用方必须说明用的是哪一个。

## 道路（`authoring/roads.ts`）

**路线规划**与**铺装生成**是两件事：

```ts
const plan = planRoad({
  waypoints: [[2, 8, 2], [30, 12, 2]],   // Y 就是路面方块本身的标高
  profile: { width: 3, maxStepUp: 1, maxStepDown: 1, strategy: 'stairs', excavationBudget: 40, object: 'spoke-1' },
  surface: surfaces,                     // 省略 heightAt 时按途经点标高线性插值
  where: (x, z) => !inProtectedZone(x, z),
});
if (!plan.feasible) throw new Error(plan.diagnostics.map(formatDiagnostic).join('\n'));
paveRoad(kit, plan, {
  surface: (cell) => minecraftBlock('stone_bricks'),
  support: (cell, depth) => minecraftBlock('cobblestone'),   // 填方/桥墩
  stairs: (cell, direction) => minecraftBlock('stone_brick_stairs', { weirdo_direction: direction, upside_down_bit: false }),
});
roadPassability(world, plan);
```

- **坐标只有一个约定**：`RoadCell.y` 是**路面方块自己**的 Y（`blockY`）。玩家脚底标高是这块方块的碰撞顶面（满方块 +1，半砖 +0.5），由实际碰撞几何决定。规划、铺装与复核共用这一个约定——把"脚下那一格"当成规划标高，正是让刚铺好的路通不过自己的检查的原因。
- `heightAt` 可省略：省略时按**途经点自身的 Y 线性插值**（`waypointHeightAt`），不会把整条路线算成"无标高"。回调返回 `null` 会让该格成为断口并报 `road.unresolved-height`（error，路线不可铺装）。
- 宽度 = 声明值：横向偏移取 `index - floor(width / 2)`（宽 2 → `[-1, 0]`，宽 4 → `[-2,-1,0,1]`），中心线永远是路面上的一格；偶数宽度不会少一列。
- 路线离散化用**逐轴推进的整数 Bresenham**：相邻中心线格一定共面，斜向折线不会出现对角跳格；`road.centreline-gap` 是防止以后采样实现回退的守卫。
- 规划考虑坡度、宽度、转弯、保护区与削填成本；`strategy` 明确选择 `stairs` / `slab` / `bridge` / `cut`，`RoadCell.rise` 记录该踏面相对上一中心线格的高差。
- `paveRoad` 只在**真的台阶处**铺楼梯（`rise !== 0`），平路铺普通路面；楼梯高侧朝上坡方向（`stairDirectionFor`），末端不会反向。材料回调返回 `null` 时记入 `paved.skipped`，不静默留洞。
- `paveRoad` 拒绝铺设 `feasible: false` 的路线：**无解时报错，不会生成看着连着却走不过去的路**。
- `roadPassability(world, plan)` 用**实际碰撞几何**复核最终模型：路面格没铺（`road.unpaved`）、顶面站不住或净空被堵（`road.impassable`）、填方路段悬空（`road.unsupported`）、实际高差超限（`road.step-too-high`）都会报出来。低层 `planRoad` 的桥标记只在 `strategy: 'bridge'` 时产生，桥格不向下填土；需要桥台、净空及自动纵断面的场景使用下面的 `planRoadProfile`。

### 自动纵断面与跨水桥（`authoring/road-profile.ts`）

```ts
const road = planRoadProfile(world, {
  id: 'creek-path', waypoints: [[2, 5, 8], [22, 5, 8]], width: 3,
  minY: 4, maxY: 9, maxCut: 2, maxFill: 5, earthworkBudget: 300,
  bridge: { maxSpan: 6, waterClearance: 2 },
});
const result = buildRoadProfile(world, road, {
  surface: c => minecraftBlock(c.bridge ? 'spruce_planks' : 'stone_bricks'),
  support: () => minecraftBlock('stone_bricks'),
  stairs: (_, direction) => minecraftBlock('stone_brick_stairs', {
    weirdo_direction: direction, upside_down_bit: false,
  }),
  bridgeEdge: () => minecraftBlock('spruce_planks'),
  bridgeRailing: () => minecraftBlock('spruce_fence'),
});
```

示例要求 `world` 中已经有可查询地形。途经点 X/Z 定义走廊，只有首尾 Y 固定为路面方块标高；中间 Y 不作为约束。有限整数标高范围最多相差 128 格，动态规划优先减少断面削填、其次减少起伏。首尾默认保留 2 格平段（`landingLength`），不在入口踏面上直接结束爬坡。**转角也保持同高**：路段的横向断面垂直于自身切线，直角转弯时前后两条断面会在转角格上重叠，而一个格子只能有一个路面标高，所以纵断面在方向变化处两侧各 `width` 步内必须等高——否则会报 `road.crossing-conflict`，读起来像路线画错了，实际只是求解器穿过了弯角。这条约束只会禁止"在弯道里下坡"，不会把可解路线判成无解（两条腿在转角格相交，该格本来就同时满足两端约束）。跨水段与紧邻的桥台保持同高，水面最高水格顶部到桥底至少保留 `waterClearance` 格；桥面下不填土，只在两岸接地。`maxSpan` 按跨水中心线段数计，宽度内任一格有水都会触发跨水判定。

`road.bridge-required`、`road.bridge-span`、`road.no-profile`、`road.earthwork-budget` 分别区分未启用桥、跨度超限、当前约束无解、削填超预算。预算按断面计量，弯角重叠保守重复计量；返回的 `cutBlocks/fillBlocks` 则按去重后的实际施工列计量。冲突的自交/弯角会明确拒绝，不自动寻找另一条走廊。首版桥针对跨水，不承诺自动跨越未知地底或干谷。边梁与栏杆可选，但栏杆必须同时声明边梁；它们位于通行宽度之外。

楼梯落在高侧格，下降时也不会漏掉桥头的半格踏步。`checkRoadProfile` 检查实际碰撞边缘步高（≤0.6）、路基连续支撑、水格保留与桥下净空；错误材质或漏填在提交前拒绝。复杂建筑最终仍需 `checkTraversal` 检查完整门内路线，不能用局部路面检查替代。

### 建筑接地与入口（`authoring/grounding.ts`）

`planGrounding(world, spec)` 只读取实际模型，`buildGrounding` 解析材料、验证后整体提交。`footprint` 为闭区间 `RectXZ`，`floorY` 为完成地坪方块 Y。必须显式给出 `maxCut`、`maxFill` 和 `earthworkBudget`；缺少实体地面、超预算或占水均拒绝。模式如下：

- `plinth`：整个占地填到地坪，外露立面由基础材料决定。
- `terrace`：占地整平，外围按 `transition` 宽度平滑回到原地面；基础材料与过渡表皮分别传入。不自动做多级挡墙结构设计。
- `stilts`：只有 `supports` 声明的世界 X/Z 支点落柱；其余地板下保留空间。支点不准占水，跨水地板检查 `waterClearance`（默认 2）；不模拟结构承载，调用方负责声明有意义的支点布局。

材料接口为 `floor(column)`、`foundation(column, y)` 和可选 `transition(column)`。`groundingFromLot` 从旋转/镜像后的地块导出世界占地，地坪取局部 Y=0；`entranceApproach(lot, length, roadY)` 按入口锚点的世界朝向返回进门走廊，不连接建筑中心。入口锚点同样使用地坪方块 Y。

多个构件需共同成功时，在一次 `planConstruction` 中依次调用 `recordGrounding(sink, world, ...)`、`recordRoadProfile(sink, world, ...)`，再记录上部建筑。两份设计计划必须基于同一未变动的目标模型；不能先单独提交基础再复用旧道路计划。失败不提交任何本组操作，旧环境保留。生成上部建筑前接地检查要求占地内部净空；生成后可用 `checkGrounding(world, plan, { interior: false })` 检查地坪和基础，室内另用实际碰撞通行验证。

- `distanceToPolyline(x, z, line)` 取代建筑里各自手写的"点到线段距离"，单点折线返回点到该点的距离而不是 `Infinity`。
- 规则编号：`road.no-route` / `.too-steep` / `.turn-too-tight` / `.excavation-budget` / `.unresolved-height` / `.centreline-gap` / `.unpaved` / `.impassable` / `.unsupported` / `.step-too-high`。

## 水系（`authoring/waters.ts`）

用**源头 / 河段 / 跌水 / 潭 / 出口**表达连接关系，并把三件事分开：

```ts
const plan = planWaterSystem({
  id: 'fall', source: [5, 8, 4],
  segments: [
    { id: 'brook', kind: 'reach', path: [...], halfWidth: 0, connectsTo: ['sheet'] },
    { id: 'sheet', kind: 'drop', path: [...], halfWidth: 1, connectsTo: ['pond'] },
    { id: 'pond', kind: 'pool', path: [[2, 6, 2]], depth: 3,
      basin: { min: [1, 4, 1], max: [6, 8, 6] },
      inlet: { at: [2, 6, 1], facing: 2, width: 1 } },
  ],
});
buildWaterSystem(kit, plan, { water, bed, wall });   // 先开挖与河床/潭盆/岩壁，最后放水
checkWaterSystem(world, plan);                        // 按水段类型分别判定
```

- **几何契约**：每个水段由 `WaterColumn[]` 组成，`{ top, bottom, bed, depth }` 明确列出水面、水底、水体层数与床体标高；`depth`（默认 1）是水体厚度，床体永远紧贴水底（`bed = bottom - 1`）。河段与潭是"体"，`surfaceCells` 是全部水格；跌水与贴壁水帘是"帘"，只按格记录、**没有水体列，也不生成垫在每层下面的河床**——瀑布本来就悬空。
- **潭的轮廓**：`basin`（半开 Box）是潭的平面轮廓，覆盖到的路径列会被轮廓取代；`basin` 的 **Y 范围只作参考**，水位来自 `path`/`surfaceAt`，厚度来自 `depth`。轮廓与水柱完全无关时报 `water.basin-outline`（warning），不静默改写水位。
- **边界封闭**：水体每一列的**底面**与每个水格的**四个侧面**必须是确认能封闭的方块（碰撞为完整立方体），或属于别的已计划水段/`inflows` 声明的合法水口。空气缺口报 `water.basin-floor` / `water.basin-leak`；碰撞形状不确定的材料报 `water.boundary-unknown`（`unknown` 严重度，阻止施工通过）。碰撞实体不自动等于阻水实体：半砖、栅栏这类非完整方块不加封闭假设。
- **端口语义**：连接引用 `inlet` / `outlet`（位置 + 朝向 + 宽度）声明的截面，不取体素数组首尾；未声明时按路径端点推导。`connectsTo` 里的段号必须存在，否则报 `water.port-missing`（以后不再"静默跳过检查"）。直接相连的两段必须**湿截面接触**且**同水位**，有落差就要求显式声明一段跌水（`water.level-mismatch`）；跌水的落点必须落在接收水面上（`water.drop-landing`）。
- **河段连续性**：相邻路径点必须相接（宽水段以足迹相接为准），否则段内会留干格，规划阶段即报 `water.discontinuity`。沿程设计水位不允许逆坡（`water.unexpected-uphill`）。
- 生成顺序是硬约束：**先开挖与河槽、潭盆与岩壁，再放水**；`buildWaterSystem` 的开挖范围限定在水体列及其上方 `carve` 格，不会把整列从河床到水面挖空。
- 检查按类型分别判定，避免误报：`drop` 不要求水底有实体，也不要求贴岩；只有声明了 `wallDistance` 的 `wall-sheet` 才要求与岩壁保持距离（法向由场景里最近的岩壁推断，垂直下落的水帘没有水平方向可取垂直）；`outlet` 必须真的有水。
- **不伪造流动**：所有水格都写成源方块（`liquid_depth: 0`），不用距源点的距离冒充水深或流动级别；静态检查只证明已声明水体的连续性与边界条件，实际流动、扩散与稳定性留给目标版本游戏验收。
- 规则编号：`water.discontinuity` / `.unexpected-uphill` / `.basin-floor` / `.basin-leak` / `.basin-outline` / `.drop-landing` / `.wall-distance` / `.dry-source` / `.outlet` / `.port-missing` / `.level-mismatch` / `.depth-conflict` / `.boundary-unknown`。

## 地形场与地形骨架（`authoring/fields.ts`）

噪声用成熟库 `simplex-noise`，框架只负责**把种子变成可复现的置换表**：`createNoise2D` 接受任意 `[0,1)` 随机函数，所以种子通过 `seededRandom`（mulberry32）注入，取代库默认的 `Math.random`。

```ts
const detail = fbmNoise({ seed: 91, scale: 48, octaves: 4, warp: { strength: 6 } });
const skeleton = terrainSkeleton({
  base: 10, peak: 46,
  plateaus: [{ id: 'mesa', x0: 0, x1: 40, z0: 0, z1: 30, top: 34, transition: 6, outer: 12 }],
  ridges:   [{ id: 'crest', line: lineBetween([10, 0], [10, 90]), crest: 44, falloff: 24 }],
  valleys:  [{ id: 'thalweg', line: [[0, 20], [80, 20]], floor: 6, falloff: 18 }],
  saddles:  [{ id: 'pass', a: [0, 0], b: [0, 40], height: 22, radius: 14 }],
});
const height = (x, z) => Math.round(skeleton.at(x, z) + detail.at(x, z) * 3);  // 骨架 + 细节
```

- **骨架由设计约束控制，噪声只用于细节**。骨架的组合顺序是明确的：河谷先切 → 山脊只在比该点河谷更强处抬升（山脊跨过峡谷不会把峡谷填平）→ 台地硬覆盖（平顶不受噪声影响）→ 鞍部压低。
- 台地过渡带是**显式线性坡**，不是噪声伪装的陡壁。
- **格点采样**：3D simplex 在部分整数格点会退化为 0，不能直接用规则整数网格代替自然起伏。`fbmNoise` 与 `fbmNoise3D` 内部各自用 `latticeSafe` / `latticeSafe3` 做偏移，直接调用它们即可；只有绕过它们直接用 `simplex2D(...).at()` / `simplex3D(...).at()` 时才需要自己处理偏移。
- **三维杂色用 `fbmNoise3D`（或 `simplex3D` + `latticeSafe3`）**：二维场沿 Y 恒定，刷在崖壁、竖井、洞口这类竖直面上就是一道道**竖直条纹**，一眼能看出地形是高度图。三维采样在 `(x,y,z)` 上取值，崖面因此是块状而非条状：

```ts
const mottle = fbmNoise3D({ seed: 941, scale: 7, octaves: 3 });
rock: (s: TerrainSite) => pick(mottle.at(s.x, s.height - s.depth, s.z));  // 含 y，不是只按海拔渐变
```

- **色板用 `weightedPick`**：把"阈值链"交给框架，方块名和权重仍然完全由建筑声明，**框架不内置任何色板、默认材料或生物群系表**：

```ts
const ROCK = [pair('stone', 5), pair('andesite', 3), pair('tuff', 2)];
weightedPick(ROCK, mottle.at(x, y, z));   // 相对权重，不是概率；weight<=0 的项被跳过
```

- 派生查询：`fieldSlope`、`fieldCurvature`（8 邻域，轴与对角读数一致）、`fieldRange`（报告实际起伏）。
- 表层材料用 `selectSurfaceMaterial(rules, { rise, slope, moisture, exposure })` 按权重选；**框架里没有雪线、草线或任何生物群系表**，规则由建筑传入（同权重按 id 稳定决胜）。
- 分区生成的边界一致性**未实现也未承诺**。

### 山体配方与实体化

`terrainSkeleton` 管的是骨架线；要造出"有顶部、肩部、陡壁与坡脚的山"，用 `terrainRecipe`：

```ts
const recipe = terrainRecipe({
  base: 10, seed: 12,
  mountains: [{
    id: 'ridge', line: crestPolyline,          // 山脊线可以是一条折线，不必笔直
    crestHalfWidth: 2, top: 30, shoulder: 24, foot: 18,
    shoulderRun: 4, faceRun: 8, skirtRun: 10,  // 平顶→肩部→陡壁→坡脚，四段都可控
    roughness: 3,                              // 只低频扰动轮廓，不改变横断面
  }],
  plateaus: [{ id: 'shelf', /* … */ cliff: ['z+'] }],   // 该侧没有过渡带：真正的断崖
  detail: { amplitude: 2, scale: 32 },                   // 细节噪声，平顶与台地上不加
});
recipe.at(x, z);        // 整数方块标高
recipe.skeleton(x, z);  // 不含细节的骨架，用于报告与削填预算
recipe.slope(x, z);
```

- 组合顺序固定：河谷先切 → 山体只在比该点河谷更强处抬升 → 台地硬覆盖 → 鞍部压低 → 最后加细节噪声（台地与过渡带内不加）。
- `PlateauSpec.cliff` 声明的侧面**没有过渡带**，台地在那一侧直接结束——瀑布需要这样一个面。
- `mountainHeight(profile, distance, base)` 是纯函数，可单独用来核对横断面。
- `buildTerrain(kit, recipe, options)` 负责实体化：按列**分别计量削低与填高**（不是一律 `max()` 堆土），自上而下铺表皮 / 土层 / 岩层直到 `floorY`，支持 `where`、`maxCut` 预算、`protection`，并通过统一施工计划提交——材料回调失败时一格都不写。
- 表皮材料由调用方按 `TerrainSite`（`rise`/`slope`/`depth`/`existing`）决定：陡壁返回 `null` 就是裸岩，框架不内置雪线。

## 植被群落（`authoring/vegetation.ts`）

按生境权重分层生成，层与层之间共享同一个模型，所以灌木不会长在树干里：

```ts
const report = growVegetation(kit.s, {
  id: 'grove', x0: 1, x1: 210, z0: 1, z1: 290, height: terrainHeight, base: 10,
  moisture: fbmNoise({ seed: 5, scale: 90 }).at,
  where: (x, z) => outsideBuildings(x, z),          // 道路/建筑/保护区
  layers: [
    { layer: 'tree',  coverage: 0.06, patchScale: 9, patchThreshold: 0.45, minSpacing: 6, seed: 907,
      species: [{ id: 'pine', weight: 3, layer: 'tree', generate: plantGenerator({form: 'pine', trunk: 'spruce_log', foliage: 'spruce_leaves'}),
                  maxSlope: 2, minRise: 9, maxRise: 28, moisture: 0.4 }] },
    { layer: 'shrub', coverage: 0.16, seed: 929, species: [...] },
    { layer: 'ground', coverage: 0.16, seed: 811, species: [...] },
  ],
});
report.layers.forEach(l => console.log(l.layer, l.candidates, l.placed, l.coverage, l.rejected));
```

- 各层**独立**控制密度（`coverage`）、群聚尺度（`patchScale` / `patchThreshold`）、间距（`minSpacing`）与物种权重。
- `habitatWeight` 按坡度、高差、湿度、曝晒调整物种权重；低层读取待提交的上层树冠，有叶片遮阴时降低曝晒值。真实构件逐格检查完整树冠，不能靠缩小声明半径穿入屋顶；`crownRadius` 仅保留给旧的竖列 `blocks` 模式。
- `coverage` 报告字段是候选成功率；`footprintCells` 为该层实际占用的 X/Z 列数，`areaCoverage` 为它占扫描矩形面积的比例。另有按原因分类的拒绝计数；这些候选拒绝是 info，不冒充整批施工失败。
- 相同输入与种子**逐格可复现**（有测试逐格比对两次运行）。间距筛选按优先级排名，剔除的是排名较低的候选，结果与遍历顺序无关。

### 三层低代码入口（`authoring/woodland.ts`）

```ts
import { growWoodland, checkVegetation } from 'bewright';

const vegetation = growWoodland(world, {
  id: 'woodland', bounds, seed: 71, baseY: 10, density: 1,
  roads: [roadPlan], clearings: [buildingBounds],
});
if (!vegetation.committed) throw new Error(JSON.stringify(vegetation.diagnostics));
const damage = checkVegetation(world, vegetation);
```

`world` 是已经完成地形、水体和建筑的 Structure，`bounds` 是半开场地 Box。没有道路或建筑时可省略 `roads`/`clearings`。配方默认生成乔木、灌丛和草花三层：树冠、枝干和整株形状使用真实构件；密度 0..2，默认 1。道路默认外扩 2 格，**整株的所有格，包括树冠**都不得进入道路、水柱或 clearing 的 X/Z 区域，因此没有裁掉半边冠幅的修补。`clearings` 可用于建筑占地和需要保持清晰的景观视线。

高度、坡度和土壤读取实际模型；水岸湿度来自模型中水柱的四邻距离（不是水深，也不是精确欧氏距离），斑块为种子化连续噪声。默认只在草方块、泥土、粗泥土及灰化土生根，不在石路或沙岸上直接播树。需要其他生境规则时用 `woodlandSpec(world, options)` 得到 `VegetationSpec` 并显式替换 `soil/moisture/where/layers`，再 `growVegetation`。

风格可通过 `species: { tree: [...], shrub: [...], ground: [...] }` 覆盖任一层，每项为 `SpeciesSpec`。内置 `plantGenerator({form, trunk, foliage, height, radius, variation})` 支持 `broadleaf/pine/shrub/ground`；树形可以替换为任意 `(site: PlantSite) => Structure`。site 提供独立种子、根部世界位置和生境值；返回的局部模型必须以 `[0,0,0]` 为根，全部几何面连通，不含显式空气。`form: ground` 使用 foliage 作为单株材料；灌丛使用低叶簇，height/variation 用于树形。回调不得通过闭包修改目标世界。

旧的 `blocks` 竖列接口仍兼容，但不代表完整树形。新旧入口均已事务化：`planVegetation` 返回 `{construction, report}`；`commitConstruction(world, construction)` 提交已解析计划，提交期不调用生成器或材料回调。`growVegetation` / `growWoodland` 自动规划并提交，失败时 `committed=false`、成功数归零、原模型 revision 不变。`recordVegetation(sink, world, spec)` 可接入更大的统一施工组。

保护区通过 `protection` 传入，与放置层共用审计。空间冲突会拒绝整株候选；生成器抛错、非法材料或断开的枝叶属于构件错误，会拒绝整批群落。`report.instances` 保存每株根部、原土壤和完整预期几何，`checkVegetation` 在最终模型检查根部支撑及被破坏的枝叶。它是施工检查记录，不维护另一份场景体素世界。

最小独立水岸场景可以先使用上面的 `planValleyStream`：

```ts
import { Structure, minecraftBlock as block, planValleyStream, buildValleyStream,
  checkValleyStream, growWoodland, checkVegetation } from 'bewright';
const world = new Structure();
const bounds = { min: [0, 0, 0], max: [80, 52, 68] } as const;
const water = planValleyStream({
  id: 'independent-valley', seed: 93, region: { min: [...bounds.min], max: [...bounds.max] },
  floorY: 3, springY: 19, poolY: 9, ridgeTop: 32, poolDepth: 3,
  materials: { rock: () => block('stone'), soil: () => block('dirt'),
    surface: site => site.slope > 3 ? block('stone') : block('grass_block'),
    water: () => block('water'), bed: () => block('gravel'),
    bank: (_, band) => band < 2 ? block('sand') : null },
});
if (!buildValleyStream(world, water).committed) throw new Error('valley failed');
const plants = growWoodland(world, {
  id: 'independent-woodland', bounds: water.region, seed: 51, baseY: 9,
});
const findings = [...plants.diagnostics, ...checkValleyStream(world, water), ...checkVegetation(world, plants)];
```

公开文档可独立用于变体创作，不需要导入 `src/` 或复制样例逐格逻辑。

## 公共检查算子（`authoring/operators.ts`）

四个算子都**在最终模型上重新执行**，并且都读取对象契约：

```ts
checkSupport(world, [{
  object: { kind: 'crown', id: 'tree-1' },
  support: 'self-connected',       // 'ground' | 'anchored' | 'self-connected' | 'declared-floating'
  cells: crownCells,
}]);
checkRoute(world, { object: 'spoke-1', path: walkCells, headroom: 3, maxStepUp: 1 });
auditProtection(world, zones, { rule: 'start-pad.clearance' });
checkWater(world, waterPlan);
```

- `support: 'ground'` 要求每格都能经自身连通到地面；`'anchored'` 只要求至少一个锚点落地（**合法桥梁、悬挑**）；`'self-connected'` 要求面连通（**树冠、屋面**）；`'declared-floating'` 什么都不要求（**瀑布水帘、悬挂链条**）。
- 规则编号：`support.floating` / `support.out-of-bounds` / `support.terrain-overlap` / `route.step` / `route.headroom` / `route.unreachable` / `protection.*` / `water.*`。
- 碰撞形状未确认的方块产出 `unknown` 诊断，不会让"判不了"变成"通过"。

## StructureKit — 放方块的动作集（`authoring/kit.ts`）

- `put/air/fill/ring/carve/slab/stair/log/leaf/lantern/get/empty/finishWalls`
- 坐标一律**闭区间**（`fill(x0,y0,z0,x1,y1,z1)` 两端都包含）；状态键名与基岩注册表一致，非法组合在 `minecraftBlock` 处直接报错
- 材料默认值通过构造参数注入：`new StructureKit({ slab: '…', stairs: '…', log: '…', leaf: '…', lantern: '…' })`；未传默认值时这些方法要求显式传材料
- `finishWalls()`：方形栏杆墙按邻居补接线状态（连接方名单独可配）；与全局 `applyBedrockWallConnections` 幂等
- 建筑用**子类**绑定调色板并追加自己的组合件
- 所有 Kit 材料可传 `AuthoringMaterial = string | State`，已有状态会保留，动作显式指定的状态优先；最终通过注册表校验。
- `new StructureKit(defaults, existingStructure)` 可包装已有模型，便于逐段迁移。

## 可组合屋面（`authoring/roof-surface.ts`）

新造型优先使用 `gableRoof`（双坡）、`profileHipRoof`（四坡）和底层 `roofSurface`。旧 `hipRoof` 保持现有风格与签名，其铺面过程也复用 `roofSurface`。

```ts
const roof = gableRoof(kit, {
  x0: 0, x1: 20, z0: 0, z1: 12, // 闭区间
  eaveY: 8, ridgeAxis: 'x', thickness: 2,
  profile: (distance, span) => Math.floor(6 * (distance / span) ** 1.4),
}, { tile: 'deepslate_tiles', stairs: 'deepslate_tile_stairs', slab: 'deepslate_tile_slab' });
```

- `profile` 接受高度表或函数；数组按向内距离采样，到末项后保持，函数输出四舍五入到整数。
- `offsetAt(x,z)` 增加局部整数高度，用于起翘或不对称；复杂轮廓直接用 `roofSurface.heightAt(x,z)`，返回整数屋面块 Y 或 `null` 排除该列。
- `thickness` 默认为 1，生成薄壳；`solidFromY` 显式启用实心填充。两者均不主动挖除已有空间。
- 材料的 `surface(cell)` 可替换铺瓦规则并返回完整方块状态；`decorate(kit,cell)` 添加独立角饰或脊饰。
- `alternatingGableRecipe({x0,x1,z0,z1,ridgeAxis,tile,stairs,slab})` 提供常用浅坡配方：统一半砖/瓦阶交替、脊帽和四角收头；`ridgeCap:false` 或 `cornerClosure:false` 可关闭对应收头，`ridgeMaterial` 可替换独立脊帽材料。
- `alternatingGable(kit, spec)` 是 `gableRoof + alternatingGableRecipe` 的一击组合：坐标与 `ridgeAxis` 只写一遍，`halfGrid` 自动同时传给屋面与配方，不会漏开。江南与水镇已改用此入口。
- `decorate` 在全部屋面格完成后运行；装饰可以安全写入相邻屋面格，不会被后续铺面覆盖。
- 返回 `cells/eaves/ridges/heightAt/bounds`。`heightAt` 是采样快照，`ridges` 表示无更高邻格且至少两侧更低的脊部格；`bounds` 为核心半开区间，包含屋面厚度，不包含回调额外装饰。
- `ridgeLines(plan)` 把脊部格拆成有序直线段（8 连通，含斜向戗脊）：双坡矩形得一条正脊，四坡得中央正脊 + 四条戗脊；交点格会同时出现在经过它的每条线里。`eaveLines(plan)` 把檐口按连通分量走成有序线，矩形屋面是一条首尾相邻的闭环，凹角允许斜跨，孔洞形成独立内环。两者都可用于沿线放脊帽、檐饰，输出确定。
- 半格坡度：`gableRoof/profileHipRoof` 传 `halfGrid:true` 时 `profile` 返回以块为单位、可含 0.5 步进的高度（线性半格坡 = 每 2 格升 1 块，即 `d => d * 0.5`）；屋面 Y 取下整，`cell.half`（0 | 0.5）携带量化后的小数部分。`alternatingGableRecipe` 的 `halfGrid:true` 改按 `cell.half` 选半砖/楼梯（等效于线性坡的距离奇偶）。`profileLevel` 暴露未取整标高；`offsetAt` 仍为整数格。
- 高度是方块所在格的 Y，不是半砖顶面的物理标高。自定义陡坡、孔洞和装饰的连接性需要建筑自己的检查与剖面预览，框架不承诺任意曲线都受支撑。

## 中式屋顶风格包（`authoring/roof.ts`）

通用屋面之上的预制件：几何本身是通用的（profile 高度表驱动的四面坡/六角锥、檐下封板），中式特征集中在可开关的装饰件。要其他文化风格，用 roof-surface 的 `profile`/`heightAt` 写同级别配方即可（`alternatingGable` 就是"江南浅坡"风格包的形态）。

- `hipRoof(kit, spec, materials)`：四面坡，举折表 `profile` 驱动、檐裙上限 `cap`、戗脊 `hips`、四角起翘 `ornament`；实心填檐下，瓦块/半砖/瓦阶交错收头
- `hexRoof`：六角攒尖顶（六边形范数取举折，脊线交角自动改整块）
- `eaveSoffit`：檐下望板 + 额枋一圈；`finial`：攒尖顶宝顶（返回顶部标高）
- 材料由 `RoofMaterials` 显式传入（瓦/瓦阶/瓦阶半砖/脊/金饰/望板/额枋）

## 栏杆（`authoring/railing.ts`）

```ts
railing(kit, {
  path: rectanglePath({ x0: 0, x1: 20, z0: 0, z1: 12 }, 2),
  closed: true, postEvery: 4, gaps: [[6, 9]],
}, { post: 'stone_bricks', panel: 'oak_fence', cap: 'stone_brick_slab' });
```

路径为 XZ 轴向折线，Y 可沿每段升降，每格最多升降一块。`gaps` 是沿整条路径的闭区间距离，开口不重置立柱节奏；`phase` 控制节奏起点。`cornerPosts/endPosts` 默认启用，`omit(cell)` 可避让原有柱子。`style.place(kit,cell)` 只替换构件样式，继续复用布局。`planRailing` 可单独查询布局。

## 枝干与树冠（`authoring/tree.ts`）

```ts
tree(kit, {
  origin: [20, 1, 20], collision: 'error',
  branches: [
    { path: [[0,0,0], [1,6,0], [3,10,0]], material: 'oak_log', radius: t => 1 - t },
    { path: [[1,6,0], [-3,7,0]], material: 'oak_log' },
  ],
  crowns: [
    { center: [-3,8,0], radii: [5,1,4], shape: 'disc', material: 'oak_leaves', density: 0.9, seed: 4 },
    { center: [3,10,0], radii: [4,3,4], material: 'cherry_leaves' },
  ],
});
```

枝干和叶簇坐标相对 `origin`。`branch()` 将每条路径体素化为面相连骨架，并设置原木轴向；各分枝之间的接点由配方指定。`radius` 为固定半径或随路径进度变化的函数。叶簇支持 `ellipsoid/disc/cone`，以及替换轮廓的归一化坐标 `contains(u,v,w)`；需要复刻旧的整数孔隙时使用 `sample(dx,dy,dz)`，它直接决定局部整数样本。半径按整数格对称取样，分数半径不会额外采出负向格。

默认叶簇只填空格；`allowWoodOverlap:true` 是旧树冠覆盖木干的显式兼容开关，`leafStates` 可保留旧材料的状态键集合。不要把它作为新树的默认设置。

`tree` 先在独立模型生成，再按 `collision` 合并：默认 `skip` 保留已有物体并返回 `conflicts`；`error` 发现冲突时不写入；`replace` 显式覆盖。返回的 `structure` 使用局部坐标，`floating` 列出不与任何枝干格连通（可经叶簇面连通传递）的悬空叶格，两个树预设保证为空。跳过冲突可能截断树冠或枝干，完整造型需要用 `error` 检查位置。树的快捷入口是 `treePreset(kit, { kind: 'pine' | 'broadleaf', origin, height, trunk, leaf, seed, collision })`（旧 `pine/broadleaf` 门面已删除，浮云阁即走此入口）；江南、水镇的分层冠形和栖云阁的风形树保留在建筑配方中，使用 `tree`/`leafCluster` 组合以保持各自坐标、原木状态和孔隙公式。

## 地表散布（`authoring/plants.ts`）

```ts
scatterPlants(kit, {
  x0: 0, x1: 40, z0: 0, z1: 40,
  surfaceY: (x, z) => terrainHeight(x, z), // 地面块 Y，null 排除列
  coverage: 0.35, seed: 12, minSpacing: 2,
  where: (x, z) => !onPath(x, z),
  plants: [
    { weight: 3, blocks: ['poppy'] },
    { weight: 2, blocks: ['cornflower'] },
    { weight: 5, blocks: ['fern'] },
  ],
});
```

`coverage` 是 0..1 概率；`densityAt(x,z)` 返回 0..1 局部乘数，可形成花丛。种子是整数，位置、植物选择和间距优先级使用独立随机通道。最小间距按 XZ 欧氏距离计算，用空间桶筛选。默认仅在草方块上种植，条目可用 `soil(state,position)` 定义其他土壤规则。

多格植物通过 `blocks` 自下向上传入完整状态（例如向日葵上下半）；先检查全部净空，再整体放置。返回 `{ placed, skipped: { noSoil, noHeadroom } }`：`placed` 是成功放置的植物底部坐标，`skipped` 按原因计数被拒的候选（遮罩和 `surfaceY:null` 排除的列不计入）。空间、土壤或概率筛选失败时不重新抽取其他植物。相同世界、矩形、参数得到相同输出；最小间距筛选不保证分片运行与整区运行等价。

不设 `minSpacing`（默认 0）时散布在扫描中直接放置，不做候选收集与排序，比排序路径快约 3.5 倍（200×200、2 万株约 18ms 对 66ms），且放置集合与排序路径完全一致。需要间距时仍按随机优先级排序并分桶筛选。分片生成时保持边界间距一致是后续工作，暂未实现。

## 双跑楼梯（`authoring/staircase.ts`）

`buildSwitchbackStair(spec)` 生成两段梯 + 休息平台，校验方向正交、宽度、梯段重叠与第二段起跳标高；返回 `{ structure, contract }`。`contract` 记录宽度、总升高与 `requiredHeadroom`——**净空不在生成时保证**，把最终模型交给通行检查（`checkTraversal`/`walkableCells`）验收。

## 结构检查（`authoring/checks.ts`）

```ts
const plan = roofSurface(kit, spec, materials);
const floating = floatingRoofTiles(kit, plan); // Vec3[]
```

诊断性质：只在生成后报告，不抛错、不放置、不改变方块。`floatingRoofTiles` 报告"正下方为空且同层四个面邻全为空"的悬空屋面格——薄壳横向相连不误报，同层的烟囱、山墙等已有方块也算支撑；树冠连通性见 `tree()` 返回的 `floating`，植物土壤与净空见 `scatterPlants` 的 `skipped`。检查基于调用时刻的 kit 状态，应在建筑主体完成后调用。

## 通行与自检（`authoring/traversal.ts`、`authoring/reachability.ts`）

`traversal.ts` 是碰撞模型层：`collisionBoxes(state)` 把方块解析成 AABB 碰撞盒（楼梯/半砖/墙/栅栏/灯笼等显式白名单；花草等非固体按注册表 `boundingBox:'empty'` 直接无碰撞；名单之外返回 `unknown`，绝不默默当实心方块）。`checkTraversal` 按玩家模型（宽 0.6、高 1.8、跳 1 格）验证"出生点 → 各目标区"可达性，输出逐路由的 reachable/unreachable/unknown 报告。

`reachability.ts` 提供体素级原语：

- `walkableCells(world, starts)`：从出生格出发的可达格集合（四向 ±1 落差、上跳头顶净空、不可站立起点自动忽略）
- `standableAt / passableCell / supportTopAt`：单格判定原语（碰撞来自 `authoring/traversal.ts` 的碰撞盒表）
- `reachableIn(cells, box)`：可达格是否覆盖某个目的地盒子
- `standardIssues(world, bounds, { minOccupied, label })`：通用自检（越界 / 占位几何 / 灯笼支撑 / 体量下限），返回问题消息列表
- `lanternSupportErrors`：单独的灯笼支撑检查
- 建筑 `check` 的推荐写法：`standardIssues` 打底，再加建筑特有的路线/结构断言

## 生成阶段缓存

`cachedStructureStage({ key, sources, inputs, build })` 可缓存一个独立、确定性的 `Structure` 施工阶段。框架自动把 `src/`、`dist/` 运行时代码、依赖锁文件和 Node 版本计入指纹；建筑需在 `sources` 中列出该阶段依赖的所有建筑文件，并在 `inputs` 中列出参数、种子等非文件输入。命中时读取完整模型快照（含显式空气、调色板、修订与区块失效记录）；依赖变化或缓存损坏时重新生成。缓存写入失败不影响正常构建。

可以把区域基础地形作为首个阶段：建筑、道路与装饰文件修改时可直接复用地形；地形、布局或框架源码修改时重新生成。当前粒度是**整段区域基础地形**，还不会识别一份地形配方内部哪几个区块受影响。不要把依赖于前一阶段可变状态的施工代码单独缓存。

## 基础工具（`authoring/layout.ts`）

`RectXZ` 闭区间矩形与 `assertRect/assertPoint/unitInterval` 校验；`coordinateRandom(x,y,z,seed,channel)` 确定性坐标哈希——`channel` 分离"位置/品种/间距优先级"等独立随机流，遍历顺序不影响结果；`voxelPath(points)` 把折线体素化成面连通的格子序列。

## 回归与迁移约定

- **纯重构必须保持最终逐格方块名称与状态一致，显式空气与 VOID 也要区分**；字节口径还受调色板分配与状态字段顺序影响，**仅写入顺序变化未必导致不同哈希**——用字节口径判纯重构会产生假警报。
- 行为修复与有意改型在提交信息中逐条记录模型差异，不许伪装成纯重构。逐格定位可导出调色板与占用格，按方块状态比较。
- authoring 的 `RectXZ` 使用闭区间；核心 `Box`、`bounds`、`region` 和 `Structure.fill()` 保持半开区间。转换时显式换算最大端点，不改变核心约定。
- 房间内饰、家具、构图是各建筑的"身份"，不进框架。

### 重构后的截图核验

固定模型、机位、光照、尺寸和浏览器环境，分别保存改动前后的截图，可用 PNG 哈希辅助比对：

```powershell
node dist/cli/index.js preview <id> --all-views
# 改动前先保存基线图片；改动后用相同参数重新渲染，并与另存的基线逐视图比较哈希
```

相同哈希只能证明这组画面一致；无法覆盖被遮挡的方块、状态差异、未拍到的区域或游戏表现。纯重构仍应比较最终模型的逐格名称与状态，有意改型则查看实际截图并记录差异。

## 完整步道与水渠

`planWalkway(world, spec, options)` 复用道路和栏杆规划；`spec.road` 可接收 `planRoadProfile` 的结果，或传入 `route` 与 `width` 保留指定控制点标高。直接路线默认在转角两侧留与路宽相同的平段，容不下坡道时明确拒绝。半开 `openings` 为入口留空；支柱查询桥底以下的真实实体，允许穿过显式空气继续找柱脚。路面、底梁、外缘、支柱、栏杆与灯位都来自同一份计划。

```ts
const timber = minecraftBlock('dark_oak_planks');
const plan = planWalkway(world, {
  id: 'garden-walkway', route: [[0, 10, 0], [24, 14, 0]], width: 5,
  supports: { spacing: 6, minY: 0 },
  railing: { height: 1 }, lights: { spacing: 8 },
  materials: {
    surface: () => timber,
    stairs: (_, direction) => minecraftBlock('spruce_stairs', { weirdo_direction: direction }),
    beam: () => timber,
    pier: () => minecraftBlock('dark_oak_log'),
    rail: () => minecraftBlock('dark_oak_fence'),
    light: (sink, [x, y, z]) => {
      sink.put(x, y, z, 'dark_oak_fence');
      sink.put(x, y + 1, z, 'lantern', { hanging: false });
    },
  },
}, { excavationAuthorized: true });
buildWalkway(world, plan);       // 不可行、目标错误或过期时拒绝；不重跑材料回调
// 完整场景施工结束后，将这次模型的 plan 交给建筑 check():
const findings = checkWalkway(world, plan);
```

### 自定义桥梁构件

`builders` 可以逐项替换几何生成，未指定的部分仍用默认实现。回调接收施工 `sink` 与 `WalkwayBuildContext`，共享实际道路、外边界、支点、栏杆位置、桥面厚度、净空、入口开口和原地形查询。回调只在规划阶段执行，提交和最终检查不重跑。

| 回调 | 可以自定义的部分 | 保留的检查 |
|---|---|---|
| `deck(sink, context)` | 桥面断面、铺装与桥底；可复用 `recordRoadPaving` | 计划路面可站立、坡度和通行净空 |
| `beams(sink, context)` | 外边梁、挑梁、半砖收边 | 边界承托面、构件接到实际桥面 |
| `support(sink, site, context)` | 多柱、斜撑、折臂、拱形支撑 | 实际柱脚到共同计划桥底的体素连通 |
| `railing(sink, context)` | 柱、面板、扶手、花格与转角造型 | 声明边界覆盖、连接与实际方块/状态 |
| `details(sink, context)` | 桥塔、缆索、额外横梁、装饰 | 实际构件附着、无悬空组、入口与净空 |

现有 `materials.light(sink, base, context)` 也得到共同上下文，可以自由生成灯具；不接受声明了灯位却没有生成任何构件。替换整个构件后，不必提供它不会使用的 `beam`、`pier` 或 `rail` 材料回调；默认生成需要这些材料，漏配会在施工计划中诊断并整体拒绝。

自定义支撑可以返回 `{ footings: Vec3[] }` 指定偏移的真实柱脚，否则沿用该支点查询到的地面。`site.ground` 可能为 `null`，此时必须找到并声明有效柱脚；柱脚必须在施工前已存在，不能由回调放一块悬空石头来证明自己接地。形态不再要求为竖直实柱。框架记录所有生成格及其状态，最终检查能识别后来挖断的折臂、改错的半砖方向或缺失的构件。

`deckThickness` 仍定义共同桥底标高，`railHeight` 定义要覆盖的栏杆高度范围，`openings` 明确允许留空的位置。自定义回调不能绕过原子施工、保护区、入口或通行检查；未知碰撞保留 `unknown`。连接结论是相邻实体体素的连通性，不是结构受力计算或完整吊桥工程验收。

偏移柱脚、半砖边梁和双层栏杆的写法见 [测试夹具](../tests/fixtures/custom-walkway.ts)，可运行 [步道回归](../tests/engine/walkway-customization.test.ts) 验证参数联动与缺损定位。

`planFinishedCanal(world, { water, materials, ... }, options)` 接收现有 `planWaterSystem` 结果。从实际水体足迹推导护岸，重叠的深潭与浅渠使用共同水底，合法一格跌水保留溢流面。`materials.bank(position, bank)` 和 `materials.coping(sink, bank)` 可替换挡墙、苔石、压顶等风格；`bankTop` 控制岸顶，`finishBank` 可让桥下不放压顶但仍封闭水下侧壁。`crossings: [{ road, deckThickness }]` 从同一道路计划推导桥底并检查跨水路面、桥下净空，约束 `clearTo(column)` 的开挖上限；`openBoundary(position)` 只连接当前位置已有的水体，最终再次检查这些水口。跨场地的源头和出口应显式建模，不把任意侧漏算作合法连接。

必须贯通的既有源头或接收水体用 `requiredConnections: Vec3[]` 声明；即使施工前该位置已经干涸或被堵住，也会拒绝施工，避免把失效出口默默补成封闭护岸。例如可从水系出口和实际海面查询推导接收点。

两种配方均通过现有 `planConstruction` 解析、审计并做提交前几何检查，再整体提交。最终 `checkWalkway` / `checkFinishedCanal` 在最终模型复查路面与净空、柱脚到桥底、设施支撑、完整水路、床岸封闭及压顶；未知碰撞或未找到地面保持 `unknown`。水体连通是静态体素结论，不模拟 Minecraft 流体更新。参数变化与后续挖除的示例见 [专项测试](../tests/engine/authoring-finishes.test.ts)。

诊断通过建筑 `check()` 返回或 `collect()` 收集。`build --report` 保存 `buildingDiagnostics`、`check.diagnostics` 和 `diagnosticsUnified`。静态 `preview --check` 在选区内绘制错误或未知位置的线框，另加 `--report` 可保存 `checkDiagnostics` 与 `markers`。机位和使用限制见 [CLI](cli.md#bewright-preview-building)。

## 组件示例

屋顶、树、栏杆和花草的调用示例见 [组件测试](../tests/engine/authoring-components.test.ts)。

```powershell
node --conditions=bewright-src --import tsx --test tests/engine/authoring-components.test.ts
```
