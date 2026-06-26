import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useAdminDeleteTask } from '../../../api/adminHooks';
import type { Task } from '../../../api/apiTypes';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../components/Panel';
import { MutationResultPanel } from '../components/MutationResultPanel';
import { ConfirmDangerAction, confirmationMatches } from '../components/ConfirmDangerAction';
import styles from '../admin.module.css';

/** Destructive: delete any task by id (regardless of owner) with typed confirmation. */
export function DeleteTaskPanel() {
  const mutation = useAdminDeleteTask();
  const [taskId, setTaskId] = useState('');
  const [confirm, setConfirm] = useState('');

  const target = taskId.trim();
  const canSubmit = confirmationMatches(target, confirm);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(target, { onSuccess: () => setConfirm('') });
  }

  return (
    <Panel
      title="Delete task"
      description="Permanently removes a task and all of its steps and media. This cannot be undone."
      icon={<Trash2 size={16} />}
    >
      <form className={styles.panelForm} onSubmit={handleSubmit}>
        <TextField
          label="Task id"
          required
          value={taskId}
          onChange={(e) => {
            setTaskId(e.target.value);
            setConfirm('');
          }}
          placeholder="e.g. 3f0a…"
        />
        <ConfirmDangerAction expected={target} value={confirm} onChange={setConfirm} targetLabel="task id" />
        <div className={styles.formActions}>
          <Button type="submit" variant="danger" icon={<Trash2 size={16} />} loading={mutation.isPending} disabled={!canSubmit}>
            Permanently delete task
          </Button>
        </div>
      </form>

      <MutationResultPanel<Task | null>
        isPending={mutation.isPending}
        isError={mutation.isError}
        error={mutation.error}
        isSuccess={mutation.isSuccess}
        data={mutation.data}
        successTitle="Task deleted"
        emptyMessage="That task was already gone — nothing to delete (the operation is idempotent)."
      />
    </Panel>
  );
}
