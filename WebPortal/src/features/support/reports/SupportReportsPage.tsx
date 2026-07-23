import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FileText, RefreshCw, Save, Sparkles, X } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  GeneratedReport,
  ParsedGeneratedReport,
  Report,
  SupportedReportFilterInput,
} from '../../../api/apiTypes';
import { gqlErrorMessage } from '../../../api/graphqlError';
import {
  useGenerateReport,
  useMySupportedUserReports,
  useMySupportList,
  useSaveReport,
  useSupportedUserProfiles,
} from '../../../api/supportHooks';
import { parseGeneratedReport, toSaveReportInput } from '../../../api/supportApi';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Spinner } from '../../../components/ui/Spinner';
import { TextField } from '../../../components/ui/TextField';
import { Panel } from '../../admin/components/Panel';
import { formatDate, IdCell } from '../../admin/components/display';
import adminStyles from '../../admin/admin.module.css';
import { ReportViewer } from './ReportViewer';
import {
  assertCompleteStats,
  isValidIsoDate,
  savedReportRange,
  savedReportUserId,
  todayIsoDate,
  validateReportRange,
} from './reportFormat';
import styles from './reports.module.css';

interface SavedFilters {
  userId: string;
  savedFrom: string;
  savedTo: string;
}

const EMPTY_SAVED_FILTERS: SavedFilters = { userId: '', savedFrom: '', savedTo: '' };

