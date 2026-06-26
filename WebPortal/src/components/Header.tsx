import { NavLink } from 'react-router-dom';
import styles from './Header.module.css';

interface NavItem {
  label: string;
  to: string;
}

/**
 * Navigation items for the portal. Only the dashboard route is wired up for
 * the initial setup; the others are placeholders that resolve to "/" for now.
 */
const navItems: NavItem[] = [
  { label: 'Dashboard', to: '/' },
  { label: 'Users', to: '/' },
  { label: 'Tasks', to: '/' },
];

/** Persistent top navigation header shown on every page. */
export default function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <NavLink to="/" className={styles.brand} aria-label="CanPlan 2.0 Portal home">
          <img src="/favicon.svg" alt="" aria-hidden="true" className={styles.logo} />
          <span className={styles.brandText}>CanPlan 2.0 Portal</span>
        </NavLink>

        <nav aria-label="Primary">
          <ul className={styles.nav} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {navItems.map((item, index) => (
              <li key={`${item.label}-${index}`}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    isActive && item.label === 'Dashboard'
                      ? `${styles.navLink} ${styles.navLinkActive}`
                      : styles.navLink
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
