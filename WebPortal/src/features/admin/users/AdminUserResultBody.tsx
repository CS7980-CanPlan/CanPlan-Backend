import type { AdminUserResult } from '../../../api/apiTypes';
import { GroupBadges, RoleBadge } from '../components/display';

/** Readable summary of an AdminUserResult payload (used by the user mutation panels). */
export function AdminUserResultBody({ result }: { result: AdminUserResult }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '0.25rem 0.75rem',
        margin: '0.4rem 0 0',
        fontSize: '0.8125rem',
        alignItems: 'center',
      }}
    >
      <dt style={{ fontWeight: 600 }}>User id</dt>
      <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.78rem', wordBreak: 'break-all' }}>
        {result.userId}
      </dd>
      <dt style={{ fontWeight: 600 }}>Email</dt>
      <dd style={{ margin: 0 }}>{result.email ?? '—'}</dd>
      <dt style={{ fontWeight: 600 }}>Groups</dt>
      <dd style={{ margin: 0 }}>
        <GroupBadges groups={result.groups} />
      </dd>
      <dt style={{ fontWeight: 600 }}>Profile role</dt>
      <dd style={{ margin: 0 }}>
        {result.profile ? <RoleBadge role={result.profile.role} /> : '— (no profile yet)'}
      </dd>
    </dl>
  );
}
