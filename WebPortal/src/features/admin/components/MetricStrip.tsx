import { type ReactNode } from 'react';
import styles from '../admin.module.css';

export interface Metric {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
}

/** A responsive row of compact metric tiles. */
export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <div className={styles.metrics}>
      {metrics.map((metric) => (
        <div key={metric.label} className={styles.metric}>
          {metric.icon && <span className={styles.metricIcon} aria-hidden="true">{metric.icon}</span>}
          <div className={styles.metricBody}>
            <div className={styles.metricValue}>{metric.value}</div>
            <div className={styles.metricLabel}>{metric.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
