import { ShieldCheck } from 'lucide-react';
import { LoginCard } from './LoginCard';

/**
 * Admin sign-in at `/admin`. Authenticates with Cognito, then routes by group:
 * SystemAdmin → the admin console, any other authenticated user → /forbidden.
 */
export default function AdminLoginPage() {
  return (
    <LoginCard
      icon={<ShieldCheck size={18} />}
      brandText="CanPlan Admin"
      subtitle="Sign in to the administration portal."
      footnote="Authorized administrators only."
      redirectFor={({ isSystemAdmin }) => (isSystemAdmin ? '/admin/home' : '/forbidden')}
    />
  );
}
