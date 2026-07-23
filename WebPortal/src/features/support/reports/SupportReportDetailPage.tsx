import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Download, RefreshCw, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { ReportDocument } from '../../../api/apiTypes';
import { gqlErrorMessage } from '../../../api/graphqlError';
import {
  useDeleteReport,
  useReportDownloadUrl,
  useReportPdfDownloadUrl,
  useUserProfile,
} from '../../../api/supportHooks';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { Spinner } from '../../../components/ui/Spinner';
import {
  ConfirmDangerAction,
  confirmationMatches,
} from '../../admin/components/ConfirmDangerAction';
import { formatDate, IdCell } from '../../admin/components/display';
import adminStyles from '../../admin/admin.module.css';
import { ReportViewer } from './ReportViewer';
import { parseReportDocument } from './reportFormat';
import styles from './reports.module.css';

interface LoadedReport {
  document: ReportDocument;
}

interface ReportDetailRouteState {
  justSaved?: boolean;
  returnTo?: string;
}

/** Immutable, formatted saved-report view with PDF download and permanent deletion. */
export default function SupportReportDetailPage() {
  const { userId = '', reportId = '' } = useParams<{
    userId: string;
    reportId: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as ReportDetailRouteState | null;
  const [justSaved] = useState(() => Boolean(routeState?.justSaved));
  const [returnTo] = useState(() => safeReportDirectoryUrl(routeState?.returnTo));

  const [loaded, setLoaded] = useState<LoadedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const profileQuery = useUserProfile(userId);
  const downloadMutation = useReportDownloadUrl();
  const pdfMutation = useReportPdfDownloadUrl();
  const deleteMutation = useDeleteReport(userId);
  const displayName =
    profileQuery.data?.displayName || profileQuery.data?.email || userId || 'Supported person';

  useEffect(() => {
    if (!justSaved) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [justSaved, location.hash, location.pathname, location.search, navigate]);

  async function loadReport() {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setLoadError(null);
    setLoaded(null);
    downloadMutation.reset();

    try {
      const target = await downloadMutation.mutateAsync({ userId, reportId });
      if (requestRef.current !== requestId || controller.signal.aborted) return;
      const response = await fetch(target.downloadUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Report download failed with HTTP ${response.status}.`);
      }
      const document = parseReportDocument((await response.json()) as unknown);
      if (requestRef.current !== requestId || controller.signal.aborted) return;
      if (document.reportId !== reportId || document.scope.userId !== userId) {
        throw new Error('Downloaded report does not match the selected report and person.');
      }
      setLoaded({ document });
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (error) {
      if (
        requestRef.current === requestId &&
        !controller.signal.aborted &&
        (error as { name?: string })?.name !== 'AbortError'
      ) {
        setLoadError(gqlErrorMessage(error));
      }
    } finally {
      if (requestRef.current === requestId && !controller.signal.aborted) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }

  useEffect(() => {
    void loadReport();
    return () => {
      requestRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // The route ids are the load boundary. The mutation object is stable for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, reportId]);

  async function downloadPdf() {
    setPdfError(null);
    pdfMutation.reset();
    try {
      const target = await pdfMutation.mutateAsync({ userId, reportId });
      const anchor = document.createElement('a');
      anchor.href = target.downloadUrl;
      anchor.download = `CanPlan-report-${reportId}.pdf`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      setPdfError(gqlErrorMessage(error));
    }
  }

  function confirmDelete(event: FormEvent) {
    event.preventDefault();
    if (!confirmationMatches(reportId, deleteConfirmation)) return;
    setDeleteError(null);
    deleteMutation.mutate(reportId, {
      onSuccess: () => {
        navigate(returnTo, {
          replace: true,
          state: { deletedReportId: reportId },
        });
      },
      onError: (error) => setDeleteError(gqlErrorMessage(error)),
    });
  }

  return (
    <div>
      <Link to={returnTo} className={adminStyles.backLink}>
        <ArrowLeft size={15} /> Back to reports
      </Link>

      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>Saved report</h1>
        <p className={adminStyles.pageSubtitle}>
          A saved, immutable task-completion report for {displayName}.
        </p>
      </div>

      {justSaved && (
        <Alert variant="success" title="Report saved">
          The generated report is now stored and available from the Reports tab.
        </Alert>
      )}

      {loading ? (
        <div className={styles.detailLoading}>
          <Spinner label="Loading saved report…" />
        </div>
      ) : loadError || !loaded ? (
        <div className={styles.errorBlock}>
          <Alert variant="error" title="Could not open this saved report">
            {loadError ?? 'The report could not be loaded.'} Access requires a currently active
            support relationship with this person.
          </Alert>
          <div className={styles.actionRow}>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} />}
              onClick={() => void loadReport()}
            >
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate(returnTo)}>
              Return to reports
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ReportViewer
            headingRef={headingRef}
            heading={`${displayName}'s progress report`}
            subheading={`Coverage ${loaded.document.dateRange.from} through ${
              loaded.document.dateRange.to
            } · Saved ${formatDate(loaded.document.createdAt)}`}
            narrative={loaded.document.narrative}
            stats={loaded.document.stats}
            userId={userId}
            notice={
              <>
                <Alert variant="info" title="Saved report">
                  This is the immutable report stored at generation time. Downloading a PDF does not
                  change the saved report.
                </Alert>
                {pdfError && (
                  <Alert variant="error" title="Could not prepare the PDF">
                    {pdfError}
                  </Alert>
                )}
              </>
            }
            actions={
              <Button
                icon={<Download size={15} />}
                loading={pdfMutation.isPending}
                onClick={() => void downloadPdf()}
              >
                Download PDF
              </Button>
            }
          >
            <dl className={styles.savedDocumentMeta}>
              <div>
                <dt>Person</dt>
                <dd>
                  {displayName} <IdCell id={userId} />
                </dd>
              </div>
              <div>
                <dt>Saved by</dt>
                <dd>
                  <IdCell id={loaded.document.createdBy} />
                </dd>
              </div>
              <div>
                <dt>Report id</dt>
                <dd>
                  <IdCell id={loaded.document.reportId} />
                </dd>
              </div>
              <div>
                <dt>Saved at</dt>
                <dd>{formatDate(loaded.document.createdAt)}</dd>
              </div>
            </dl>
          </ReportViewer>

          <section className={styles.deletePanel} aria-labelledby="delete-report-heading">
            <div>
              <h2 id="delete-report-heading">Delete report</h2>
              <p>
                Permanently remove this report and its downloadable files. This cannot be undone.
              </p>
            </div>

            {!deleteOpen ? (
              <Button
                ref={deleteButtonRef}
                variant="danger"
                icon={<Trash2 size={15} />}
                onClick={() => {
                  setDeleteOpen(true);
                  setDeleteConfirmation('');
                  setDeleteError(null);
                  requestAnimationFrame(() => {
                    document
                      .getElementById('delete-saved-report-confirmation')
                      ?.querySelector<HTMLInputElement>('input')
                      ?.focus();
                  });
                }}
              >
                Delete report
              </Button>
            ) : (
              <form
                id="delete-saved-report-confirmation"
                className={styles.deleteForm}
                onSubmit={confirmDelete}
              >
                <Alert variant="warning" title="Permanently delete this report?">
                  Both the saved metadata and private report documents will be removed.
                </Alert>
                <ConfirmDangerAction
                  expected={reportId}
                  value={deleteConfirmation}
                  onChange={setDeleteConfirmation}
                  targetLabel="report id"
                />
                {deleteError && (
                  <Alert variant="error" title="The delete response was not confirmed">
                    {deleteError} Return to the report directory and refresh before trying again;
                    the report may already have been removed.
                  </Alert>
                )}
                <div className={styles.actionRow}>
                  <Button
                    type="submit"
                    variant="danger"
                    icon={<Trash2 size={15} />}
                    loading={deleteMutation.isPending}
                    disabled={!confirmationMatches(reportId, deleteConfirmation)}
                  >
                    Permanently delete
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      setDeleteOpen(false);
                      setDeleteConfirmation('');
                      setDeleteError(null);
                      deleteMutation.reset();
                      requestAnimationFrame(() => deleteButtonRef.current?.focus());
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function safeReportDirectoryUrl(value: string | undefined): string {
  if (!value) return '/support/reports';
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || parsed.pathname !== '/support/reports') {
      return '/support/reports';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/support/reports';
  }
}
