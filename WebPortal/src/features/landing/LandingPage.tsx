import { Link } from 'react-router-dom';
import { ArrowRight, LifeBuoy, ShieldCheck } from 'lucide-react';
import styles from './LandingPage.module.css';

interface PortalLink {
  to: string;
  icon: typeof ShieldCheck;
  title: string;
  description: string;
}

const PORTALS: PortalLink[] = [
  {
    to: '/admin',
    icon: ShieldCheck,
    title: 'Administrator',
    description: 'Manage users, tasks, and organizations across the platform.',
  },
  {
    to: '/support',
    icon: LifeBuoy,
    title: 'Support Person',
    description: 'Sign in to support the primary users you are linked to.',
  },
];

/**
 * Public portal landing at `/`. A neutral entry page that routes visitors to the
 * sign-in for their role (admin or support person).
 */
export default function LandingPage() {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <h1 className={styles.title}>CanPlan 2.0 Portal</h1>
          <p className={styles.subtitle}>Choose how you would like to sign in.</p>
        </header>
        <div className={styles.grid}>
          {PORTALS.map(({ to, icon: Icon, title, description }) => (
            <Link key={to} to={to} className={styles.card}>
              <span className={styles.cardIcon} aria-hidden="true">
                <Icon size={22} />
              </span>
              <span className={styles.cardBody}>
                <span className={styles.cardTitle}>{title}</span>
                <span className={styles.cardDescription}>{description}</span>
              </span>
              <ArrowRight className={styles.cardArrow} size={18} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
