import type { ChecklistItem, FlightStage } from './types';

/**
 * 离线三方合并。
 *
 * 两位值班编辑员在断开连接时各自持有同一份检查单快照（base），
 * 离线修改后重新连接。合并规则：
 * - 检查项的挑战语、预期回应、异常处置、关键标记按最后编辑时间（updatedAt）保留；
 * - 前置条件取两边并集，指向“已被移除检查项”的悬挂前置条件列为冲突，由人工选择；
 * - 一边移除、另一边又修改过的检查项列为“删除/修改”冲突，由人工选择保留或删除；
 * - 阶段取并集，名称/描述按最后编辑时间保留，顺序重排后重算可达性。
 */

export type MergeConflictKind = 'dangling-precondition' | 'modify-delete-item';
export type MergeResolution = 'remove-precondition' | 'restore-item' | 'keep-item' | 'delete-item';

export interface MergeConflict {
  id: string;
  kind: MergeConflictKind;
  title: string;
  detail: string;
  /** 被移除 / 缺失的检查项 id（dangling 时为前置条件指向的项，modify-delete 时为被删的项）。 */
  itemId?: string;
  itemChallenge?: string;
  /** dangling：持有该前置条件的检查项。 */
  holderItemId?: string;
  holderChallenge?: string;
  /** dangling：前置条件 id（即 itemId）。 */
  preconditionId?: string;
  defaultResolution: MergeResolution;
}

export interface MergeResult {
  stages: FlightStage[];
  items: ChecklistItem[];
  /** 默认合并结果上检测到的冲突（modify-delete 与 dangling）。 */
  conflicts: MergeConflict[];
  /** 未进入合并结果的检查项数据，用于“恢复检查项”。 */
  deletedItemData: Record<string, ChecklistItem>;
  addedItemIds: string[];
  removedItemIds: string[];
  modifiedItemIds: string[];
}

const byId = <T extends { id: string }>(list: T[]): Map<string, T> => new Map(list.map((entry) => [entry.id, entry]));

const newer = <T extends { updatedAt?: string }>(a: T, b: T): T => ((b.updatedAt ?? '') > (a.updatedAt ?? '') ? b : a);

const itemText = (item: ChecklistItem) => `${item.challenge}|${item.response}|${item.abnormalProcedure}|${item.critical ? 1 : 0}`;

function itemContentChanged(item: ChecklistItem, base: ChecklistItem): boolean {
  return itemText(item) !== itemText(base);
}

function unionPreconditions(...lists: (string[] | undefined)[]): string[] {
  return [...new Set(lists.flat().filter((value): value is string => typeof value === 'string'))];
}

function reorderStages(stages: FlightStage[]): FlightStage[] {
  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((a, b) => a.stage.order - b.stage.order || a.index - b.index)
    .map(({ stage }, order) => ({ ...stage, order }));
}

function reorderItems(items: ChecklistItem[], stages: FlightStage[]): ChecklistItem[] {
  const stageOrder = new Map(stages.map((stage) => [stage.id, stage.order]));
  const counters = new Map<string, number>();
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sa = stageOrder.get(a.item.stageId) ?? Number.MAX_SAFE_INTEGER;
      const sb = stageOrder.get(b.item.stageId) ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.item.order - b.item.order || a.index - b.index;
    })
    .map(({ item }) => {
      const order = counters.get(item.stageId) ?? 0;
      counters.set(item.stageId, order + 1);
      return { ...item, order };
    });
}

