import { type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import styles from './ui.module.css';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

const VARIANT_CLASS: Record<AlertVariant, string> = {
  info: styles.alertInfo,
  success: styles.alertSuccess,
  warning: styles.alertWarning,
  error: styles.alertError,
};

const VARIANT_ICON: Record<AlertVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  children?: ReactNode;
}

export function Alert({ variant = 'info', title, children }: AlertProps) {
  const Icon = VARIANT_ICON[variant];
  return (
    <div className={`${styles.alert} ${VARIANT_CLASS[variant]}`} role={variant === 'error' ? 'alert' : 'status'}>
      <Icon size={18} className={styles.alertIcon} aria-hidden="true" />
      <div className={styles.alertBody}>
        {title && <div className={styles.alertTitle}>{title}</div>}
        {children}
      </div>
    </div>
  );
}
