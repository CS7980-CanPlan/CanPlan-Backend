import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ClipboardPlus, ListOrdered } from 'lucide-react';
import { useAuth } from '../../../auth/useAuth';
import { useCreateTask, useUserCategories } from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import type { CreateTaskInput } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import { TextAreaField } from './TextAreaField';
import { StepDraftEditor, newStepDraft, type StepDraft } from './StepDraftEditor';
import adminStyles from '../../admin/admin.module.css';

/** Sentinel for "file under my default category" — mapped to an OMITTED categoryId. */
const DEFAULT_CATEGORY_VALUE = '';

/**
 * `/support/tasks/new` — create a task template OWNED BY THE CALLER. The createTask input
 * deliberately never includes `userId`: sending a supported user's id here would create the
 * task under that user instead of the SupportPerson, which is not what this module does.
 */
export default function SupportTaskCreatePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const assignTo = searchParams.get('assignTo')?.trim() ?? '';
  const assignQuery = assignTo ? `?assignTo=${encodeURIComponent(assignTo)}` : '';

  const categoriesQuery = useUserCategories(user?.userId);
  const createMutation = useCreateTask(user?.userId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(DEFAULT_CATEGORY_VALUE);
  const [steps, setSteps] = useState<StepDraft[]>(() => [newStepDraft()]);
  const [titleError, setTitleError] = useState<string | undefined>();
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});

  /** "Default / No Category" (omit categoryId) plus the caller's real non-default categories. */
  const categoryOptions = useMemo(() => {
    const options = [{ value: DEFAULT_CATEGORY_VALUE, label: 'Default (No Category)' }];
    for (const category of categoriesQuery.data?.items ?? []) {
      if (!category.isDefault) {
        options.push({ value: category.categoryId, label: category.name });
      }
    }
    return options;
  }, [categoriesQuery.data]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (createMutation.isPending) return;

    const trimmedTitle = title.trim();
    const nextTitleError = trimmedTitle ? undefined : 'Title is required.';
    const nextStepErrors: Record<string, string> = {};
    for (const step of steps) {
      if (!step.text.trim()) nextStepErrors[step.key] = 'Step text cannot be empty.';
    }
    setTitleError(nextTitleError);
    setStepErrors(nextStepErrors);
    if (nextTitleError || Object.keys(nextStepErrors).length > 0) return;

    const input: CreateTaskInput = { title: trimmedTitle };
    const trimmedDescription = description.trim();
    if (trimmedDescription) input.description = trimmedDescription;
    // A blank categoryId must never be sent — the sentinel means "omit the field".
    if (categoryId !== DEFAULT_CATEGORY_VALUE) input.categoryId = categoryId;
    if (steps.length > 0) {
      input.steps = steps.map((step) => {
        const stepDescription = step.description.trim();
        return stepDescription
          ? { text: step.text.trim(), description: stepDescription }
          : { text: step.text.trim() };
      });
    }

    createMutation.mutate(input, {
      onSuccess: (task) =>
        navigate(
          `/support/tasks/${encodeURIComponent(task.taskId)}${assignQuery}${assignTo ? '#assignments' : ''}`,
        ),
    });
  }

  return (
    <div>
      <Link to={`/support/tasks${assignQuery}`} className={adminStyles.backLink}>
        <ArrowLeft size={15} /> Back to my task templates
      </Link>

      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>Create a task template</h1>
        <p className={adminStyles.pageSubtitle}>
          The template will be owned by you. You can assign it to people you support from its
          detail page afterwards.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <Panel
          title="Task details"
          description="A short title, an optional description, and one of your own categories."
          icon={<ClipboardPlus size={16} />}
        >
          <div className={adminStyles.panelForm}>
            <TextField
              label="Title"
              required
              value={title}
              error={titleError}
              disabled={createMutation.isPending}
              onChange={(e) => {
                setTitle(e.target.value);
                if (titleError) setTitleError(undefined);
              }}
              placeholder="e.g. Make a cup of tea"
            />
            <TextAreaField
              label="Description (optional)"
              value={description}
              disabled={createMutation.isPending}
              onChange={(e) => setDescription(e.target.value)}
            />
            <Select
              label="Category"
              options={categoryOptions}
              value={categoryId}
              disabled={createMutation.isPending || categoriesQuery.isLoading}
              hint={
                categoriesQuery.isLoading
                  ? 'Loading your categories…'
                  : 'Pick one of your own categories, or leave it in the default.'
              }
              onChange={(e) => setCategoryId(e.target.value)}
            />
            {categoriesQuery.isError && (
              <Alert variant="warning" title="Could not load your categories">
                {gqlErrorMessage(categoriesQuery.error)} You can still create the task — it will
                be filed under your default category.
              </Alert>
            )}
          </div>
        </Panel>

        <div style={{ height: '1.25rem' }} />

        <Panel
          title="Steps"
          description="Ordered text steps. Add, remove, and reorder before creating the task."
          icon={<ListOrdered size={16} />}
        >
          <StepDraftEditor
            steps={steps}
            onChange={(next) => {
              setSteps(next);
              setStepErrors({});
            }}
            errors={stepErrors}
            disabled={createMutation.isPending}
          />
        </Panel>

        <div style={{ height: '1.25rem' }} />

        {createMutation.isError && (
          <div style={{ marginBottom: '1rem' }}>
            <Alert variant="error" title="Could not create the task">
              {gqlErrorMessage(createMutation.error)}
            </Alert>
          </div>
        )}

        <div className={adminStyles.formActions}>
          <Button type="submit" loading={createMutation.isPending} icon={<ClipboardPlus size={15} />}>
            Create task
          </Button>
          <Button
            variant="ghost"
            disabled={createMutation.isPending}
            onClick={() => navigate(`/support/tasks${assignQuery}`)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
