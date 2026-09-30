export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType = 'duplicate' | 'missing-response' | 'unreachable-precondition' | 'stage-order' | 'orphan-stage';

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
}

export interface ChecklistItem {
  id: string;
  stageId: string;
  order: number;
  challenge: string;
  response: string;
  critical: boolean;
  preconditionIds: string[];
  abnormalProcedure: string;
  updatedAt: string;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
  sync?: ProjectSyncInfo;
}

export interface ProjectSyncInfo {
  /** Shared by every offline branch of the same aircraft checklist. */
  syncId: string;
  /** Label of the editor who last saved this copy. */
  editor: string;
  /** Snapshot this copy branched from; the merge base for offline merges. */
  baseSnapshot: ProjectSnapshot;
}

/** Revision-independent project shape exchanged by offline editors. */
export interface ProjectSnapshot {
  name: string;
  aircraft: string;
  updatedAt: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

/** File handed to another editor when working offline. */
export interface OfflineBranchPack {
  kind: 'flightline-branch';
  packVersion: 1;
  syncId: string;
  editor: string;
  exportedAt: string;
  baseSnapshot: ProjectSnapshot;
  snapshot: ProjectSnapshot;
}

export interface WorkspaceState {
  schemaVersion: 1;
  selectedProjectId: string;
  projects: ChecklistProject[];
}

export interface ValidationIssue {
  id: string;
  type: IssueType;
  level: IssueLevel;
  stageId?: string;
  itemId?: string;
  title: string;
  detail: string;
}

export interface VersionOption {
  id: string;
  label: string;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'changed' | 'stage';
  key: string;
  stage: string;
  before: string;
  after: string;
}

export type MergeConflictKind = 'deleted-vs-edited' | 'deleted-vs-precondition';
export type MergeResolution = 'keep' | 'delete';

export interface MergeConflict {
  id: string;
  kind: MergeConflictKind;
  itemId: string;
  /** Side that removed the check item. */
  deletedSide: 'local' | 'remote';
  /** Side that still edits it / added the precondition. */
  changedSide: 'local' | 'remote';
  challenge: string;
  detail: string;
  /** Items whose new precondition still references the deleted one (deleted-vs-precondition). */
  referrerIds: string[];
}

export interface MergeNote {
  id: string;
  kind: 'item-added' | 'item-removed' | 'field-lww' | 'precondition-set' | 'stage-added' | 'stage-removed' | 'metadata';
  message: string;
}

export interface MergePlan {
  base: ProjectSnapshot;
  local: ProjectSnapshot;
  remote: ProjectSnapshot;
  remoteEditor: string;
  conflicts: MergeConflict[];
  notes: MergeNote[];
}

export interface MergeResult {
  snapshot: ProjectSnapshot;
  conflicts: MergeConflict[];
  notes: MergeNote[];
}
