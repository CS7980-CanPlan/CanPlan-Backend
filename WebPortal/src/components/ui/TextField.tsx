import { forwardRef, useId, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import styles from './ui.module.css';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  showPasswordToggle?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, id, required, className, showPasswordToggle = false, type, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const [passwordVisible, setPasswordVisible] = useState(false);
  const canTogglePassword = showPasswordToggle && type === 'password';
  const resolvedType = canTogglePassword && passwordVisible ? 'text' : type;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
        {required && <span className={styles.required} aria-hidden="true">*</span>}
      </label>
      <div className={styles.controlWrap}>
        <input
          ref={ref}
          id={inputId}
          type={resolvedType}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          className={[
            styles.control,
            error ? styles.controlInvalid : '',
            canTogglePassword ? styles.controlWithTrailingAction : '',
            className ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        />
        {canTogglePassword && (
          <button
            type="button"
            className={styles.passwordToggle}
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
            aria-pressed={passwordVisible}
            title={passwordVisible ? 'Hide password' : 'Show password'}
            disabled={rest.disabled}
            onClick={() => setPasswordVisible((visible) => !visible)}
          >
            {passwordVisible ? (
              <EyeOff size={17} aria-hidden="true" />
            ) : (
              <Eye size={17} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
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
});
