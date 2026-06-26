import styles from './DashboardCard.module.css';

export type CardAccent = 'primary' | 'success' | 'warning' | 'danger';

interface DashboardCardProps {
  label: string;
  value: number;
  hint?: string;
  accent?: CardAccent;
}

/**
 * A single metric card for the dashboard summary grid (e.g. "Active Tasks").
 * Rendered as a list item so the grid can be marked up as a semantic list.
 */
export default function DashboardCard({
  label,
  value,
  hint,
  accent = 'primary',
}: DashboardCardProps) {
  return (
    <li className={styles.card} data-accent={accent}>
      <p className={styles.label}>{label}</p>
      <span className={styles.value} aria-label={`${value} ${label}`}>
        {value}
      </span>
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </li>
  );
}
