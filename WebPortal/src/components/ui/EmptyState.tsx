import { type ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import styles from './ui.module.css';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
}

export function EmptyState({ title, description, icon }: EmptyStateProps) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyIcon} aria-hidden="true">
        {icon ?? <Inbox size={32} />}
      </span>
      <div className={styles.emptyTitle}>{title}</div>
      {description && <div className={styles.emptyDesc}>{description}</div>}
    </div>
  );
}
