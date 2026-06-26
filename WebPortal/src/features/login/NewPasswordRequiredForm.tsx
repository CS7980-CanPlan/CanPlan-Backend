import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { authErrorMessage } from '../../auth/authError';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import styles from './LoginPage.module.css';

/**
 * Second step of the invite flow: Cognito returns NEW_PASSWORD_REQUIRED for
 * admin-created (FORCE_CHANGE_PASSWORD) users. On success the AuthProvider refreshes
 * the session and the LoginPage redirect takes over.
 */
export function NewPasswordRequiredForm({ email }: { email: string }) {
  const { completeNewPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await completeNewPassword(password);
      // On SIGNED_IN the provider updates `user`; LoginPage redirects. No further action.
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <Alert variant="info" title="Set a new password">
        This account ({email}) needs a new password before first use.
      </Alert>
      {error && (
        <div className={styles.formError}>
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="At least 8 characters, with upper- and lower-case letters and a digit."
      />
      <TextField
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <Button type="submit" icon={<KeyRound size={16} />} loading={submitting} fullWidth>
        Set password &amp; sign in
      </Button>
    </form>
  );
}
