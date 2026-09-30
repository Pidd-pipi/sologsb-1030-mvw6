import type {
  ChecklistItem,
  ChecklistProject,
  MergeConflict,
  MergeNote,
  MergePlan,
  MergeResolution,
  MergeResult,
  OfflineBranchPack,
  ProjectSnapshot
} from './types';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const SCALAR_FIELDS = ['challenge', 'response', 'abnormalProcedure', 'critical'] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];
const fieldLabel: Record<ScalarField, string> = {
  challenge: '挑战语',
  response: '预期回应',
  abnormalProcedure: '异常处置',
  critical: '关键标记'
};

const byId = <T extends { id: string }>(entries: T[]) => new Map(entries.map((entry) => [entry.id, entry]));
const contentSignature = (item: ChecklistItem) =>
  JSON.stringify(SCALAR_FIELDS.map((field) => item[field]));
/** Strictly later timestamp wins; equal timestamps favour the local copy. */
const remoteIsNewer = (remoteUpdatedAt: string, localUpdatedAt: string) => remoteUpdatedAt > localUpdatedAt;

export function projectToSnapshot(project: ChecklistProject): ProjectSnapshot {
  return {
    name: project.name,
    aircraft: project.aircraft,
    updatedAt: project.updatedAt,
    stages: clone(project.stages),
    items: clone(project.items)
  };
}

export function buildBranchPack(project: ChecklistProject, editor: string): OfflineBranchPack {
  const snapshot = projectToSnapshot(project);
  return {
    kind: 'flightline-branch',
    packVersion: 1,
    syncId: project.sync?.syncId ?? uid('sync'),
    editor: editor.trim() || '离线编辑',
    exportedAt: new Date().toISOString(),
    baseSnapshot: clone(project.sync?.baseSnapshot ?? snapshot),
    snapshot
  };
}

/** After a merge the result itself becomes the new base for the next offline round. */
export function buildMergedPack(syncId: string, editor: string, snapshot: ProjectSnapshot): OfflineBranchPack {
  return {
    kind: 'flightline-branch',
    packVersion: 1,
    syncId,
    editor: editor.trim() || '本机编辑',
    exportedAt: new Date().toISOString(),
    baseSnapshot: clone(snapshot),
    snapshot: clone(snapshot)
  };
}

export function parseBranchPack(raw: string): OfflineBranchPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('文件不是有效的 JSON。');
  }
  const pack = parsed as Partial<OfflineBranchPack>;
  if (
    pack?.kind !== 'flightline-branch' ||
    pack.packVersion !== 1 ||
    typeof pack.syncId !== 'string' ||
    !pack.snapshot?.stages ||
    !pack.snapshot?.items ||
    !pack.baseSnapshot?.stages ||
    !pack.baseSnapshot?.items
  ) {
    throw new Error('缺少离线副本所需的基准快照，请确认文件来自“导出离线副本”。');
  }
  return pack as OfflineBranchPack;
}

export function projectFromBranchPack(pack: OfflineBranchPack): ChecklistProject {
  return {
    id: uid('project'),
    name: pack.snapshot.name,
    aircraft: pack.snapshot.aircraft,
    revision: 1,
    status: 'draft',
    updatedAt: pack.snapshot.updatedAt,
    reviewNote: '',
    stages: clone(pack.snapshot.stages),
    items: clone(pack.snapshot.items),
    revisions: [],
    sync: {
      syncId: pack.syncId,
      editor: pack.editor || '离线编辑',
      baseSnapshot: clone(pack.baseSnapshot)
    }
  };
}

/**
 * Compares the local copy against a remote offline copy. Both are diffed from
 * the shared base snapshot so that unilateral deletions can be told apart from
 * deletions that conflict with edits or newly added preconditions.
 */