export function threeWayMerge(
  _baseStages: FlightStage[],
  baseItems: ChecklistItem[],
  ourStages: FlightStage[],
  ourItems: ChecklistItem[],
  theirStages: FlightStage[],
  theirItems: ChecklistItem[]
): MergeResult {
  const bItems = byId(baseItems);
  const oItems = byId(ourItems);
  const tItems = byId(theirItems);
  const oStages = byId(ourStages);
  const tStages = byId(theirStages);

  const mergedItems: ChecklistItem[] = [];
  const conflicts: MergeConflict[] = [];
  const deletedItemData: Record<string, ChecklistItem> = {};
  const addedItemIds: string[] = [];
  const removedItemIds: string[] = [];
  const modifiedItemIds: string[] = [];

  const allItemIds = new Set([...bItems.keys(), ...oItems.keys(), ...tItems.keys()]);
  for (const id of allItemIds) {
    const b = bItems.get(id);
    const o = oItems.get(id);
    const t = tItems.get(id);

    if (b && o && t) {
      // 两边都保留或修改：内容按最后编辑时间保留，前置条件取并集。
      const content = newer(o, t);
      mergedItems.push({ ...content, preconditionIds: unionPreconditions(o.preconditionIds, t.preconditionIds) });
      if (itemContentChanged(o, b) || itemContentChanged(t, b)) modifiedItemIds.push(id);
    } else if (!b && o && t) {
      // 两边各自新增了同一项（id 相同）：内容按最后编辑时间保留。
      const content = newer(o, t);
      mergedItems.push({ ...content, preconditionIds: unionPreconditions(o.preconditionIds, t.preconditionIds) });
      addedItemIds.push(id);
    } else if (b && o && !t) {
      // 对方删除，我方保留。
      deletedItemData[id] = o;
      if (itemContentChanged(o, b)) {
        conflicts.push({
          id: `modify-delete-${id}`,
          kind: 'modify-delete-item',
          title: '检查项被一边删除、另一边修改',
          detail: `“${o.challenge || '未命名检查项'}”被对方离线副本删除，但我方做了修改。请选择保留修改后的检查项，或按删除处理。`,
          itemId: id,
          itemChallenge: o.challenge,
          defaultResolution: 'keep-item'
        });
        mergedItems.push(o);
      } else {
        removedItemIds.push(id);
      }
    } else if (b && !o && t) {
      // 我方删除，对方保留。
      deletedItemData[id] = t;
      if (itemContentChanged(t, b)) {
        conflicts.push({
          id: `modify-delete-${id}`,
          kind: 'modify-delete-item',
          title: '检查项被一边删除、另一边修改',
          detail: `“${t.challenge || '未命名检查项'}”被我方删除，但对方离线副本做了修改。请选择保留修改后的检查项，或按删除处理。`,
          itemId: id,
          itemChallenge: t.challenge,
          defaultResolution: 'keep-item'
        });
        mergedItems.push(t);
      } else {
        removedItemIds.push(id);
      }
    } else if (!b && o && !t) {
      mergedItems.push(o);
      addedItemIds.push(id);
    } else if (!b && !o && t) {
      mergedItems.push(t);
      addedItemIds.push(id);
    } else if (b && !o && !t) {
      // 两边都删除。
      deletedItemData[id] = b;
      removedItemIds.push(id);
    }
  }

  // 阶段取并集：任一边保留即保留；名称/描述按最后编辑时间保留；顺序之后重排。
  const mergedStages: FlightStage[] = [];
  const allStageIds = new Set([...oStages.keys(), ...tStages.keys()]);
  for (const id of allStageIds) {
    const o = oStages.get(id);
    const t = tStages.get(id);
    if (o && t) mergedStages.push(newer(o, t));
    else mergedStages.push((o ?? t)!);
  }

  const orderedStages = reorderStages(mergedStages);
  const orderedItems = reorderItems(mergedItems, orderedStages);

  return {
    stages: orderedStages,
    items: orderedItems,
    conflicts,
    deletedItemData,
    addedItemIds,
    removedItemIds,
    modifiedItemIds
  };
}

/** 检测悬挂前置条件：前置条件指向的检查项不在合并结果中。 */
export function detectDangling(items: ChecklistItem[]): MergeConflict[] {
  const ids = new Set(items.map((item) => item.id));
  const conflicts: MergeConflict[] = [];
  for (const item of items) {
    for (const preconditionId of item.preconditionIds) {
      if (!ids.has(preconditionId)) {
        conflicts.push({
          id: `dangling-${item.id}-${preconditionId}`,
          kind: 'dangling-precondition',
          title: '前置条件指向已移除的检查项',
          detail: `“${item.challenge || '未命名检查项'}”的前置条件指向已被移除的检查项。可移除该前置条件，或恢复被移除的检查项。`,
          itemId: preconditionId,
          holderItemId: item.id,
          holderChallenge: item.challenge,
          preconditionId,
          defaultResolution: 'remove-precondition'
        });
      }
    }
  }
  return conflicts;
}

/** 应用“删除/修改”冲突的选择：delete-item 时把检查项移出合并结果。 */
export function applyModifyDelete(items: ChecklistItem[], conflicts: MergeConflict[], resolutions: Record<string, MergeResolution>): ChecklistItem[] {
  const removed = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.kind !== 'modify-delete-item') continue;
    if ((resolutions[conflict.id] ?? conflict.defaultResolution) === 'delete-item' && conflict.itemId) {
      removed.add(conflict.itemId);
    }
  }
  return removed.size ? items.filter((item) => !removed.has(item.id)) : items;
}

/** 应用悬挂前置条件冲突的选择：remove-precondition 移除前置条件，restore-item 恢复被删检查项。 */
export function applyDangling(
  items: ChecklistItem[],
  conflicts: MergeConflict[],
  resolutions: Record<string, MergeResolution>,
  deletedItemData: Record<string, ChecklistItem>,
  stages: FlightStage[]
): ChecklistItem[] {
  let result = items;
  const ids = new Set(result.map((item) => item.id));
  for (const conflict of conflicts) {
    if (conflict.kind !== 'dangling-precondition' || !conflict.holderItemId || !conflict.preconditionId) continue;
    const resolution = resolutions[conflict.id] ?? conflict.defaultResolution;
    if (resolution === 'restore-item') {
      const data = deletedItemData[conflict.preconditionId];
      if (data && !ids.has(data.id)) {
        result = [...result, data];
        ids.add(data.id);
      }
    } else {
      result = result.map((item) =>
        item.id === conflict.holderItemId ? { ...item, preconditionIds: item.preconditionIds.filter((id) => id !== conflict.preconditionId) } : item
      );
    }
  }
  return reorderItems(result, stages);
}
