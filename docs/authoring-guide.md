# 开始创作

推荐从 `createScene` 开始。它把已有几何能力组合到同一个 `Structure`、地表查询、保护区和检查流程中。
构件材料可以直接传方块名或完整状态；需要变化时才写回调。框架不提供固定建筑风格或调色板。

## 第一座可调整的亭子

```ts
import { createScene, defineBuilding, type Box } from 'bewright';

const bounds: Box = { min: [-2, -3, -2], max: [20, 20, 20] };

export default defineBuilding({
  id: 'my-pavilion',
  name: '我的亭子',
  bounds,
  params: { rise: { type: 'int', default: 3, min: 1, max: 5 } },
  build: ({ rise }) => {
    const scene = createScene({ bounds, seed: 12 });
    scene.terrain(
      'ground',
      { base: 0 },
      {
        materials: { rock: 'stone', soil: 'dirt', surface: 'grass_block' },
      },
    );
    scene.draw('frame', (kit) => {
      kit.fill({ min: [2, 1, 2], max: [13, 2, 13] }, 'spruce_planks');
      for (const x of [2, 12]) for (const z of [2, 12]) kit.fill({ min: [x, 2, z], max: [x + 1, 6, z + 1] }, 'oak_log');
    });
    scene.gableRoof(
      'roof',
      {
        x0: 1,
        x1: 13,
        z0: 1,
        z1: 13,
        eaveY: 7,
        thickness: 2,
        profile: (distance) => Math.floor((distance * Number(rise)) / 6),
      },
      { tile: 'deepslate_tiles', stairs: 'deepslate_tile_stairs', slab: 'deepslate_tile_slab' },
    );
    return scene.world;
  },
});
```

把代码保存为 `buildings/my-pavilion/building.ts`，并在同目录创建 `blockwright.building.json`：

```json
{
  "schemaVersion": 1,
  "id": "my-pavilion",
  "name": "我的亭子",
  "entry": "./building.ts",
  "editions": ["bedrock", "java"]
}
```

