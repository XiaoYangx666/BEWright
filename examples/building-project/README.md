# 建筑项目范本

把这个目录复制到自己的工作区，从复制后的目录运行 BEWright。下面的命令使用 PATH 上的 `bewright`，也可以用 `node <BEWright 仓库>/dist/cli/index.js` 调用已编译的工具。

```text
src/
  buildings/        建筑源码，每座建筑一个目录
  layouts/          地图布局，记录建筑实例和落点
dist/               预览、结构和源码包，按需生成
cache/              可重建缓存
worlds/             本地存档
.bewright/          本地部署目标、基线和恢复备份
```

## 生成与预览

```sh
bewright list
bewright build starter-arch
bewright preview starter-arch
bewright import --layout src/layouts/starter.json --local --folder starter --dry-run
```

预览写到 `dist/previews/starter-arch/`。新增建筑用 `bewright init <id>`，源码会放到 `src/buildings/<id>/`。要把它放进地图，在对应布局中增加一个实例。

## 创建开发地图

首次写入地图时，如果还没有可用的写入器，先运行 `bewright sidecar build`。用上面预演过的布局创建本地存档、绑定目标并登记源码基线。

```sh
bewright import --layout src/layouts/starter.json --local --folder starter
bewright target add dev --layout src/layouts/starter.json --world worlds/bedrock/starter
bewright deploy dev --adopt
```

之后改完源码，关闭目标存档再部署。项目只有一个目标时可以省略目标名。示例的建筑 ID 是 `starter-arch`，布局中的实例 ID 是 `entrance`。

```sh
bewright diff --only entrance
bewright deploy --only entrance --dry-run
bewright deploy --only entrance
```

提交项目时保留 `src/` 和项目配置。生成目录、存档和本地部署数据由范本的 `.gitignore` 排除。需要分享可编辑源码时，用 `bewright pack --layout src/layouts/starter.json`，ZIP 会生成在 `dist/packages/`。