export function planMerge(base: ProjectSnapshot, local: ProjectSnapshot, remote: ProjectSnapshot, remoteEditor = '对方编辑'): MergePlan {
  const baseItems = byId(base.items);
  const localItems = byId(local.items);
  const remoteItems = byId(remote.items);
  const conflicts: MergeConflict[] = [];

  const sideName = (side: 'local' | 'remote') => (side === 'local' ? '本机' : `对端「${remoteEditor}」`);

  for (const id of new Set([...baseItems.keys(), ...localItems.keys(), ...remoteItems.keys()])) {
    const b = baseItems.get(id);
    const l = localItems.get(id);
    const r = remoteItems.get(id);
    if ((l && r) || !b) continue;
    const survivor = l ?? r;
    if (!survivor) continue; // removed on both sides
    const deletedSide: 'local' | 'remote' = l ? 'remote' : 'local';
    const changedSide: 'local' | 'remote' = l ? 'local' : 'remote';
    const edited = contentSignature(survivor) !== contentSignature(b);
    const survivingSnapshot = l ? local : remote;
    const newReferrers = survivingSnapshot.items.filter((candidate) => {
      if (!candidate.preconditionIds.includes(id) || candidate.id === id) return false;
      const baseReferrer = baseItems.get(candidate.id);
      return !baseReferrer || !baseReferrer.preconditionIds.includes(id);
    });
    if (!edited && newReferrers.length === 0) continue; // unilateral deletion, nothing to salvage

    const referrerLabels = newReferrers.map((entry) => `「${entry.challenge || '未命名检查项'}」`).join('、');
    const reasons = [
      edited ? `仍修改了挑战语 / 回应 / 异常处置等内容` : '',
      newReferrers.length ? `${referrerLabels} 新增了指向它的前置条件` : ''
    ].filter(Boolean);
    conflicts.push({
      id: `conflict-${id}`,
      kind: newReferrers.length ? 'deleted-vs-precondition' : 'deleted-vs-edited',
      itemId: id,
      deletedSide,
      changedSide,
      challenge: survivor.challenge || b.challenge || '未命名检查项',
      referrerIds: newReferrers.map((entry) => entry.id),
      detail: `${sideName(deletedSide)}移除了检查项“${survivor.challenge || b.challenge || '未命名检查项'}”，但${sideName(changedSide)}${reasons.join('，且')}。请选择保留该项还是确认删除。`
    });
  }

  return { base: clone(base), local: clone(local), remote: clone(remote), remoteEditor, conflicts, notes: [] };
}

/**
 * Produces the merged snapshot for a set of conflict resolutions. Scalar fields
 * use last-edit-time wins, precondition id sets union additions and only drop a
 * link when both sides removed it, then orderings are merged and renumbered so
 * reachability can be revalidated by the caller.
 */