然后运行 `node dist/cli/index.js check my-pavilion` 或 `node dist/cli/index.js build my-pavilion --param rise=4`。
更多目录与清单约定见[建筑内容契约](buildings.md#清单-blockwrightbuildingjson)。
无需写保存计划的 `WeakMap`，也无需为框架构件额外编写建筑 `check()`：`check`、`build`、`preview --check` 自动执行它们的最终检查。

可从 [拱门示例](../examples/demo-arch/building.ts) 查看一份完整的 manifest 与入口组合，它还展示了组件、参数和声明机位。

## 按需要选择入口

| 需求                   | 场景入口                                                     | 保留的设计数据                                   |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| 自己画主体、家具、装饰 | `scene.draw(id, kit => …)`                                   | 最终方块及状态，自动检查后续修改                 |
| 任意屋面轮廓           | `scene.roof(id, spec, materials)`                            | `cells`、`eaves`、`ridges`、`heightAt`、`bounds` |
| 常用坡屋顶             | `scene.gableRoof`、`scene.hipRoof`、`scene.alternatingGable` | 同一份屋面计划                                   |
| 枝干和冠形             | `scene.tree`、`scene.treePreset`                             | 局部树结构、冲突与叶冠连通信息                   |
| 栏杆布局               | `scene.railing`                                              | 柱位、角点、沿线距离                             |
| 花草散布               | `scene.plants`                                               | 成功位置及土壤、净空拒绝计数                     |
| 地形                   | `scene.terrain`                                              | 填挖、范围与诊断                                 |
| 道路                   | `scene.road`                                                 | 实际纵断面、路面、平台和跨水信息                 |
| 完整桥或步道           | `scene.walkway`                                              | 同一条道路推导桥底、边梁、支点、栏杆和灯位       |
| 水体                   | `scene.water`                                                | 水段、水柱、床体与端口                           |
| 水渠、潭与护岸         | `scene.canal`                                                | 水系、护岸、压顶及桥下净空                       |
| 接地与整地             | `scene.grounding`                                            | 台基、填挖、柱脚与预算                           |
| 自定义植物群落         | `scene.vegetation`、`scene.woodland`                         | 物种实例、覆盖和最终支撑检查                     |
| 独立构件旋转后放置     | `scene.place`                                                | 变换后的格、状态、放置与挖除计划                 |
| 场景自己的断言         | `scene.verify(id, world => diagnostics)`                     | 自动执行的最终检查                               |

具体几何参数见 [API 参考](authoring.md)。`scene.road` 使用 `route` 控制点，自动解纵断面并给端点和转角留平台。
道路只固定起点与终点的路面标高；中间点控制 X/Z 线位。要精确指定每格高度，直接规划道路再交给 `scene.walkway({ road })`。
`scene.water/canal` 的水段可以用 `route` 控制点，也可以用 `path` 提供逐格采样；`surfaceAt/bedAt` 的 `step` 对应展开后的实际格。

## 材料与造型分别调整

常量材料直接传值：

```ts
scene.walkway('bridge', {
  route: [
    [0, 8, 0],
    [24, 8, 0],
  ],
  width: 5,
  materials: {
    surface: 'spruce_planks',
    beam: 'dark_oak_planks',
    pier: 'dark_oak_log',
    rail: 'dark_oak_fence',
  },
});
```

材料回调接收原组件的几何上下文。道路/步道的固定 `stairs` 材料会自动采用实际踏步方向；
回调返回完整状态时保留作者的选择，由通行检查验证结果。

需要改变形状时，替换相应的生成回调即可。步道的 `builders` 提供 `deck/beams/support/railing/details`；
未替换的构件继续使用默认实现。一个偏移柱脚的例子：

```ts
builders: {
  support: (sink, site, context) => {
    const footX = site.x + 2;
    const ground = context.surface.terrain(footX, site.z);
    if (ground === null) throw new Error('没有真实柱脚');
    const underside = site.deckY - context.deckThickness + 1;
    for (let y = ground + 1; y <= underside; y++)
      sink.put(footX, y, site.z, 'stone_bricks');
    for (let x = site.x; x <= footX; x++)
      sink.put(x, underside, site.z, 'stone_bricks');
    return { footings: [[footX, ground, site.z]] };
  },
}
```

回调只在规划阶段执行。最终检查读取已经生成的几何，不重跑材料和造型回调。
屋顶可用 `heightAt/profile/surface/decorate`；树可用 `branches/contains/sample`；栏杆可用 `style.place`。
这些原函数都接受 `BlockKit`，因此也可以在一个 `scene.draw` 中组合成自己的原子构件。

## 组合时共用计划

`const bridge = scene.walkway(...)` 返回实际桥路计划。水渠的 `crossings` 可以直接接收
`[{ road: bridge.road, deckThickness: 2 }]`，按共同桥底限制开挖和检查水位。
屋顶装饰使用屋面计划里的檐口和脊线；林地的 `roads` 接收道路计划以避开路面。
更新公共输入后重新生成，相关构件从这些数据一起重算；框架不会自动修改已经返回的模型。

`scene.surfaces` 始终查询当前模型，修改后按 revision 更新。独立地形公式适用于设计输入；
完成挖填、铺路和架桥后，后续植被、支点等应查询实际表面。

## 坐标、筛选与覆盖

- `Box` 和 `kit.fill(box, material)` / `kit.carve(box)` 都是半开区间。`max` 不包含在范围内。
- 屋顶等 `RectXZ` 的 `x0/x1/z0/z1` 是闭区间；旧的六坐标 `kit.fill/carve` 也是闭区间。
- `where(x,z)` 在地形、花草、植被和道路中统一表示 **返回 true 才允许生成**。旧 `mask` 参数已移除。
- 方块名、完整 `State` 和材料回调均可用；框架按固定目标注册表验证完整状态。
- 普通构件默认可替换自然地形，相同方块与状态的重复放置是幂等的。场景记录归属，天然岩石与同材质的人工构件能被区分；已有未记录模型按地形材料识别。覆盖或挖除其他构筑物时在构件选项传 `{ overlap: 'replace' }`，或给出判断函数。
- 构件 `bounds` 可以收窄操作范围，不能扩展场景边界。预制件中的显式空气也要满足范围、覆盖和保护规则。
- 保护区始终参与规划与最终检查；允许覆盖不会绕过保护区。`scene.protect` 声明空间，`scene.verify` 声明额外断言。

## 失败与检查

场景构件在规划时解析材料、边界、覆盖权限和保护区；无法施工时抛出带对象和位置的 `DiagnosticError`，
目标 `Structure` 不会留下部分构件。非法坐标、材料回调错误和造型回调错误同样处理。失败后可以用同一个 id 重试。
同一场景内成功构件 id 必须唯一，避免检查归属含糊。

在 `scene.draw` 中只通过传入的 `kit` 绘制，它的 `get/empty` 读取原模型加待提交操作。
生成回调必须同步；不能在回调内部再施工另一个 scene 构件。需要共享一个提交边界时，在同一个 `draw` 内组合原函数。
`scene.world` 用于返回模型和高级直接访问；直接修改不会享有施工规划的保护，最终检查仍能定位已记录构件的变化。

`scene.check()` 可随时手动查看诊断。`bewright build/check` 自动执行注册构件及额外断言，也会执行建筑自己声明的 `check()`。
接地组件在施工阶段检查整地净空，最终检查保留地坪和基础约束，允许后续主体在其上立柱。
应返回原来的 `scene.world`；复制或合并体素不会自动转移构件检查。
`--no-check` 显式跳过这些检查，并报告 `not-run`；无检查的原始 `Structure` 仍报告 `none`。
未知碰撞保持 `unknown`，不能算通过。静态检查不模拟流体更新或结构受力，也不等于实机验收。

所有场景操作都检查材料、操作范围、覆盖与保护规则，并记录已解析状态供最终复查。
额外的语义检查按构件提供：

| 构件       | 自动复查内容                           |
| ---------- | -------------------------------------- |
| 屋顶       | 屋面格的邻接支撑                       |
| 树         | 生成时树冠连通、最终枝干与树冠完整性   |
| 道路、步道 | 实际路面通行、基础、构件连接与净空     |
| 水体、水渠 | 容水边界、水段连接、河床护岸与桥下净空 |
| 接地       | 地坪、基础与架空空间                   |
| 植被群落   | 已生成植物的占格、根部支撑与连通性     |

`draw/railing/plants/terrain/place` 提供通用施工与状态复查；场景特有的受力、花草后续土壤变化、室内动线等约束由 `scene.verify` 声明。
在场景入口中用 `overlap` 统一管理覆盖，用 `scene.protect` 管理保护区；树的低层 `collision` 及群落独立保护区参数不再重复暴露。

## 旧调用的迁移

- 原地形 `mask` 返回 true 表示排除；改成 `where: (x,z) => !oldMask(x,z)`。道路、花草、植被的旧 `mask` 本来表示包含，只需改名。
- 原几何函数仍可用 `StructureKit` 直接生成独立构件；推荐用 `scene.draw` 组织场景，避免自己管理施工计划和构件检查。`BlockKit` 不暴露内部目标，构件回调通过 `kit.get` 查询。
- 子类若定制填充行为，覆盖 `protected fillBox(box, material)`，两种公开 `fill` 调用都会进入它。旧的自定义双端点 `line` 方法需要改名；新的 `line(path, material)` 绘制面连通线。
- 原建筑自有 `check()` 可以保留，框架自动构件检查会先执行；无需把旧建筑全部迁入 scene 才能使用公共几何函数。
