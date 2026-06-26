import type { ProgressEvent, ProgressEventType } from '../types';
import styles from './RecentActivity.module.css';

interface RecentActivityProps {
  events: ProgressEvent[];
}

/** Emoji icon shown next to each activity type. Decorative only. */
const eventIcon: Record<ProgressEventType, string> = {
  task_started: '▶️',
  task_completed: '✅',
  step_completed: '☑️',
  help_requested: '🆘',
};

/** Formats an ISO timestamp into a short, readable local date-time string. */
function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A timeline panel listing the most recent user activity events. */
export default function RecentActivity({ events }: RecentActivityProps) {
  if (events.length === 0) {
    return <p className={styles.empty}>No recent activity to show.</p>;
  }

  return (
    <div className={styles.panel}>
      <ul className={styles.list}>
        {events.map((event) => (
          <li key={event.id} className={styles.item}>
            <span className={styles.icon} data-type={event.type} aria-hidden="true">
              {eventIcon[event.type]}
            </span>
            <div className={styles.body}>
              <p className={styles.message}>{event.message}</p>
              <time className={styles.time} dateTime={event.occurredAt}>
                {formatTime(event.occurredAt)}
              </time>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