export function resolveMerge(plan: MergePlan, resolutions: Record<string, MergeResolution>): MergeResult {
  const { base, local, remote } = plan;
  const notes: MergeNote[] = [];
  const baseItems = byId(base.items);
  const localItems = byId(local.items);
  const remoteItems = byId(remote.items);

  const deletedByChoice = new Set(
    plan.conflicts.filter((conflict) => (resolutions[conflict.id] ?? 'keep') === 'delete').map((conflict) => conflict.itemId)
  );
  const conflictByItem = new Map(plan.conflicts.map((conflict) => [conflict.itemId, conflict]));

  const mergedItems = new Map<string, ChecklistItem>();
  for (const id of new Set([...baseItems.keys(), ...localItems.keys(), ...remoteItems.keys()])) {
    const b = baseItems.get(id);
    const l = localItems.get(id);
    const r = remoteItems.get(id);

    if (l && r) {
      if (deletedByChoice.has(id)) continue;
      mergedItems.set(id, mergeItemFields(b, l, r, plan, notes));
      continue;
    }
    const survivor = l ?? r;
    if (!survivor || deletedByChoice.has(id)) {
      if (b && survivor && deletedByChoice.has(id)) {
        notes.push({ id: `note-remove-${id}`, kind: 'item-removed', message: `冲突已按删除解决：检查项“${survivor.challenge || b.challenge}”未进入合并结果。` });
      }
      continue;
    }
    const conflict = conflictByItem.get(id);
    if (b && conflict) {
      // A listed conflict defaults to keep: the deletion is rejected and any
      // new precondition links stay valid through the set merge below.
      mergedItems.set(id, clone(survivor));
      continue;
    }
    if (!b) {
      notes.push({
        id: `note-add-${id}`,
        kind: 'item-added',
        message: `${l ? '本机' : `对端「${plan.remoteEditor}」`}新增检查项“${survivor.challenge || '未命名检查项'}”，已并入。`
      });
    } else if (contentSignature(survivor) === contentSignature(b)) {
      notes.push({
        id: `note-remove-${id}`,
        kind: 'item-removed',
        message: `“${survivor.challenge || b.challenge}”仅由${l ? `对端「${plan.remoteEditor}」` : '本机'}移除，另一方未改动，已按删除合并。`
      });
      continue;
    }
    mergedItems.set(id, clone(survivor));
  }

  const { stages: mergedStages, stageOrderWinner } = mergeStages(base, local, remote, mergedItems, plan, notes);
  placeItems(local, remote, mergedItems, stageOrderWinner, mergedStages, notes, plan);

  // Precondition links must only survive against items that made the merge,
  // and the set merge below implements both-side-removal semantics.
  const aliveIds = new Set(mergedItems.keys());
  for (const item of mergedItems.values()) {
    const b = baseItems.get(item.id);
    const l = localItems.get(item.id);
    const r = remoteItems.get(item.id);
    const baseSet = new Set(b?.preconditionIds ?? []);
    const localSet = new Set(l?.preconditionIds ?? []);
    const remoteSet = new Set(r?.preconditionIds ?? []);
    const kept: string[] = [];
    const consider = l ? [...l.preconditionIds, ...(r?.preconditionIds ?? [])] : [...(r?.preconditionIds ?? [])];
    for (const preconditionId of consider) {
      const removedLocally = b && l && baseSet.has(preconditionId) && !localSet.has(preconditionId);
      const removedRemotely = b && r && baseSet.has(preconditionId) && !remoteSet.has(preconditionId);
      if (removedLocally && removedRemotely) continue;
      if (kept.includes(preconditionId)) continue;
      kept.push(preconditionId);
    }
    item.preconditionIds = kept.filter((preconditionId) => aliveIds.has(preconditionId));
    if (l && r && b) {
      const localSig = [...l.preconditionIds].sort().join('|');
      const remoteSig = [...r.preconditionIds].sort().join('|');
      const mergedSig = [...item.preconditionIds].sort().join('|');
      if (localSig !== remoteSig && mergedSig !== localSig && mergedSig !== remoteSig) {
        notes.push({ id: `note-pre-${item.id}`, kind: 'precondition-set', message: `“${item.challenge || '未命名检查项'}”的前置条件集合双方改动不同，已按各自新增并入、共同删除移除。` });
      }
    }
  }

  const metadata = mergeMetadata(base, local, remote, notes);

  const snapshot: ProjectSnapshot = {
    ...metadata,
    updatedAt: [base.updatedAt, local.updatedAt, remote.updatedAt].sort().at(-1) ?? local.updatedAt,
    stages: mergedStages,
    items: [...mergedItems.values()]
  };
  return { snapshot, conflicts: plan.conflicts, notes };
}

function mergeItemFields(baseItem: ChecklistItem | undefined, localItem: ChecklistItem, remoteItem: ChecklistItem, plan: MergePlan, notes: MergeNote[]): ChecklistItem {
  const merged = clone(localItem);
  const target = merged as Record<ScalarField, string | boolean>;
  for (const field of SCALAR_FIELDS) {
    const localValue = localItem[field] as string | boolean;
    const remoteValue = remoteItem[field] as string | boolean;
    if (localValue === remoteValue) {
      target[field] = localValue;
      continue;
    }
    const baseValue = baseItem?.[field] as string | boolean | undefined;
    if (baseValue !== undefined && localValue === baseValue) {
      target[field] = remoteValue;
    } else if (baseValue !== undefined && remoteValue === baseValue) {
      target[field] = localValue;
    } else {
      const remoteWins = remoteIsNewer(remoteItem.updatedAt, localItem.updatedAt);
      target[field] = remoteWins ? remoteValue : localValue;
      notes.push({
        id: `note-lww-${localItem.id}-${field}`,
        kind: 'field-lww',
        message: `“${localItem.challenge || '未命名检查项'}”的${fieldLabel[field]}双方都有改动，按最后编辑时间保留${remoteWins ? `对端「${plan.remoteEditor}」` : '本机'}版本。`
      });
    }
  }
  merged.updatedAt = remoteIsNewer(remoteItem.updatedAt, localItem.updatedAt) ? remoteItem.updatedAt : localItem.updatedAt;
  return merged;
}

