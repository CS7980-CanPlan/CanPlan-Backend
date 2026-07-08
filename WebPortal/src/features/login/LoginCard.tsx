import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, LogIn } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { authErrorMessage } from '../../auth/authError';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { TextField } from '../../components/ui/TextField';
import { NewPasswordRequiredForm } from './NewPasswordRequiredForm';
import styles from './LoginPage.module.css';

/** Group membership used to route an already-authenticated user to the right place. */
export interface RedirectContext {
  isSystemAdmin: boolean;
  isSupportPerson: boolean;
}

interface LoginCardProps {
  /** Brand icon shown in the card header. */
  icon: ReactNode;
  /** Brand line, e.g. "CanPlan Admin". */
  brandText: string;
  /** Short descriptive line under the brand. */
  subtitle: string;
  /** Fine-print line at the bottom of the card. */
  footnote: string;
  /** Where to send an already-authenticated user (their portal home, or `/forbidden`). */
  redirectFor: (ctx: RedirectContext) => string;
}

/**
 * Reusable Cognito sign-in card shared by the admin and support portals. Owns the
 * password + FORCE_CHANGE_PASSWORD (new-password-required) flow; branding and the
 * post-login destination are supplied by the wrapping portal via props.
 */
export function LoginCard({ icon, brandText, subtitle, footnote, redirectFor }: LoginCardProps) {
  const { loading, user, isSystemAdmin, isSupportPerson, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);

  // Wait for the session bootstrap before deciding anything.
  if (loading) {
    return (
      <div className={styles.page}>
        <Spinner label="Loading…" />
      </div>
    );
  }
  // Already authenticated — route by group.
  if (user) {
    return <Navigate to={redirectFor({ isSystemAdmin, isSupportPerson })} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const status = await signIn(email.trim(), password);
      if (status === 'NEW_PASSWORD_REQUIRED') {
        setNeedsNewPassword(true);
      }
      // On SIGNED_IN the provider sets `user`; this component re-renders and redirects.
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {icon}
          </span>
          <span className={styles.brandText}>{brandText}</span>
        </div>
        <p className={styles.subtitle}>{subtitle}</p>

        {needsNewPassword ? (
          <NewPasswordRequiredForm email={email.trim()} />
        ) : (
          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            {error && (
              <div className={styles.formError}>
                <Alert variant="error">{error}</Alert>
              </div>
            )}
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" icon={<LogIn size={16} />} loading={submitting} fullWidth>
              Sign in
            </Button>
          </form>
        )}

        <p className={styles.footnote}>{footnote}</p>
        <Link to="/" className={styles.backLink}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back to portal home
        </Link>
      </div>
    </div>
  );
}
