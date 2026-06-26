import { useEffect, useState } from 'react';
import {
  getDashboardSummary,
  getRecentActivity,
} from '../api/fakeGraphqlClient';
import DashboardCard, {
  type CardAccent,
} from '../components/DashboardCard';
import RecentActivity from '../components/RecentActivity';
import type { DashboardSummary, ProgressEvent } from '../types';
import styles from './StartPage.module.css';

/** Maps a summary metric to its display label, value, and accent color. */
interface SummaryCardConfig {
  key: keyof DashboardSummary;
  label: string;
  hint: string;
  accent: CardAccent;
}

const summaryCards: SummaryCardConfig[] = [
  { key: 'assignedUsers', label: 'Assigned Users', hint: 'People you support', accent: 'primary' },
  { key: 'activeTasks', label: 'Active Tasks', hint: 'In progress or not started', accent: 'warning' },
  { key: 'completedTasks', label: 'Completed Tasks', hint: 'Finished this period', accent: 'success' },
  { key: 'helpRequests', label: 'Help Requests', hint: 'Awaiting your response', accent: 'danger' },
];

/**
 * Landing/dashboard page for the Supporter Portal.
 *
 * Data is fetched through the fake GraphQL API layer on mount. The page tracks
 * loading and error states so the same structure works once real AppSync calls
 * are swapped in.
 */
export default function StartPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activity, setActivity] = useState<ProgressEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      setLoading(true);
      setError(null);
      try {
        const [summaryData, activityData] = await Promise.all([
          getDashboardSummary(),
          getRecentActivity(),
        ]);
        if (!cancelled) {
          setSummary(summaryData);
          setActivity(activityData);
        }
      } catch {
        if (!cancelled) {
          setError('Unable to load dashboard data. Please try again.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadDashboard();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.page}>
      <section className={styles.intro} aria-labelledby="page-title">
        <h1 className={styles.title} id="page-title">
          CanPlan 2.0 Portal
          <span className={styles.mockBadge}>Demo data</span>
        </h1>
        <p className={styles.description}>
          Welcome to the CanPlan 2.0 Supporter Portal. Support workers and
          organization admins can review the people they support, monitor task
          progress, and respond to help requests — all in one place.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="summary-heading">
        <h2 className={styles.sectionHeading} id="summary-heading">
          Dashboard overview
        </h2>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : loading || !summary ? (
          <p className={styles.status} role="status">
            Loading dashboard…
          </p>
        ) : (
          <ul className={styles.cardGrid} aria-label="Dashboard summary metrics">
            {summaryCards.map((card) => (
              <DashboardCard
                key={card.key}
                label={card.label}
                value={summary[card.key]}
                hint={card.hint}
                accent={card.accent}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="activity-heading">
        <h2 className={styles.sectionHeading} id="activity-heading">
          Recent activity
        </h2>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : loading ? (
          <p className={styles.status} role="status">
            Loading activity…
          </p>
        ) : (
          <RecentActivity events={activity} />
        )}
      </section>
    </div>
  );
}