function mergeStages(
  base: ProjectSnapshot,
  local: ProjectSnapshot,
  remote: ProjectSnapshot,
  mergedItems: Map<string, ChecklistItem>,
  plan: MergePlan,
  notes: MergeNote[]
): { stages: ProjectSnapshot['stages']; stageOrderWinner: 'local' | 'remote' } {
  const baseStages = byId(base.stages);
  const localStages = byId(local.stages);
  const remoteStages = byId(remote.stages);
  const stages = new Map<string, ProjectSnapshot['stages'][number]>();

  for (const id of new Set([...baseStages.keys(), ...localStages.keys(), ...remoteStages.keys()])) {
    const b = baseStages.get(id);
    const l = localStages.get(id);
    const r = remoteStages.get(id);
    if (l && r) {
      const mergedStage = clone(l);
      (['name', 'description'] as const).forEach((field) => {
        if (l[field] !== r[field]) {
          if (b && l[field] === b[field]) mergedStage[field] = r[field];
          else if (b && r[field] === b[field]) mergedStage[field] = l[field];
          else mergedStage[field] = remoteIsNewer(remote.updatedAt, local.updatedAt) ? r[field] : l[field];
        }
      });
      stages.set(id, mergedStage);
      continue;
    }
    const survivor = l ?? r;
    if (!survivor) continue;
    if (b) {
      const stillUsed = [...mergedItems.values()].some((item) => item.stageId === id);
      if (!stillUsed) {
        notes.push({ id: `note-stage-remove-${id}`, kind: 'stage-removed', message: `飞行阶段“${survivor.name}”仅由${l ? `对端「${plan.remoteEditor}」` : '本机'}移除且无检查项残留，已删除。` });
        continue;
      }
    } else {
      notes.push({ id: `note-stage-add-${id}`, kind: 'stage-added', message: `${l ? '本机' : `对端「${plan.remoteEditor}」`}新增飞行阶段“${survivor.name}”，已并入。` });
    }
    stages.set(id, clone(survivor));
  }

  const localChanged = stageSignature(local) !== stageSignature(base);
  const remoteChanged = stageSignature(remote) !== stageSignature(base);
  const winner: 'local' | 'remote' = localChanged && !remoteChanged
    ? 'local'
    : !localChanged && remoteChanged
      ? 'remote'
      : remoteIsNewer(remote.updatedAt, local.updatedAt)
        ? 'remote'
        : 'local';

  const winnerStageIds = (winner === 'local' ? local.stages : remote.stages).map((stage) => stage.id).filter((id) => stages.has(id));
  const loserStageIds = (winner === 'local' ? remote.stages : local.stages)
    .map((stage) => stage.id)
    .filter((id) => stages.has(id) && !winnerStageIds.includes(id));
  const orderedStages = [...winnerStageIds, ...loserStageIds].map((id) => stages.get(id)!);
  orderedStages.forEach((stage, order) => { stage.order = order; });
  return { stages: orderedStages, stageOrderWinner: winner };
}

const stageSignature = (snapshot: ProjectSnapshot) =>
  snapshot.stages.slice().sort((a, b) => a.order - b.order).map((stage) => stage.id).join('|');

function itemSequence(snapshot: ProjectSnapshot): ChecklistItem[] {
  const stageOrder = byId(snapshot.stages);
  return snapshot.items.slice().sort((a, b) => {
    const stageDelta = (stageOrder.get(a.stageId)?.order ?? Number.MAX_SAFE_INTEGER) - (stageOrder.get(b.stageId)?.order ?? Number.MAX_SAFE_INTEGER);
    return stageDelta !== 0 ? stageDelta : a.order - b.order;
  });
}

