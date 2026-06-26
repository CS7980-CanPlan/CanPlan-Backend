import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Badge, type BadgeTone } from '../../../components/ui/Badge';
import type { UserRole } from '../../../api/apiTypes';
import styles from '../admin.module.css';

const ROLE_LABEL: Record<UserRole, string> = {
  PRIMARY_USER: 'Primary user',
  SUPPORT_PERSON: 'Support person',
  ORG_ADMIN: 'Org admin',
};

const ROLE_TONE: Record<UserRole, BadgeTone> = {
  PRIMARY_USER: 'neutral',
  SUPPORT_PERSON: 'info',
  ORG_ADMIN: 'warning',
};

/** Render a UserRole as a badge (or a muted dash when absent). */
export function RoleBadge({ role }: { role: UserRole | null | undefined }) {
  if (!role) return <span className={styles.cellMuted}>—</span>;
  return <Badge tone={ROLE_TONE[role]}>{ROLE_LABEL[role]}</Badge>;
}

/** Render a user's Cognito groups as badges (SystemAdmin highlighted). */
export function GroupBadges({ groups }: { groups: string[] }) {
  if (!groups.length) return <span className={styles.cellMuted}>—</span>;
  return (
    <span className={styles.groupCell}>
      {groups.map((group) => (
        <Badge key={group} tone={group === 'SystemAdmin' ? 'danger' : 'neutral'}>
          {group}
        </Badge>
      ))}
    </span>
  );
}

/** A monospace id cell with a copy-to-clipboard button (ids overflow gracefully). */
export function IdCell({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }
  return (
    <span className={styles.idCell} title={id}>
      <span className={styles.mono}>{id}</span>
      <button type="button" className={styles.copyBtn} onClick={copy} aria-label={`Copy ${id}`}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  );
}

/** Format an ISO timestamp compactly, or a dash when absent/invalid. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
