import { useState, type FormEvent } from 'react';
import { ExternalLink, Sparkles, WandSparkles } from 'lucide-react';
import { useCreateAiTask } from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import type {
  AiTaskGroundingMode,
  CreateAiTaskInput,
  GeneratedAiTask,
} from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import adminStyles from '../../admin/admin.module.css';
import { TextAreaField } from './TextAreaField';
import styles from './tasks.module.css';

const GROUNDING_OPTIONS = [
  { value: 'GROUNDED_ONLY', label: 'Use CanPlan guidance only' },
  {
    value: 'ALLOW_UNGROUNDED_FALLBACK',
    label: 'Allow general AI if guidance is unavailable',
  },
];

interface AiTaskGeneratorProps {
  disabled?: boolean;
  hasExistingDraft?: boolean;
  onApply: (preview: GeneratedAiTask) => void;
}

/**
 * Calls createAiTask as a throwaway preview. The mutation persists nothing; applying a result
 * only copies its title and steps into the ordinary createTask form for review and editing.
 */
export function AiTaskGenerator({ disabled, hasExistingDraft, onApply }: AiTaskGeneratorProps) {
  const generationMutation = useCreateAiTask();
  const [query, setQuery] = useState('');
  const [groundingMode, setGroundingMode] = useState<AiTaskGroundingMode>('GROUNDED_ONLY');
  const [stepCount, setStepCount] = useState('');
  const [queryError, setQueryError] = useState<string>();
  const [stepCountError, setStepCountError] = useState<string>();
  const [preview, setPreview] = useState<GeneratedAiTask | null>(null);
  const [draftApplied, setDraftApplied] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const controlsDisabled = Boolean(disabled || generationMutation.isPending);

  function clearMutationError() {
    if (generationMutation.isError) generationMutation.reset();
  }

  function discardStalePreview() {
    setPreview(null);
    setDraftApplied(false);
    setConfirmReplace(false);
    clearMutationError();
  }

  function handleGenerate(event: FormEvent) {
    event.preventDefault();
    if (controlsDisabled) return;

    const trimmedQuery = query.trim();
    const nextQueryError = trimmedQuery ? undefined : 'Describe the task you want to create.';
    const trimmedStepCount = stepCount.trim();
    let requestedStepCount: number | undefined;
    let nextStepCountError: string | undefined;

    if (trimmedStepCount) {
      requestedStepCount = Number(trimmedStepCount);
      if (
        !Number.isInteger(requestedStepCount) ||
        requestedStepCount < 1 ||
        requestedStepCount > 20
      ) {
        nextStepCountError = 'Enter a whole number from 1 to 20, or leave this blank.';
      }
    }

    setQueryError(nextQueryError);
    setStepCountError(nextStepCountError);
    if (nextQueryError || nextStepCountError) {
      window.requestAnimationFrame(() => {
        document.getElementById(nextQueryError ? 'ai-task-query' : 'ai-task-step-count')?.focus();
      });
      return;
    }

    const input: CreateAiTaskInput = {
      query: trimmedQuery,
      groundingMode,
    };
    if (requestedStepCount !== undefined) input.stepCount = requestedStepCount;

    setPreview(null);
    setDraftApplied(false);
    setConfirmReplace(false);
    generationMutation.reset();
    generationMutation.mutate(input, {
      onSuccess: (generated) => {
        setPreview(generated);
        window.requestAnimationFrame(() => {
          document.getElementById('ai-task-preview-title')?.focus();
        });
      },
    });
  }

  function applyPreview() {
    if (!preview) return;
    onApply(preview);
    setDraftApplied(true);
    setConfirmReplace(false);
    window.requestAnimationFrame(() => {
      document.getElementById('task-title')?.focus();
    });
  }

  function requestApplyPreview() {
    if (hasExistingDraft) {
      setDraftApplied(false);
      setConfirmReplace(true);
      window.requestAnimationFrame(() => {
        document.getElementById('confirm-ai-draft-replacement')?.focus();
      });
      return;
    }
    applyPreview();
  }

  function cancelPreviewReplacement() {
    setConfirmReplace(false);
    window.requestAnimationFrame(() => {
      document.getElementById('use-ai-draft')?.focus();
    });
  }

  const ungrounded = preview?.source === 'UNGROUNDED_AI' || preview?.grounded === false;

  return (
    <Panel
      title="Generate a draft with AI"
      description="Describe a task and review a generated title and steps. Generation is a preview and does not save anything."
      icon={<WandSparkles size={16} />}
    >
      <form className={adminStyles.panelForm} onSubmit={handleGenerate} noValidate>
        <TextAreaField
          id="ai-task-query"
          label="What task should the AI create?"
          required
          rows={3}
          value={query}
          error={queryError}
          disabled={controlsDisabled}
          hint="Include any important context, constraints, or desired outcome."
          placeholder="e.g. Create a safe, easy-to-follow routine for washing my hair"
          onChange={(event) => {
            setQuery(event.target.value);
            if (queryError) setQueryError(undefined);
            discardStalePreview();
          }}
        />

        <div className={styles.aiParameterGrid}>
          <Select
            label="Guidance source"
            value={groundingMode}
            disabled={controlsDisabled}
            options={GROUNDING_OPTIONS}
            hint="Guidance only stops with an error when no relevant source is found. The fallback may use general AI knowledge instead."
            onChange={(event) => {
              setGroundingMode(event.target.value as AiTaskGroundingMode);
              discardStalePreview();
            }}
          />
          <TextField
            id="ai-task-step-count"
            label="Number of steps (optional)"
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            step={1}
            value={stepCount}
            error={stepCountError}
            disabled={controlsDisabled}
            hint="Choose an exact count from 1 to 20, or leave blank for the AI to choose."
            placeholder="AI chooses"
            onChange={(event) => {
              setStepCount(event.target.value);
              if (stepCountError) setStepCountError(undefined);
              discardStalePreview();
            }}
          />
        </div>

        {generationMutation.isError && (
          <Alert variant="error" title="Could not generate a task draft">
            {gqlErrorMessage(generationMutation.error)}
          </Alert>
        )}

        <div className={adminStyles.formActions}>
          <Button
            type="submit"
            icon={<Sparkles size={15} />}
            loading={generationMutation.isPending}
            disabled={disabled}
          >
            Generate draft
          </Button>
          <span className={styles.aiGenerationHelp}>
            Generation can take up to about 30 seconds.
          </span>
        </div>
      </form>

      {preview && (
        <div className={styles.aiPreview}>
          <div className={styles.aiPreviewHead}>
            <div>
              <span className={styles.aiPreviewEyebrow}>Generated preview</span>
              <h3 id="ai-task-preview-title" className={styles.aiPreviewTitle} tabIndex={-1}>
                {preview.title}
              </h3>
            </div>
            <Badge tone={ungrounded ? 'warning' : 'success'}>
              {ungrounded ? 'General AI' : 'CanPlan guidance'}
            </Badge>
          </div>

          {ungrounded ? (
            <Alert variant="warning" title="AI-generated, not from CanPlan guidance">
              No relevant guidance was available, so this draft uses general AI knowledge. Review
              every step carefully before using it.
            </Alert>
          ) : (
            <Alert variant="success" title="Based on CanPlan guidance">
              Review the generated wording and its cited sources before using this draft.
            </Alert>
          )}

          <ol className={styles.aiPreviewSteps}>
            {preview.steps.map((step, index) => (
              <li key={`${index}-${step.text}`} className={styles.aiPreviewStep}>
                <p className={styles.aiPreviewStepText}>{step.text}</p>
                {step.citations.length > 0 && (
                  <details className={styles.aiCitationDetails}>
                    <summary>
                      {step.citations.length} {step.citations.length === 1 ? 'source' : 'sources'}
                    </summary>
                    <ul className={styles.aiCitationList}>
                      {step.citations.map((citation, citationIndex) => {
                        const citationUrl = safeCitationUrl(citation.url);
                        return (
                          <li key={`${citation.chunkId}-${citationIndex}`}>
                            <div className={styles.aiCitationTitle}>
                              {citationUrl ? (
                                <a href={citationUrl} target="_blank" rel="noreferrer">
                                  {citation.title} <ExternalLink size={12} aria-hidden="true" />
                                </a>
                              ) : (
                                citation.title
                              )}
                            </div>
                            {citation.snippet && (
                              <p className={styles.aiCitationSnippet}>{citation.snippet}</p>
                            )}
                            <span className={styles.aiCitationId}>
                              Source ID: {citation.chunkId}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ol>

          {(preview.inputTokens != null || preview.outputTokens != null) && (
            <p className={styles.aiTokenUsage}>
              Model usage:{' '}
              {preview.inputTokens != null
                ? `${preview.inputTokens} input tokens`
                : 'input unknown'}
              {' · '}
              {preview.outputTokens != null
                ? `${preview.outputTokens} output tokens`
                : 'output unknown'}
            </p>
          )}

          <p className={styles.aiPreviewFootnote}>
            Applying replaces the current title and steps in the editable form below. Category and
            description are kept. Citations are provided for review and are not saved with the task
            template.
          </p>
          {confirmReplace ? (
            <Alert variant="warning" title="Replace your current title and steps?">
              Description and category will stay unchanged, but the current title and step draft
              will be replaced.
              <div className={styles.alertActions}>
                <Button
                  id="confirm-ai-draft-replacement"
                  size="sm"
                  variant="secondary"
                  icon={<Sparkles size={14} />}
                  onClick={applyPreview}
                  disabled={disabled}
                >
                  Replace title and steps
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={cancelPreviewReplacement}
                  disabled={disabled}
                >
                  Keep current draft
                </Button>
              </div>
            </Alert>
          ) : (
            <div className={adminStyles.formActions}>
              <Button
                id="use-ai-draft"
                icon={<Sparkles size={15} />}
                onClick={requestApplyPreview}
                disabled={disabled}
              >
                Use this draft
              </Button>
            </div>
          )}
          {draftApplied && (
            <div className={styles.aiAppliedNotice}>
              <Alert variant="success" title="Draft copied to the task form">
                You can edit the title and steps below before creating the task.
              </Alert>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Citation metadata is corpus-controlled; only normal web URLs become clickable. */
function safeCitationUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
