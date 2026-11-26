import { type State, type Structure, type Box } from '../core/structure.js';
import { validateBlockState } from '../blocks/registry.js';
import { material } from '../blocks/materials.js';
import { visualGeometry } from '../blocks/shapes.js';
import { collisionBoxes } from '../authoring/traversal.js';
import { toJavaBlockState } from '../targets/java/blocks.js';

import type { BlockSupportGate as Gate, BlockSupportReport, BuildingBlockSupportReport } from '../blocks/support-types.js';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Query the actual adapters; do not maintain a second, drifting support whitelist. */
export function blockSupport(state: State): BlockSupportReport {
  let registry: Gate;
  try {
    validateBlockState(state);
    registry = { status: 'supported', detail: '完整状态通过固定基岩注册表校验' };
  } catch (error) {
    registry = { status: 'unsupported', detail: message(error) };
  }
  let materialHelper: Gate;
  try {
    material(state.name.replace(/^minecraft:/, ''));
    materialHelper = { status: 'supported', detail: 'material() 可生成默认状态；指定状态使用 minecraftBlock()' };
  } catch (error) {
    materialHelper = {
      status: 'unsupported',
      detail:
        registry.status === 'supported'
          ? 'material() 仅用于完整立方体；此方块请使用 minecraftBlock(name, overrides)，预览是否支持见预览列'
          : message(error),
    };
  }
  let preview: Gate, collision: Gate, javaMapping: Gate;
  if (registry.status !== 'supported') {
    preview = collision = javaMapping = { status: 'unknown', detail: '先修正方块名称或完整状态，再检查此环节' };
  } else {
    try {
      const result = visualGeometry(state, () => null);
      preview = result.placeholder
        ? { status: 'unsupported', detail: result.placeholder }
        : { status: 'supported', detail: '有预览几何；连接形状仍取决于邻居' };
    } catch (error) {
      preview = { status: 'unsupported', detail: message(error) };
    }
    try {
      const result = collisionBoxes(state);
      collision =
        result.kind === 'unknown'
          ? { status: 'unknown', detail: result.reason }
          : {
              status: 'supported',
              detail: `通行检查器有碰撞模型（${result.boxes.length} 个碰撞盒），不代表游戏物理完全一致`,
            };
    } catch (error) {
      collision = { status: 'unknown', detail: message(error) };
    }
    try {
      const mapped = toJavaBlockState(state);
      javaMapping = { status: 'mapped', detail: JSON.stringify(mapped) + '；转换器接受，不等于目标客户端已验证' };
    } catch (error) {
      javaMapping = { status: 'unsupported', detail: message(error) };
    }
  }
  return {
    name: state.name,
    states: state.states,
    registry,
    materialHelper,
    preview,
    collision,
    bedrock:
      registry.status === 'supported'
        ? ({ status: 'supported', detail: '方块状态可编码；不包含方块实体数据、世界写入或游戏验收' } as Gate)
        : registry,
    javaMapping,
  };
}

/** Only placed palette entries, with a location for finding the affected block. */
export function buildingBlockSupport(world: Structure, region?: Box): BuildingBlockSupportReport {
  const used = new Map<number, { count: number; sample: number[] }>();
  world.forEach((x, y, z, id) => {
    const entry = used.get(id);
    if (entry) entry.count++;
    else used.set(id, { count: 1, sample: [x, y, z] });
  }, region);
  return [...used].map(([id, usage]) => ({ ...blockSupport(world.palette[id]!), ...usage }));
}
