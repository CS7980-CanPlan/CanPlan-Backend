import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { LogIn, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { authErrorMessage } from '../../auth/authError';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { TextField } from '../../components/ui/TextField';
import { NewPasswordRequiredForm } from './NewPasswordRequiredForm';
import styles from './LoginPage.module.css';

/**
 * First screen at `/`. Authenticates with Cognito, then routes by group:
 * SystemAdmin → /admin, any other authenticated user → /forbidden. Supports the
 * FORCE_CHANGE_PASSWORD (new-password-required) challenge for invited admins.
 */
export default function LoginPage() {
  const { loading, user, isSystemAdmin, signIn } = useAuth();
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
  // Already authenticated — route by role.
  if (user) {
    return <Navigate to={isSystemAdmin ? '/admin' : '/forbidden'} replace />;
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
            <ShieldCheck size={18} />
          </span>
          <span className={styles.brandText}>CanPlan Admin</span>
        </div>
        <p className={styles.subtitle}>Sign in to the administration portal.</p>

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

        <p className={styles.footnote}>Authorized administrators only.</p>
      </div>
    </div>
  );
}
