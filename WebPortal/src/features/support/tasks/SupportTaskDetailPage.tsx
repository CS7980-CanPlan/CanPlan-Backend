import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { useAuth } from '../../../auth/useAuth';
import {
  useDeleteTask,
  useTask,
  useUpdateTask,
  useUserCategories,
} from '../../../api/supportHooks';
import { gqlErrorMessage } from '../../../api/graphqlError';
import type { Task, UpdateTaskInput } from '../../../api/apiTypes';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Select, type SelectOption } from '../../../components/ui/Select';
import { Spinner } from '../../../components/ui/Spinner';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import {
  ConfirmDangerAction,
  confirmationMatches,
} from '../../admin/components/ConfirmDangerAction';
import { IdCell, formatDate } from '../../admin/components/display';
import { TextAreaField } from './TextAreaField';
import { TaskStepsPanel } from './TaskStepsPanel';
import { TaskAssignmentPanel } from './TaskAssignmentPanel';
import adminStyles from '../../admin/admin.module.css';

/**
 * `/support/tasks/:taskId` — detail/editing for one OWNED task template: metadata editing,
 * the step editor, new-assignment form, and deletion. getTask also succeeds for tasks
 * the caller can merely read (delegated or assigned access), so the page explicitly verifies
 * `task.ownerId === caller` and refuses to manage anything it doesn't own.
 */
export default function SupportTaskDetailPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const assignTo = searchParams.get('assignTo')?.trim() ?? '';
  const assignQuery = assignTo ? `?assignTo=${encodeURIComponent(assignTo)}` : '';

  const taskQuery = useTask(taskId);
  const task = taskQuery.data;
  const isOwner = Boolean(task && user && task.ownerId === user.userId);

  // Land on the assignment panel when arriving via a "…#assignments" link.
  useEffect(() => {
    if (location.hash === '#assignments' && isOwner) {
      document.getElementById('assignments')?.scrollIntoView({ block: 'start' });
    }
  }, [location.hash, isOwner]);

  return (
    <div>
      <Link to={`/support/tasks${assignQuery}`} className={adminStyles.backLink}>
        <ArrowLeft size={15} /> Back to my task templates
      </Link>

      {taskQuery.isLoading ? (
        <div style={{ padding: '3rem', display: 'grid', placeItems: 'center' }}>
          <Spinner label="Loading the task…" />
        </div>
      ) : taskQuery.isError ? (
        <Alert variant="error" title="Could not load this task">
          {gqlErrorMessage(taskQuery.error)}
        </Alert>
      ) : !task ? (
        <Alert variant="warning" title="Task not found">
          This task does not exist (it may have been deleted).
        </Alert>
      ) : !isOwner ? (
        <Alert variant="error" title="Not your template">
          <ShieldAlert size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
          This task belongs to another user, so it cannot be managed here. Templates owned by
          people you support are visible read-only from their page under “People I support”.
        </Alert>
      ) : (
        <OwnedTaskDetail
          task={task}
          ownerId={user!.userId}
          initialTargetUserId={assignTo || undefined}
          onDeleted={() => navigate(`/support/tasks${assignQuery}`)}
        />
      )}
    </div>
  );
}

/** Everything below the guard: editing, steps, assignment creation, and the danger zone. */
function OwnedTaskDetail({
  task,
  ownerId,
  initialTargetUserId,
  onDeleted,
}: {
  task: Task;
  ownerId: string;
  initialTargetUserId?: string;
  onDeleted: () => void;
}) {
  return (
    <>
      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>{task.title}</h1>
        <p className={adminStyles.pageSubtitle}>
          Your reusable template. <IdCell id={task.taskId} /> · Updated{' '}
          {formatDate(task.updatedAt ?? task.createdAt)}
        </p>
      </div>

      {/* Keyed by taskId only: after a save the refetched task must NOT remount the form
          (that would wipe the success state); local edits already match what was saved. */}
      <TaskDetailsForm key={task.taskId} task={task} ownerId={ownerId} />
      <div style={{ height: '1.25rem' }} />
      <TaskStepsPanel taskId={task.taskId} />
      <div style={{ height: '1.25rem' }} />
      <div id="assignments">
        <TaskAssignmentPanel
          key={task.taskId}
          taskId={task.taskId}
          initialTargetUserId={initialTargetUserId}
        />
      </div>
      <div style={{ height: '1.25rem' }} />
      <DeleteTaskSection taskId={task.taskId} ownerId={ownerId} onDeleted={onDeleted} />
    </>
  );
}

