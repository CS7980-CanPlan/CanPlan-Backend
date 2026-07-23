import type { ReactNode, Ref } from 'react';
import type { ReportStats } from '../../../api/apiTypes';
import { ReportStatsView } from './ReportStatsView';
import styles from './reports.module.css';

interface ReportViewerProps {
  headingRef?: Ref<HTMLHeadingElement>;
  heading: string;
  subheading: string;
  narrative: string;
  stats: ReportStats;
  userId: string;
  notice?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

/** Shared formatted presentation for both an unsaved preview and an immutable saved report. */
export function ReportViewer({
  headingRef,
  heading,
  subheading,
  narrative,
  stats,
  userId,
  notice,
  actions,
  children,
}: ReportViewerProps) {
  return (
    <section className={styles.reportViewer}>
      <div className={styles.viewerHead}>
        <div>
          <h2 ref={headingRef} tabIndex={-1} className={styles.viewerTitle}>
            {heading}
          </h2>
          <p className={styles.viewerSubtitle}>{subheading}</p>
        </div>
        {actions ? <div className={styles.actionRow}>{actions}</div> : null}
      </div>

      {notice}
      {children}

      <section className={styles.narrative}>
        <h3>AI narrative</h3>
        <p className={styles.narrativeHelp}>
          AI-generated plain-language interpretation for support planning; not clinical advice.
        </p>
        <div className={styles.narrativeText}>{narrative}</div>
      </section>

      <ReportStatsView stats={stats} userId={userId} />
    </section>
  );
}
