import { Navigate, useParams, useSearchParams } from 'react-router-dom';

/**
 * Compatibility redirect for bookmarks from the former user-detail report page.
 * Report generation now lives in the top-level Reports module.
 */
export default function SupportUserReportsPage() {
  const { userId = '' } = useParams<{ userId: string }>();
  const [current] = useSearchParams();
  const next = new URLSearchParams(current);
  if (userId) next.set('userId', userId);

  return <Navigate replace to={`/support/reports?${next.toString()}#generate-report`} />;
}
