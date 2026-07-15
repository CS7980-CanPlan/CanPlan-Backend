import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ListOrdered, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  useCreateTaskStep,
  useDeleteTaskStep,
  useReorderTaskSteps,
  useTaskSteps,
  useUpdateTaskStep,
} from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import type { TaskStep, UpdateTaskStepInput } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Spinner } from '../../../components/ui/Spinner';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import { TextAreaField } from './TextAreaField';
import adminStyles from '../../admin/admin.module.css';
import styles from './tasks.module.css';

/** The backend caps a task at 99 steps. */
const MAX_STEPS = 99;

/**
 * Steps editor for an owned task template: inline text/description editing, deletion with
 * confirmation, whole-set reordering (move up/down), and appending.
 *
 * Appending follows the backend contract for `createTaskStep.order`: with N > 0 steps we
 * first normalize with `reorderTaskSteps` (which resets the server's append position to
 * N+1) and then append with `order = N + 1`; with ZERO steps the backend always accepts
 * `order = 1` (an emptied task resets its internal counter on append).
 */
export function TaskStepsPanel({ taskId }: { taskId: string }) {
  const stepsQuery = useTaskSteps(taskId);
  const createMutation = useCreateTaskStep(taskId);
  const updateMutation = useUpdateTaskStep(taskId);
  const deleteMutation = useDeleteTaskStep(taskId);
  const reorderMutation = useReorderTaskSteps(taskId);

  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editError, setEditError] = useState<string | undefined>();
  const [confirmDeleteStepId, setConfirmDeleteStepId] = useState<string | null>(null);
  const [newText, setNewText] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newTextError, setNewTextError] = useState<string | undefined>();

  const steps = stepsQuery.data ?? [];
  const anyMutationPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    reorderMutation.isPending;

  function beginEdit(step: TaskStep) {
    updateMutation.reset();
    setEditingStepId(step.stepId);
    setEditText(step.text);
    setEditDescription(step.description ?? '');
    setEditError(undefined);
    setConfirmDeleteStepId(null);
  }

  function submitEdit(event: FormEvent, step: TaskStep) {
    event.preventDefault();
    const text = editText.trim();
    if (!text) {
      setEditError('Step text cannot be empty.');
      return;
    }
    const input: UpdateTaskStepInput = { taskId, stepId: step.stepId };
    if (text !== step.text) input.text = text;
    const description = editDescription.trim();
    const storedDescription = step.description ?? '';
    if (description !== storedDescription) {
      // Explicit null clears a stored description; whitespace-only must never be sent.
      input.description = description ? description : null;
    }
    if (input.text === undefined && input.description === undefined) {
      setEditingStepId(null);
      return;
    }
    updateMutation.mutate(input, { onSuccess: () => setEditingStepId(null) });
  }

  function moveStep(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    reorderMutation.reset();
    // The complete current set with the two neighbours swapped, renumbered 1..N.
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    reorderMutation.mutate({
      taskId,
      steps: next.map((step, position) => ({ stepId: step.stepId, order: position + 1 })),
    });
  }

  async function submitAppend(event: FormEvent) {
    event.preventDefault();
    const text = newText.trim();
    if (!text) {
      setNewTextError('Step text cannot be empty.');
      return;
    }
    setNewTextError(undefined);
    createMutation.reset();
    reorderMutation.reset();

    const description = newDescription.trim();
    try {
      if (steps.length > 0) {
        // Normalize first so the server's next append position is exactly steps.length + 1.
        await reorderMutation.mutateAsync({
          taskId,
          steps: steps.map((step, position) => ({ stepId: step.stepId, order: position + 1 })),
        });
        await createMutation.mutateAsync({
          taskId,
          order: steps.length + 1,
          text,
          ...(description ? { description } : {}),
        });
      } else {
        // An empty task always appends at order 1 (the backend resets its counter).
        await createMutation.mutateAsync({
          taskId,
          order: 1,
          text,
          ...(description ? { description } : {}),
        });
      }
      setNewText('');
      setNewDescription('');
    } catch {
      // The failing mutation's isError/error state renders the alert below.
    }
  }

  return (
    <Panel
      title="Steps"
      description="Ordered text steps of this template. Editing steps never changes snapshots of occurrences a user already started."
      icon={<ListOrdered size={16} />}
    >
      {stepsQuery.isLoading ? (
        <div style={{ padding: '1.5rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading steps…" />
        </div>
      ) : stepsQuery.isError ? (
        <Alert variant="error" title="Could not load the steps">
          {gqlErrorMessage(stepsQuery.error)}
        </Alert>
      ) : (
        <>
          {reorderMutation.isError && (
            <div style={{ marginBottom: '0.75rem' }}>
              <Alert variant="error" title="Could not reorder the steps">
                {gqlErrorMessage(reorderMutation.error)}
              </Alert>
            </div>
          )}
          {deleteMutation.isError && (
            <div style={{ marginBottom: '0.75rem' }}>
              <Alert variant="error" title="Could not delete the step">
                {gqlErrorMessage(deleteMutation.error)}
              </Alert>
            </div>
          )}
          {updateMutation.isError && (
            <div style={{ marginBottom: '0.75rem' }}>
              <Alert variant="error" title="Could not save the step">
                {gqlErrorMessage(updateMutation.error)}
              </Alert>
            </div>
          )}

          {steps.length === 0 ? (
            <EmptyState
              icon={<ListOrdered size={30} />}
              title="No steps yet"
              description="Add the first step below."
            />
          ) : (
            <ol className={styles.stepList}>
              {steps.map((step, index) => (
                <li key={step.stepId} className={styles.stepRow}>
                  <span className={styles.stepOrder} aria-hidden="true">
                    {index + 1}
                  </span>

                  {editingStepId === step.stepId ? (
                    <form
                      className={styles.stepEditForm}
                      onSubmit={(event) => submitEdit(event, step)}
                    >
                      <TextField
                        label={`Step ${index + 1} text`}
                        required
                        value={editText}
                        error={editError}
                        disabled={updateMutation.isPending}
                        onChange={(e) => {
                          setEditText(e.target.value);
                          if (editError) setEditError(undefined);
                        }}
                      />
                      <TextAreaField
                        label={`Step ${index + 1} description (optional)`}
                        rows={2}
                        value={editDescription}
                        disabled={updateMutation.isPending}
                        onChange={(e) => setEditDescription(e.target.value)}
                      />
                      <div className={adminStyles.formActions}>
                        <Button size="sm" type="submit" loading={updateMutation.isPending}>
                          Save step
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<X size={14} />}
                          disabled={updateMutation.isPending}
                          onClick={() => setEditingStepId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className={styles.stepBody}>
                      <span className={styles.stepText}>{step.text}</span>
                      {step.description && (
                        <span className={styles.stepDesc}>{step.description}</span>
                      )}
                      {confirmDeleteStepId === step.stepId && (
                        <div className={styles.inlineConfirm}>
                          <span className={styles.inlineConfirmLabel}>
                            Delete step {index + 1}? This cannot be undone.
                          </span>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={deleteMutation.isPending}
                            onClick={() =>
                              deleteMutation.mutate(
                                { taskId, stepId: step.stepId },
                                { onSuccess: () => setConfirmDeleteStepId(null) },
                              )
                            }
                          >
                            Delete
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={deleteMutation.isPending}
                            onClick={() => setConfirmDeleteStepId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {editingStepId !== step.stepId && (
                    <div className={styles.stepActions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move step ${index + 1} up`}
                        title="Move up"
                        disabled={anyMutationPending || index === 0}
                        onClick={() => moveStep(index, -1)}
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move step ${index + 1} down`}
                        title="Move down"
                        disabled={anyMutationPending || index === steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      >
                        <ArrowDown size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit step ${index + 1}`}
                        title="Edit step"
                        disabled={anyMutationPending}
                        onClick={() => beginEdit(step)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete step ${index + 1}`}
                        title="Delete step"
                        disabled={anyMutationPending}
                        onClick={() => {
                          deleteMutation.reset();
                          setConfirmDeleteStepId(step.stepId);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          <div style={{ height: '1rem' }} />

          {/* ── Append a step ─────────────────────────────────────────────── */}
          {steps.length >= MAX_STEPS ? (
            <Alert variant="info">A task may have at most {MAX_STEPS} steps.</Alert>
          ) : (
            <form className={adminStyles.panelForm} onSubmit={submitAppend}>
              <TextField
                label="New step text"
                required
                value={newText}
                error={newTextError}
                disabled={anyMutationPending}
                onChange={(e) => {
                  setNewText(e.target.value);
                  if (newTextError) setNewTextError(undefined);
                }}
                placeholder="e.g. Pour the water into the cup"
              />
              <TextAreaField
                label="New step description (optional)"
                rows={2}
                value={newDescription}
                disabled={anyMutationPending}
                onChange={(e) => setNewDescription(e.target.value)}
              />
              {createMutation.isError && (
                <Alert variant="error" title="Could not add the step">
                  {gqlErrorMessage(createMutation.error)}
                </Alert>
              )}
              <div className={adminStyles.formActions}>
                <Button
                  type="submit"
                  size="sm"
                  icon={<Plus size={14} />}
                  loading={createMutation.isPending || reorderMutation.isPending}
                  disabled={anyMutationPending}
                >
                  Add step
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </Panel>
  );
}