/** Partial-update form for title / description / category (only changed fields are sent). */
function TaskDetailsForm({ task, ownerId }: { task: Task; ownerId: string }) {
  const categoriesQuery = useUserCategories(ownerId);
  const updateMutation = useUpdateTask(ownerId);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [categoryId, setCategoryId] = useState(task.categoryId ?? '');
  const [titleError, setTitleError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  /** Every option is a REAL owned category id (the default renders as "No Category"). */
  const categoryOptions = useMemo<SelectOption[]>(() => {
    const options = (categoriesQuery.data?.items ?? []).map((category) => ({
      value: category.categoryId,
      label: category.isDefault ? `${category.name} (default)` : category.name,
    }));
    // Keep the select non-empty (and the current value present) while categories load.
    if (!options.some((option) => option.value === categoryId)) {
      options.unshift({ value: categoryId, label: 'Current category' });
    }
    return options;
  }, [categoriesQuery.data, categoryId]);

  const trimmedTitle = title.trim();
  const titleChanged = trimmedTitle !== task.title;
  const descriptionChanged = description.trim() !== (task.description ?? '');
  const categoryChanged = categoryId !== (task.categoryId ?? '') && categoryId !== '';
  const hasChanges = titleChanged || descriptionChanged || categoryChanged;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (updateMutation.isPending || !hasChanges) return;
    if (!trimmedTitle) {
      setTitleError('Title is required.');
      return;
    }
    setTitleError(undefined);
    setSaved(false);

    // Partial update: only changed fields ride along; categoryId is never sent blank.
    const input: UpdateTaskInput = { taskId: task.taskId };
    if (titleChanged) input.title = trimmedTitle;
    if (descriptionChanged) input.description = description.trim();
    if (categoryChanged) input.categoryId = categoryId;

    updateMutation.mutate(input, { onSuccess: () => setSaved(true) });
  }

  return (
    <Panel
      title="Details"
      description="Edit the template's title, description, and category."
      icon={<ClipboardList size={16} />}
    >
      <form className={adminStyles.panelForm} onSubmit={handleSubmit} noValidate>
        <TextField
          label="Title"
          required
          value={title}
          error={titleError}
          disabled={updateMutation.isPending}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError) setTitleError(undefined);
            setSaved(false);
          }}
        />
        <TextAreaField
          label="Description"
          value={description}
          disabled={updateMutation.isPending}
          hint="Leave empty to clear the description."
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
        />
        <Select
          label="Category"
          options={categoryOptions}
          value={categoryId}
          disabled={updateMutation.isPending || categoriesQuery.isLoading}
          hint={categoriesQuery.isLoading ? 'Loading your categories…' : undefined}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setSaved(false);
          }}
        />
        {categoriesQuery.isError && (
          <Alert variant="warning" title="Could not load your categories">
            {gqlErrorMessage(categoriesQuery.error)} Title and description can still be saved.
          </Alert>
        )}

        {updateMutation.isError && (
          <Alert variant="error" title="Could not save the changes">
            {gqlErrorMessage(updateMutation.error)}
          </Alert>
        )}
        {saved && !updateMutation.isError && (
          <Alert variant="success" title="Saved">
            The template was updated.
          </Alert>
        )}

        <div className={adminStyles.formActions}>
          <Button
            type="submit"
            icon={<Save size={15} />}
            loading={updateMutation.isPending}
            disabled={!hasChanges}
          >
            Save changes
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** Deletion with typed confirmation. Active assignments block it server-side. */
function DeleteTaskSection({
  taskId,
  ownerId,
  onDeleted,
}: {
  taskId: string;
  ownerId: string;
  onDeleted: () => void;
}) {
  const deleteMutation = useDeleteTask(ownerId);
  const [confirmText, setConfirmText] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!confirmationMatches('delete', confirmText)) return;
    deleteMutation.mutate(taskId, { onSuccess: onDeleted });
  }

  return (
    <Panel
      title="Delete this template"
      description="Permanently removes the task and all of its steps. The backend rejects deletion while any ACTIVE assignment still references this task — stop or end those below the supported user's calendar first. Snapshots of occurrences a user already started are kept."
      icon={<Trash2 size={16} />}
    >
      <form className={adminStyles.panelForm} onSubmit={handleSubmit}>
        <ConfirmDangerAction
          expected="delete"
          value={confirmText}
          onChange={setConfirmText}
          targetLabel="word"
        />
        {deleteMutation.isError && (
          <Alert variant="error" title="Could not delete this task">
            {gqlErrorMessage(deleteMutation.error)}
          </Alert>
        )}
        <div className={adminStyles.formActions}>
          <Button
            type="submit"
            variant="danger"
            icon={<Trash2 size={15} />}
            loading={deleteMutation.isPending}
            disabled={!confirmationMatches('delete', confirmText)}
          >
            Permanently delete task
          </Button>
        </div>
      </form>
    </Panel>
  );
}
