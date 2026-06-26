import { type ReactNode } from 'react';
import styles from './ui.module.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: styles.badgeNeutral,
  info: styles.badgeInfo,
  success: styles.badgeSuccess,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>{children}</span>;
}
