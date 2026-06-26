import { type ReactNode } from 'react';
import { Alert } from '../../../components/ui/Alert';
import { Spinner } from '../../../components/ui/Spinner';
import styles from '../admin.module.css';

interface MutationResultPanelProps<TData> {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
  data: TData | undefined;
  /** Title shown above the success payload. */
  successTitle?: string;
  /** Custom success body; defaults to a JSON dump of the result payload. */
  renderSuccess?: (data: TData) => ReactNode;
  /** Message shown when a mutation succeeds but returns null (e.g. task already gone). */
  emptyMessage?: string;
}

/** Turn a GraphQL error (graphql-request) or any Error into a readable message. */
function readError(error: unknown): string {
  const response = (error as { response?: { errors?: Array<{ message?: string }> } })?.response;
  const gqlMessage = response?.errors?.map((e) => e.message).filter(Boolean).join('; ');
  if (gqlMessage) return gqlMessage;
  if (error instanceof Error) return error.message;
  return 'The request failed. Please try again.';
}

/** Uniform loading / success / error / result-payload panel for a mutation. */
export function MutationResultPanel<TData>({
  isPending,
  isError,
  error,
  isSuccess,
  data,
  successTitle = 'Success',
  renderSuccess,
  emptyMessage = 'Completed. Nothing was returned.',
}: MutationResultPanelProps<TData>) {
  if (isPending) {
    return (
      <div className={styles.resultBlock}>
        <Spinner label="Working…" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={styles.resultBlock}>
        <Alert variant="error" title="Request failed">
          {readError(error)}
        </Alert>
      </div>
    );
  }
  if (isSuccess) {
    return (
      <div className={styles.resultBlock}>
        <Alert variant="success" title={successTitle}>
          {data == null
            ? emptyMessage
            : renderSuccess
              ? renderSuccess(data)
              : null}
        </Alert>
        {data != null && !renderSuccess && (
          <pre className={styles.resultJson}>{JSON.stringify(data, null, 2)}</pre>
        )}
      </div>
    );
  }
  return null;
}