function placeItems(
  local: ProjectSnapshot,
  remote: ProjectSnapshot,
  mergedItems: Map<string, ChecklistItem>,
  stageOrderWinner: 'local' | 'remote',
  mergedStages: ProjectSnapshot['stages'],
  notes: MergeNote[],
  plan: MergePlan
) {
  const localChanged = itemSequenceSignature(local) !== itemSequenceSignature(plan.base);
  const remoteChanged = itemSequenceSignature(remote) !== itemSequenceSignature(plan.base);
  const winner = localChanged && !remoteChanged
    ? 'local'
    : !localChanged && remoteChanged
      ? 'remote'
      : remoteIsNewer(remote.updatedAt, local.updatedAt)
        ? 'remote'
        : 'local';

  const winnerItems = winner === 'local' ? local.items : remote.items;
  const winnerById = byId(winnerItems);
  const sequence = itemSequence(winner === 'local' ? local : remote)
    .map((item) => item.id)
    .filter((id) => mergedItems.has(id));
  const winnerSet = new Set(sequence);

  const loserSequence = itemSequence(winner === 'local' ? remote : local).filter((item) => mergedItems.has(item.id) && !winnerSet.has(item.id));
  const loserIndex = new Map(loserSequence.map((item, index) => [item.id, index]));
  for (const loserItem of loserSequence) {
    const currentIndex = loserIndex.get(loserItem.id)!;
    let insertAt = -1;
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const anchor = loserSequence[index];
      const placed = sequence.indexOf(anchor.id);
      if (placed >= 0) { insertAt = placed + 1; break; }
    }
    if (insertAt < 0) {
      for (let index = currentIndex + 1; index < loserSequence.length; index += 1) {
        const anchor = loserSequence[index];
        const placed = sequence.indexOf(anchor.id);
        if (placed >= 0) { insertAt = placed; break; }
      }
    }
    sequence.splice(insertAt < 0 ? sequence.length : insertAt, 0, loserItem.id);
  }

  sequence.forEach((id, index) => {
    const item = mergedItems.get(id)!;
    item.stageId = winnerById.get(id)?.stageId ?? item.stageId;
    item.order = index;
  });
  // Renumber within every stage so precondition reachability recomputes cleanly.
  const stageIds = new Set(mergedStages.map((stage) => stage.id));
  stageIds.forEach((stageId) => {
    sequence.filter((id) => mergedItems.get(id)?.stageId === stageId).forEach((id, order) => {
      mergedItems.get(id)!.order = order;
    });
  });

  if (localChanged || remoteChanged) {
    notes.push({
      id: 'note-order',
      kind: 'metadata',
      message: `检查项顺序有调整，已采用${winner === 'local' ? '本机' : `对端「${plan.remoteEditor}」`}排序（阶段顺序按${stageOrderWinner === 'local' ? '本机' : '对端'}为准）并重排序号，前置条件可达性已重新计算。`
    });
  }
}

const itemSequenceSignature = (snapshot: ProjectSnapshot) => itemSequence(snapshot).map((item) => `${item.stageId}:${item.id}`).join('|');

function mergeMetadata(base: ProjectSnapshot, local: ProjectSnapshot, remote: ProjectSnapshot, notes: MergeNote[]) {
  const pick = (field: 'name' | 'aircraft') => {
    if (local[field] === remote[field]) return local[field];
    if (local[field] === base[field]) return remote[field];
    if (remote[field] === base[field]) return local[field];
    return remoteIsNewer(remote.updatedAt, local.updatedAt) ? remote[field] : local[field];
  };
  const name = pick('name');
  const aircraft = pick('aircraft');
  if (name !== base.name || aircraft !== base.aircraft) {
    notes.push({ id: 'note-metadata', kind: 'metadata', message: '检查单名称 / 机型信息已按双方修改合并。' });
  }
  return { name, aircraft };
}
