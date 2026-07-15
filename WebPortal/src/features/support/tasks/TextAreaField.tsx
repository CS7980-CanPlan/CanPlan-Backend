import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import styles from '../../../components/ui/ui.module.css';

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
}

/**
 * Multi-line sibling of the shared TextField, styled with the same ui.module.css classes so
 * task/step descriptions get a proper textarea without introducing a new UI primitive style.
 */
export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ label, hint, error, id, required, className, rows = 3, ...rest }, ref) {
    const reactId = useId();
    const fieldId = id ?? reactId;
    const hintId = hint ? `${fieldId}-hint` : undefined;
    const errorId = error ? `${fieldId}-error` : undefined;

    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={fieldId}>
          {label}
          {required && <span className={styles.required} aria-hidden="true">*</span>}
        </label>
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          className={[styles.control, error ? styles.controlInvalid : '', className ?? '']
            .filter(Boolean)
            .join(' ')}
          style={{ resize: 'vertical' }}
          {...rest}
        />
        {hint && !error && (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        )}
        {error && (
          <span id={errorId} className={styles.errorText}>
            {error}
          </span>
        )}
      </div>
    );
  },
);
