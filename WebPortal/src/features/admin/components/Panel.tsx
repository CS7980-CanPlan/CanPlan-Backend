import { type ReactNode } from 'react';
import styles from '../admin.module.css';

interface PanelProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
}

/** A titled form/content card used throughout the admin area. */
export function Panel({ title, description, icon, children }: PanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        {icon && (
          <span className={styles.panelIcon} aria-hidden="true">
            {icon}
          </span>
        )}
        <div>
          <h2 className={styles.panelTitle}>{title}</h2>
          {description && <div className={styles.panelDesc}>{description}</div>}
        </div>
      </div>
      {children}
    </section>
  );
}
