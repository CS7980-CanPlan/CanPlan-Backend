import styles from './ui.module.css';

interface SpinnerProps {
  /** Optional visible label shown beside the spinner (also used as the aria-label). */
  label?: string;
  size?: 'sm' | 'md';
}

export function Spinner({ label, size = 'md' }: SpinnerProps) {
  const dimension = size === 'sm' ? '1rem' : '1.1rem';
  return (
    <span className={styles.spinnerWrap} role="status">
      <span className={styles.spinner} style={{ width: dimension, height: dimension }} aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="sr-only">Loading…</span>}
    </span>
  );
}
