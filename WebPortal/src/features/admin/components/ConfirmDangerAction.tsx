import { useId, type ReactNode } from 'react';
import styles from '../admin.module.css';

interface ConfirmDangerActionProps {
  /** The exact text the operator must type to enable the action (e.g. a userId/taskId). */
  expected: string;
  value: string;
  onChange: (value: string) => void;
  /** Label for what they're confirming, e.g. "user id" or "task id". */
  targetLabel: string;
  children?: ReactNode;
}

/** True when the typed confirmation exactly matches the expected value (non-empty). */
export function confirmationMatches(expected: string, value: string): boolean {
  return expected.length > 0 && value === expected;
}

/**
 * Typed-confirmation gate for destructive actions. The caller owns the submit button and
 * disables it via `confirmationMatches(expected, value)`. Renders the exact target value
 * for the operator to copy and an input bound to `value`.
 */
export function ConfirmDangerAction({
  expected,
  value,
  onChange,
  targetLabel,
  children,
}: ConfirmDangerActionProps) {
  const inputId = useId();
  const matches = confirmationMatches(expected, value);

  return (
    <div className={styles.confirmBox}>
      <label htmlFor={inputId} style={{ fontSize: '0.8125rem' }}>
        To confirm, type the exact {targetLabel}{' '}
        <code className={styles.confirmTarget}>{expected || '—'}</code>
      </label>
      <input
        id={inputId}
        className="confirmInput"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Type the ${targetLabel} to confirm`}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={value.length > 0 && !matches}
        style={{
          font: 'inherit',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          padding: '0.45rem 0.6rem',
          border: `1px solid ${value.length > 0 && !matches ? 'var(--color-danger)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-sm)',
          width: '100%',
        }}
      />
      {children}
    </div>
  );
}