/** Top-level report directory and report generator for every currently supported person. */
export default function SupportReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const today = useMemo(todayIsoDate, []);
  const [deletedReportId] = useState(
    () => (location.state as { deletedReportId?: string } | null)?.deletedReportId,
  );

  const [generatorUserId, setGeneratorUserId] = useState(searchParams.get('userId') ?? '');
  const [from, setFrom] = useState(validQueryDate(searchParams.get('from'), today));
  const [to, setTo] = useState(validQueryDate(searchParams.get('to'), today));
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [rawPreview, setRawPreview] = useState<GeneratedReport | null>(null);
  const [preview, setPreview] = useState<ParsedGeneratedReport | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [saveAttempted, setSaveAttempted] = useState(false);

  const initialSavedFilters = useMemo(
    () => readSavedFilters(searchParams),
    // Initial URL state is intentionally captured once; Apply/Reset own subsequent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [savedDraft, setSavedDraft] = useState(initialSavedFilters);
  const [appliedSaved, setAppliedSaved] = useState(initialSavedFilters);
  const [savedFilterError, setSavedFilterError] = useState<string | null>(null);

  const generationRequestRef = useRef(0);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);

  const supportListQuery = useMySupportList();
  const supportedUserIds = useMemo(
    () =>
      (supportListQuery.data?.items ?? [])
        .filter((link) => link.status === 'ACTIVE')
        .map((link) => link.primaryUserId),
    [supportListQuery.data],
  );
  const profileQueries = useSupportedUserProfiles(supportedUserIds);
  const namesByUserId = useMemo(
    () =>
      new Map(
        profileQueries.map(({ userId, query }) => {
          const profile = query.data;
          return [userId, profile?.displayName || profile?.email || userId] as const;
        }),
      ),
    [profileQueries],
  );
  const personOptions = useMemo(
    () =>
      supportedUserIds
        .map((userId) => ({
          value: userId,
          label: namesByUserId.get(userId) ?? userId,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [namesByUserId, supportedUserIds],
  );

  const backendFilter = useMemo(() => toBackendFilter(appliedSaved), [appliedSaved]);
  const reportsQuery = useMySupportedUserReports(backendFilter);
  const reports = useMemo(
    () => reportsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [reportsQuery.data],
  );

  const generateMutation = useGenerateReport();
  const saveMutation = useSaveReport(generatorUserId);
  const reportDirectoryUrl = `${location.pathname}${location.search}${location.hash}`;
  const selectedDisplayName = namesByUserId.get(generatorUserId) ?? generatorUserId;
  const visiblePreview =
    preview?.scope.userId === generatorUserId &&
    preview.dateRange.from === from &&
    preview.dateRange.to === to
      ? preview
      : null;

  useEffect(() => {
    if (!deletedReportId) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [deletedReportId, location.hash, location.pathname, location.search, navigate]);

  function clearPreview() {
    if (saveMutation.isPending) return;
    generationRequestRef.current += 1;
    setRawPreview(null);
    setPreview(null);
    setResponseError(null);
    setSaveAttempted(false);
    generateMutation.reset();
    saveMutation.reset();
  }

  function changeGeneratorUser(userId: string) {
    clearPreview();
    setGeneratorUserId(userId);
    setRangeError(null);
  }

  function changeFrom(value: string) {
    clearPreview();
    setFrom(value);
    setRangeError(null);
  }

  function changeTo(value: string) {
    clearPreview();
    setTo(value);
    setRangeError(null);
  }

  function generate(event: FormEvent) {
    event.preventDefault();
    if (saveMutation.isPending) return;
    if (!generatorUserId) {
      setRangeError('Choose a supported person.');
      return;
    }
    if (!supportedUserIds.includes(generatorUserId)) {
      setRangeError('That person is not in your current support list.');
      return;
    }
    const error = validateReportRange(from, to);
    setRangeError(error);
    if (error) return;

    setRawPreview(null);
    setPreview(null);
    setResponseError(null);
    setSaveAttempted(false);
    saveMutation.reset();

    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    const requested = { userId: generatorUserId, from, to };
    generateMutation.mutate(requested, {
      onSuccess: (generated) => {
        if (generationRequestRef.current !== requestId) return;
        try {
          const parsed = parseGeneratedReport(generated);
          assertCompleteStats(parsed.stats);
          if (
            parsed.scope.userId !== requested.userId ||
            parsed.dateRange.from !== requested.from ||
            parsed.dateRange.to !== requested.to ||
            parsed.stats.meta.userId !== requested.userId ||
            parsed.stats.meta.from !== requested.from ||
            parsed.stats.meta.to !== requested.to
          ) {
            throw new Error('Generated report scope or date range does not match the request.');
          }
          setRawPreview(generated);
          setPreview(parsed);
          updateSearchParams(setSearchParams, {
            userId: requested.userId,
            from: requested.from,
            to: requested.to,
          });
          requestAnimationFrame(() => previewHeadingRef.current?.focus());
        } catch (error) {
          setResponseError(gqlErrorMessage(error));
        }
      },
    });
  }

  function savePreview() {
    if (!rawPreview || !visiblePreview || saveAttempted) return;
    const requestId = generationRequestRef.current;
    const reportUserId = visiblePreview.scope.userId;
    setSaveAttempted(true);
    saveMutation.mutate(toSaveReportInput(rawPreview), {
      onSuccess: (report) => {
        if (generationRequestRef.current !== requestId) return;
        navigate(
          `/support/reports/${encodeURIComponent(reportUserId)}/${encodeURIComponent(
            report.reportId,
          )}`,
          { state: { justSaved: true, returnTo: reportDirectoryUrl } },
        );
      },
    });
  }

  function applySavedFilters(event: FormEvent) {
    event.preventDefault();
    const error = validateSavedFilters(savedDraft);
    setSavedFilterError(error);
    if (error) return;
    setAppliedSaved(savedDraft);
    updateSearchParams(setSearchParams, {
      savedUser: savedDraft.userId,
      savedFrom: savedDraft.savedFrom,
      savedTo: savedDraft.savedTo,
    });
  }

  function resetSavedFilters() {
    setSavedDraft(EMPTY_SAVED_FILTERS);
    setAppliedSaved(EMPTY_SAVED_FILTERS);
    setSavedFilterError(null);
    updateSearchParams(setSearchParams, {
      savedUser: '',
      savedFrom: '',
      savedTo: '',
    });
  }

  const savedFiltersChanged =
    savedDraft.userId !== appliedSaved.userId ||
    savedDraft.savedFrom !== appliedSaved.savedFrom ||
    savedDraft.savedTo !== appliedSaved.savedTo;

  return (
    <div>
      <div className={adminStyles.pageHead}>
        <h1 className={adminStyles.pageTitle}>Reports</h1>
        <p className={adminStyles.pageSubtitle}>
          Generate progress reports and review every report saved for people you currently support.
        </p>
      </div>

      {deletedReportId && (
        <Alert variant="success" title="Report deleted">
          Report <IdCell id={deletedReportId} /> and its private download files were permanently
          removed.
        </Alert>
      )}

      <div id="generate-report" className={styles.sectionAnchor}>
        <Panel
          title="Generate report"
          description="Choose a supported person and the inclusive task-completion period to analyze."
          icon={<Sparkles size={16} />}
        >
          <form className={styles.generatorForm} onSubmit={generate} noValidate>
            <Alert variant="info" title="Available report controls">
              The backend accepts the supported person, From date, and To date. Its deterministic
              statistics and AI narrative instructions are fixed; there are no hidden tone,
              category, task, or custom-prompt controls.
            </Alert>

            <div className={styles.generatorGrid}>
              <Select
                label="Supported person"
                value={generatorUserId}
                required
                disabled={
                  supportListQuery.isLoading || generateMutation.isPending || saveMutation.isPending
                }
                options={[{ value: '', label: 'Choose a supported person' }, ...personOptions]}
                onChange={(event) => changeGeneratorUser(event.target.value)}
              />
              <TextField
                type="date"
                label="From (inclusive)"
                value={from}
                max={to || undefined}
                disabled={generateMutation.isPending || saveMutation.isPending}
                required
                onChange={(event) => changeFrom(event.target.value)}
              />
              <TextField
                type="date"
                label="To (inclusive)"
                value={to}
                min={from || undefined}
                disabled={generateMutation.isPending || saveMutation.isPending}
                required
                onChange={(event) => changeTo(event.target.value)}
              />
            </div>

            {supportListQuery.isError && (
              <Alert variant="error" title="Could not load people you support">
                {gqlErrorMessage(supportListQuery.error)}
              </Alert>
            )}
            {!supportListQuery.isLoading &&
              !supportListQuery.isError &&
              supportedUserIds.length === 0 && (
                <Alert variant="warning" title="No supported people available">
                  Add a primary user from Manage people before generating a report.
                </Alert>
              )}
            {rangeError && (
              <Alert variant="error" title="Check the report request">
                {rangeError}
              </Alert>
            )}
            {generateMutation.isError && (
              <Alert variant="error" title="Could not generate the report">
                {gqlErrorMessage(generateMutation.error)}
              </Alert>
            )}
            {responseError && (
              <Alert variant="error" title="The generated response could not be displayed">
                {responseError}
              </Alert>
            )}

            <p className={styles.formHelp}>
              Maximum 366 calendar days. Generation creates an unsaved preview; nothing is kept
              until you explicitly save it.
            </p>
            <div className={styles.actionRow}>
              <Button
                type="submit"
                icon={<Sparkles size={15} />}
                loading={generateMutation.isPending}
                disabled={
                  !generatorUserId || supportedUserIds.length === 0 || saveMutation.isPending
                }
              >
                Generate unsaved preview
              </Button>
            </div>
          </form>
        </Panel>
      </div>

      {visiblePreview && (
        <ReportViewer
          headingRef={previewHeadingRef}
          heading="Unsaved report preview"
          subheading={`Generated ${formatDate(visiblePreview.generatedAt)} for ${
            selectedDisplayName || 'the selected person'
          } · ${visiblePreview.dateRange.from} through ${visiblePreview.dateRange.to}`}
          narrative={visiblePreview.narrative}
          stats={visiblePreview.stats}
          userId={visiblePreview.scope.userId}
          notice={
            <Alert variant="warning" title="Review and save within 15 minutes">
              This preview has not been persisted. Saving sends the exact signed draft back to the
              backend; edits are not supported.
            </Alert>
          }
          actions={
            <>
              <Button
                icon={<Save size={15} />}
                onClick={savePreview}
                loading={saveMutation.isPending}
                disabled={saveAttempted}
              >
                {saveAttempted ? 'Save already attempted' : 'Save and open report'}
              </Button>
              <Button
                variant="secondary"
                icon={<X size={15} />}
                onClick={clearPreview}
                disabled={saveMutation.isPending}
              >
                Discard preview
              </Button>
            </>
          }
        >
          {saveMutation.isError && (
            <Alert variant="error" title="The save response was not confirmed">
              {gqlErrorMessage(saveMutation.error)} The report directory is being refreshed because
              a lost response can hide a successful save. Check Saved reports before generating a
              fresh preview; this signed draft cannot be retried here.
            </Alert>
          )}
        </ReportViewer>
      )}

      <div className={styles.panelGap}>
        <Panel
          title="Saved reports"
          description="Newest saved reports appear first. Filter by person or the date the report was saved."
          icon={<FileText size={16} />}
        >
          <form className={styles.savedFilterForm} onSubmit={applySavedFilters} noValidate>
            <div className={styles.savedFilterGrid}>
              <Select
                label="Person"
                value={savedDraft.userId}
                options={[{ value: '', label: 'All supported people' }, ...personOptions]}
                onChange={(event) => {
                  setSavedDraft((current) => ({ ...current, userId: event.target.value }));
                  setSavedFilterError(null);
                }}
              />
              <TextField
                type="date"
                label="Saved from"
                value={savedDraft.savedFrom}
                max={savedDraft.savedTo || undefined}
                onChange={(event) => {
                  setSavedDraft((current) => ({ ...current, savedFrom: event.target.value }));
                  setSavedFilterError(null);
                }}
              />
              <TextField
                type="date"
                label="Saved to"
                value={savedDraft.savedTo}
                min={savedDraft.savedFrom || undefined}
                onChange={(event) => {
                  setSavedDraft((current) => ({ ...current, savedTo: event.target.value }));
                  setSavedFilterError(null);
                }}
              />
            </div>
            {savedFilterError && (
              <Alert variant="error" title="Check the saved-date filter">
                {savedFilterError}
              </Alert>
            )}
            <div className={styles.actionRow}>
              <Button type="submit" size="sm" disabled={!savedFiltersChanged && !savedFilterError}>
                Apply filters
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  !savedDraft.userId &&
                  !savedDraft.savedFrom &&
                  !savedDraft.savedTo &&
                  !appliedSaved.userId &&
                  !appliedSaved.savedFrom &&
                  !appliedSaved.savedTo
                }
                onClick={resetSavedFilters}
              >
                Reset
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={14} />}
                loading={reportsQuery.isFetching && !reportsQuery.isFetchingNextPage}
                onClick={() => reportsQuery.refetch()}
              >
                Refresh
              </Button>
            </div>
          </form>

          <p className={styles.resultSummary} aria-live="polite">
            {reportsQuery.isLoading
              ? 'Loading saved reports…'
              : `${reports.length} saved ${reports.length === 1 ? 'report' : 'reports'} loaded${
                  reportsQuery.hasNextPage ? '; more are available' : ''
                }.`}
          </p>

          {reportsQuery.isLoading ? (
            <div className={styles.loadingBlock}>
              <Spinner label="Loading saved reports…" />
            </div>
          ) : reportsQuery.isError ? (
            <div className={styles.errorBlock}>
              <Alert variant="error" title="Could not load saved reports">
                {gqlErrorMessage(reportsQuery.error)}
              </Alert>
              <Button size="sm" variant="secondary" onClick={() => reportsQuery.refetch()}>
                Try again
              </Button>
            </div>
          ) : reports.length === 0 ? (
            <EmptyState
              title="No saved reports match"
              description={
                appliedSaved.userId || appliedSaved.savedFrom || appliedSaved.savedTo
                  ? 'Reset or change the filters, or generate and save a new report above.'
                  : 'Generate a preview above and explicitly save it to create the first report.'
              }
            />
          ) : (
            <div className={styles.savedList}>
              {reports.map((report) => (
                <SavedReportCard
                  key={`${savedReportUserId(report) ?? 'unknown'}-${report.reportId}`}
                  report={report}
                  displayName={
                    namesByUserId.get(savedReportUserId(report) ?? '') ?? 'Supported person'
                  }
                  returnTo={reportDirectoryUrl}
                />
              ))}
            </div>
          )}

          {reportsQuery.hasNextPage && (
            <div className={styles.loadMore}>
              <Button
                size="sm"
                variant="secondary"
                loading={reportsQuery.isFetchingNextPage}
                onClick={() => reportsQuery.fetchNextPage()}
              >
                Load more reports
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function SavedReportCard({
  report,
  displayName,
  returnTo,
}: {
  report: Report;
  displayName: string;
  returnTo: string;
}) {
  const userId = savedReportUserId(report);
  const range = savedReportRange(report);
  const href = userId
    ? `/support/reports/${encodeURIComponent(userId)}/${encodeURIComponent(report.reportId)}`
    : null;

  return (
    <article className={styles.savedCard}>
      <div className={styles.savedCardHead}>
        <div>
          <div className={styles.savedPerson}>{displayName}</div>
          <div className={styles.savedRange}>
            {range ? `${range.from} through ${range.to}` : 'Coverage dates unavailable'}
          </div>
          <div className={styles.savedMeta}>Saved {formatDate(report.createdAt)}</div>
        </div>
        <Badge tone="success">Saved</Badge>
      </div>

      <div className={styles.reportIdentity}>
        <span>Report id</span>
        <IdCell id={report.reportId} />
      </div>

      {href ? (
        <Link className={styles.openReportLink} to={href} state={{ returnTo }}>
          Open formatted report
        </Link>
      ) : (
        <Alert variant="warning" title="This report cannot be opened">
          Its saved subject metadata is invalid. Refresh the list or ask an administrator to inspect
          the record.
        </Alert>
      )}
    </article>
  );
}

function readSavedFilters(params: URLSearchParams): SavedFilters {
  const userId = params.get('savedUser') ?? '';
  const savedFrom = params.get('savedFrom') ?? '';
  const savedTo = params.get('savedTo') ?? '';
  return {
    userId,
    savedFrom: isValidIsoDate(savedFrom) ? savedFrom : '',
    savedTo: isValidIsoDate(savedTo) ? savedTo : '',
  };
}

function validateSavedFilters(filters: SavedFilters): string | null {
  if (filters.savedFrom && !isValidIsoDate(filters.savedFrom)) {
    return 'Choose a valid Saved from date.';
  }
  if (filters.savedTo && !isValidIsoDate(filters.savedTo)) {
    return 'Choose a valid Saved to date.';
  }
  if (filters.savedFrom && filters.savedTo && filters.savedFrom > filters.savedTo) {
    return 'Saved to cannot be before Saved from.';
  }
  return null;
}

function toBackendFilter(filters: SavedFilters): SupportedReportFilterInput {
  return {
    userId: filters.userId || undefined,
    createdFrom: filters.savedFrom ? localDateBoundary(filters.savedFrom, false) : undefined,
    createdTo: filters.savedTo ? localDateBoundary(filters.savedTo, true) : undefined,
  };
}

/** Convert a browser-local calendar day to an unambiguous UTC timestamp for the API. */
function localDateBoundary(value: string, endOfDay: boolean): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  return date.toISOString();
}

function updateSearchParams(
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  values: Record<string, string>,
) {
  setSearchParams(
    (current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    },
    { replace: true },
  );
}

function validQueryDate(value: string | null, fallback: string): string {
  return value && isValidIsoDate(value) ? value : fallback;
}
