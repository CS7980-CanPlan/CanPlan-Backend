import { LifeBuoy } from 'lucide-react';
import { LoginCard } from '../login/LoginCard';

/**
 * Support-person sign-in at `/support`. Authenticates with Cognito, then routes by group:
 * SupportPerson → the support home, any other authenticated user → /forbidden.
 */
export default function SupportLoginPage() {
  return (
    <LoginCard
      icon={<LifeBuoy size={18} />}
      brandText="CanPlan Support"
      subtitle="Sign in to the support portal."
      footnote="For registered support persons."
      redirectFor={({ isSupportPerson }) => (isSupportPerson ? '/support/home' : '/forbidden')}
    />
  );
}
