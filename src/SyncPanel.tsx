import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Callout, Card, Dialog, Flex, Heading, Separator, Text, TextField } from '@radix-ui/themes';
import { parseBranchPack, planMerge, projectToSnapshot, resolveMerge } from './merge';
import type {
  ChecklistProject,
  MergeConflict,
  MergeResolution,
  OfflineBranchPack,
  ProjectSnapshot
} from './types';
import { validateProject } from './validation';

const sideName = (side: 'local' | 'remote', remoteEditor: string) => (side === 'local' ? '本机' : `对端「${remoteEditor}」`);

interface RemoteSource {
  editor: string;
  snapshot: ProjectSnapshot;
}

export function downloadBranchPack(pack: OfflineBranchPack) {
  const json = JSON.stringify(pack, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  const stamp = new Date(pack.exportedAt).toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `${pack.snapshot.name.replace(/[^\p{L}\p{N}-]+/gu, '-')}-offline-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function useBranchFile(onLoaded: (pack: OfflineBranchPack) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const openPicker = () => {
    setError('');
    inputRef.current?.click();
  };
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="application/json,.json"
      style={{ display: 'none' }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        file.text().then((text) => {
          try {
            onLoaded(parseBranchPack(text));
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : '无法读取离线副本文件。');
          }
        });
      }}
    />
  );
  return { input, error, setError, openPicker };
}

interface SyncPanelProps {
  project: ChecklistProject;
  projects: ChecklistProject[];
  onEditorChange: (editor: string) => void;
  onExportPack: () => OfflineBranchPack;
  onImportPack: (pack: OfflineBranchPack) => string;
  onStartMerge: (remote: RemoteSource) => void;
}

export function SyncPanel({ project, projects, onEditorChange, onExportPack, onImportPack, onStartMerge }: SyncPanelProps) {
  const [editor, setEditor] = useState(project.sync?.editor ?? '值班编辑 A');
  const file = useBranchFile((pack) => {
    onImportPack(pack);
    setImportedNotice(`已导入「${pack.editor}」的离线副本，可在下方本地副本中选择合并。`);
  });
  const [importedNotice, setImportedNotice] = useState('');

  const branchPacks = projects.filter(
    (candidate) => candidate.id !== project.id && candidate.sync?.syncId && candidate.sync.syncId === (project.sync?.syncId ?? '')
  );
  const canExport = project.status === 'draft';

  return (
    <div className="content-page sync-page">
      <Heading size="7">离线合并</Heading>
      <Text color="gray" as="p">
        两名值班编辑各自离线维护同一架飞机的检查单。导出的离线副本带有共同基准快照，重连后可按检查项最后编辑时间合并，并在删除与新增前置条件冲突时人工选择。
      </Text>

      <Card className="sync-card">
        <Flex justify="between" align="center" wrap="wrap">
          <div>
            <Heading size="4">① 建立离线副本</Heading>
            <Text size="2" color="gray" as="p">在本机登记编辑员姓名，再导出 JSON 交给另一名编辑；对方在自己的浏览器中导入后离线修改。</Text>
          </div>
          <Badge color="blue" variant="soft">同步线路 {project.sync?.syncId ?? '尚未建立'}</Badge>
        </Flex>
        <Flex gap="3" align="end" mt="4" wrap="wrap">
          <label className="sync-field"><span>本机编辑员</span>
            <TextField.Root value={editor} onChange={(event) => setEditor(event.target.value)} onBlur={() => onEditorChange(editor)} placeholder="例如：值班编辑 A" />
          </label>
          <Button
            disabled={!canExport}
            onClick={() => { onEditorChange(editor); downloadBranchPack(onExportPack()); }}
          >
            导出我的离线副本
          </Button>
          <Button variant="soft" disabled={!canExport} onClick={file.openPicker}>导入对方离线副本</Button>
          {!canExport && <Text size="1" color="amber">复核中 / 已冻结版本只读，需先创建新修订才能导出离线副本。</Text>}
        </Flex>
        {file.input}
        {file.error && <Callout.Root color="red" mt="3"><Callout.Text>{file.error}</Callout.Text></Callout.Root>}
        {importedNotice && <Callout.Root color="green" mt="3"><Callout.Text>{importedNotice}</Callout.Text></Callout.Root>}
      </Card>

      <Card className="sync-card">
        <Heading size="4">② 选择离线副本合并</Heading>
        <Text size="2" color="gray" as="p">共同基准来自离线副本，双方相对基准做三方合并；冻结版本始终保持只读，不参与改写。</Text>
        <div className="sync-candidates">
          {branchPacks.length ? branchPacks.map((candidate) => {
            const candidateIssues = validateProject(candidate).filter((issue) => issue.level === 'error').length;
            return (
              <div key={candidate.id} className="sync-candidate">
                <div>
                  <strong>{candidate.name}</strong>
                  <small>编辑员：{candidate.sync?.editor ?? '未署名'} · {candidate.items.length} 项 · 最后修改 {new Date(candidate.updatedAt).toLocaleString('zh-CN')}{candidateIssues ? ` · ${candidateIssues} 个阻断` : ''}</small>
                </div>
                <Button disabled={project.status !== 'draft'} onClick={() => onStartMerge({ editor: candidate.sync?.editor ?? '对方编辑', snapshot: projectToSnapshot(candidate) })}>开始合并</Button>
              </div>
            );
          }) : (
            <Text size="2" color="gray" as="p">当前浏览器中没有同一架飞机的其他离线副本。先导入对方发来的 JSON，或使用内置的「值班编辑 B 离线副本」试用合并。</Text>
          )}
        </div>
      </Card>

      <Card className="sync-card">
        <Heading size="4">合并规则</Heading>
        <ul className="sync-rules">
          <li>检查项的挑战语、预期回应、异常处置按最后编辑时间保留；仅一方改动时直接并入。</li>
          <li>一方删除检查项、另一方仍编辑或新增了指向它的前置条件时，列出冲突由人选择保留或确认删除。</li>
          <li>前置条件引用集合按三方合并：双方都移除才移除，任何一方新增都会保留。</li>
          <li>顺序变更后统一重排序号并重算可达性；合并结果仍有阻断问题时不能进入复核。</li>
          <li>合并完成后合并结果即当前检查单，可继续复核、冻结与导出；导出内容与合并结果完全相同。</li>
        </ul>
      </Card>
    </div>
  );
}

interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  local: ChecklistProject;
  remote: RemoteSource | null;
  onApply: (snapshot: ProjectSnapshot) => void;
  onExportMerged: (snapshot: ProjectSnapshot) => void;
}

export function MergeDialog({ open, onOpenChange, local, remote, onApply, onExportMerged }: MergeDialogProps) {
  const [resolutions, setResolutions] = useState<Record<string, MergeResolution>>({});
  const [applied, setApplied] = useState<{ snapshot: ProjectSnapshot; errorCount: number } | null>(null);

  const base = local.sync?.baseSnapshot ?? projectToSnapshot(local);
  const plan = useMemo(() => (remote && open ? planMerge(base, projectToSnapshot(local), remote.snapshot, remote.editor) : null), [base, local, remote, open]);
  const result = useMemo(() => (plan ? resolveMerge(plan, resolutions) : null), [plan, resolutions]);
  const issues = useMemo(() => (result ? validateProject(result.snapshot) : []), [result]);
  const errorCount = issues.filter((issue) => issue.level === 'error').length;
  const allResolved = plan ? plan.conflicts.every((conflict) => resolutions[conflict.id]) : true;

  useEffect(() => {
    if (open) { setResolutions({}); setApplied(null); }
  }, [open, remote]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="780px" className="merge-dialog">
        <Dialog.Title>合并离线副本</Dialog.Title>
        {remote && (
          <Dialog.Description size="2" color="gray">
            本机「{local.sync?.editor ?? '本机编辑'}」↔ 对端「{remote.editor}」 · 共同基准 {new Date(base.updatedAt).toLocaleDateString('zh-CN')}
          </Dialog.Description>
        )}

        {applied && (
          <Callout.Root color="green" mt="4">
            <Callout.Text>
              合并已应用为当前检查单（r{local.revision}，状态回到编辑中）。{applied.errorCount > 0 ? `仍有 ${applied.errorCount} 个阻断问题，处理前不能进入复核。` : '没有阻断问题，可直接提交复核。'}
              <Flex gap="2" mt="2">
                <Button size="1" variant="soft" onClick={() => onExportMerged(applied.snapshot)}>导出合并后离线副本</Button>
                <Dialog.Close><Button size="1">完成</Button></Dialog.Close>
              </Flex>
            </Callout.Text>
          </Callout.Root>
        )}

        {plan && result && !applied && (
          <div className="merge-body">
            <section>
              <Flex justify="between" align="center" mb="2">
                <Heading size="4">冲突选择（{plan.conflicts.length}）</Heading>
                <Text size="1" color="gray">删除与新前置条件 / 编辑冲突时必须人工选择</Text>
              </Flex>
              {plan.conflicts.length === 0 && <Callout.Root color="green"><Callout.Text>没有删除冲突，双方改动可自动合并。</Callout.Text></Callout.Root>}
              <div className="conflict-list">
                {plan.conflicts.map((conflict) => (
                  <ConflictCard
                    key={conflict.id}
                    conflict={conflict}
                    remoteEditor={plan.remoteEditor}
                    value={resolutions[conflict.id]}
                    onChange={(resolution) => setResolutions((current) => ({ ...current, [conflict.id]: resolution }))}
                  />
                ))}
              </div>
            </section>

            <section>
              <Flex justify="between" align="center" mb="2"><Heading size="4">自动合并明细（{result.notes.length}）</Heading><Text size="1" color="gray">字段按最后编辑时间，前置条件按三方集合合并</Text></Flex>
              <div className="merge-note-list">
                {result.notes.length ? result.notes.map((note) => (
                  <div key={note.id} className="merge-note"><Badge size="1" variant="soft" color={note.kind === 'field-lww' ? 'amber' : note.kind === 'item-removed' || note.kind === 'stage-removed' ? 'red' : note.kind === 'item-added' || note.kind === 'stage-added' ? 'green' : 'blue'}>{noteLabel(note.kind)}</Badge><span>{note.message}</span></div>
                )) : <Text size="2" color="gray">无自动改动。</Text>}
              </div>
            </section>

            <Separator size="4" my="2" />

            <section>
              <Flex justify="between" align="center" mb="2">
                <Heading size="4">合并结果校验</Heading>
                <Badge color={errorCount ? 'red' : 'green'}>{errorCount ? `${errorCount} 个阻断，不能进入复核` : '无阻断问题'}</Badge>
              </Flex>
              <MergedPreview snapshot={result.snapshot} issues={issues} />
            </section>
          </div>
        )}

        {!applied && (
          <Flex gap="3" justify="end" mt="4">
            <Dialog.Close><Button variant="soft">取消</Button></Dialog.Close>
            <Button
              color="amber"
              variant="soft"
              disabled={!result}
              onClick={() => result && onExportMerged(result.snapshot)}
            >
              仅导出合并结果
            </Button>
            <Button
              color="green"
              disabled={!result || !allResolved}
              onClick={() => { if (result) { onApply(result.snapshot); setApplied({ snapshot: result.snapshot, errorCount }); } }}
            >
              {plan && plan.conflicts.length && !allResolved ? '请先解决全部冲突' : '应用合并结果'}
            </Button>
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function noteLabel(kind: string) {
  return {
    'item-added': '新增',
    'item-removed': '删除',
    'field-lww': '最后编辑',
    'precondition-set': '前置条件',
    'stage-added': '新阶段',
    'stage-removed': '删阶段',
    metadata: '顺序/资料'
  }[kind] ?? '合并';
}

function ConflictCard({ conflict, remoteEditor, value, onChange }: {
  conflict: MergeConflict;
  remoteEditor: string;
  value: MergeResolution | undefined;
  onChange: (resolution: MergeResolution) => void;
}) {
  return (
    <Card className={`conflict-card ${value ? 'resolved' : 'pending'}`}>
      <Flex justify="between" align="center" mb="2">
        <strong>检查项“{conflict.challenge}”</strong>
        <Badge color="red">{conflict.kind === 'deleted-vs-precondition' ? '删除 × 新前置条件' : '删除 × 编辑'}</Badge>
      </Flex>
      <Text size="2" as="p">{conflict.detail}</Text>
      <div className="conflict-options" role="radiogroup" aria-label={`${conflict.challenge} 冲突解决方式`}>
        <label className={value === 'keep' ? 'chosen' : ''}>
          <input type="radio" name={conflict.id} checked={value === 'keep'} onChange={() => onChange('keep')} />
          <span><strong>保留检查项</strong><small>采用{sideName(conflict.changedSide, remoteEditor)}版本，删除方的移除作废，相关前置条件继续有效。</small></span>
        </label>
        <label className={value === 'delete' ? 'chosen' : ''}>
          <input type="radio" name={conflict.id} checked={value === 'delete'} onChange={() => onChange('delete')} />
          <span><strong>确认删除</strong><small>检查项不进入合并结果，并移除{conflict.referrerIds.length ? '新增的' : ''}指向它的前置条件引用。</small></span>
        </label>
      </div>
    </Card>
  );
}

function MergedPreview({ snapshot, issues }: { snapshot: ProjectSnapshot; issues: ReturnType<typeof validateProject> }) {
  const stageOrder = snapshot.stages.slice().sort((a, b) => a.order - b.order);
  return (
    <div className="merge-preview">
      {issues.length > 0 && (
        <Callout.Root color={issues.some((issue) => issue.level === 'error') ? 'red' : 'amber'} mb="3">
          <Callout.Text>
            {issues.slice(0, 5).map((issue) => <span key={issue.id} className="merge-issue-line">· {issue.title}：{issue.detail}</span>)}
            {issues.length > 5 && <span>…等 {issues.length} 个问题</span>}
          </Callout.Text>
        </Callout.Root>
      )}
      <div className="merge-preview-sheet">
        {stageOrder.map((stage) => (
          <div key={stage.id} className="merge-preview-stage">
            <strong>{stage.name}</strong>
            <ol>
              {snapshot.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).map((item) => {
                const itemIssue = issues.find((issue) => issue.itemId === item.id && issue.level === 'error');
                return (
                  <li key={item.id} className={itemIssue ? 'has-error' : ''}>
                    {item.critical && <em className="critical-dot">◆</em>} {item.challenge || '未命名检查项'} → {item.response || '未填写'}
                    {item.preconditionIds.length > 0 && <small> [{item.preconditionIds.length} 前置]</small>}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
