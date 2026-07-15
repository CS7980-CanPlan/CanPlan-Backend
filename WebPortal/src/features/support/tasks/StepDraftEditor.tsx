import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/ui/TextField';
import { TextAreaField } from './TextAreaField';
import styles from './tasks.module.css';

/**
 * createTask nests the whole task (meta + steps + counters) in one DynamoDB transaction, so
 * a coverless task fits at most 97 nested steps (the backend enforces this).
 */
export const MAX_NESTED_STEPS = 97;

export interface StepDraft {
  /** Stable local key (never sent to the backend). */
  key: string;
  text: string;
  description: string;
}

let draftCounter = 0;
export function newStepDraft(): StepDraft {
  draftCounter += 1;
  return { key: `draft-${draftCounter}`, text: '', description: '' };
}

interface StepDraftEditorProps {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  /** Per-key validation error for the step text (shown under the text field). */
  errors?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Ordered text-step editor used before a task exists (the create form). Steps live only in
 * local state; add/remove/reorder are plain array operations and everything is submitted
 * once via createTask's nested steps. All controls are regular buttons (keyboard operable)
 * with explicit aria-labels.
 */
export function StepDraftEditor({ steps, onChange, errors, disabled }: StepDraftEditorProps) {
  function updateStep(key: string, patch: Partial<StepDraft>) {
    onChange(steps.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  }

  function removeStep(key: string) {
    onChange(steps.filter((step) => step.key !== key));
  }

  function moveStep(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div>
      {steps.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', margin: '0 0 0.75rem' }}>
          No steps yet. Steps are optional — you can also add them after creating the task.
        </p>
      ) : (
        <ol className={styles.stepList} style={{ marginBottom: '0.75rem' }}>
          {steps.map((step, index) => (
            <li key={step.key} className={styles.stepRow}>
              <span className={styles.stepOrder} aria-hidden="true">
                {index + 1}
              </span>
              <div className={styles.stepEditForm}>
                <TextField
                  label={`Step ${index + 1} text`}
                  required
                  value={step.text}
                  error={errors?.[step.key]}
                  disabled={disabled}
                  onChange={(e) => updateStep(step.key, { text: e.target.value })}
                  placeholder="e.g. Fill the kettle with water"
                />
                <TextAreaField
                  label={`Step ${index + 1} description (optional)`}
                  rows={2}
                  value={step.description}
                  disabled={disabled}
                  onChange={(e) => updateStep(step.key, { description: e.target.value })}
                />
              </div>
              <div className={styles.stepActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move step ${index + 1} up`}
                  title="Move up"
                  disabled={disabled || index === 0}
                  onClick={() => moveStep(index, -1)}
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Move step ${index + 1} down`}
                  title="Move down"
                  disabled={disabled || index === steps.length - 1}
                  onClick={() => moveStep(index, 1)}
                >
                  <ArrowDown size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove step ${index + 1}`}
                  title="Remove step"
                  disabled={disabled}
                  onClick={() => removeStep(step.key)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <Button
        size="sm"
        variant="secondary"
        icon={<Plus size={14} />}
        disabled={disabled || steps.length >= MAX_NESTED_STEPS}
        onClick={() => onChange([...steps, newStepDraft()])}
      >
        Add step
      </Button>
      {steps.length >= MAX_NESTED_STEPS && (
        <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', marginTop: '0.4rem' }}>
          A new task can include at most {MAX_NESTED_STEPS} steps — more can be appended after
          it is created (up to 99 total).
        </p>
      )}
    </div>
  );
}
