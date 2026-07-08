import { UserMinus, UserPlus } from 'lucide-react';
import { useUserProfile } from '../../api/supportHooks';
import type { UserProfile } from '../../api/apiTypes';
import { Button } from '../../components/ui/Button';
import { RoleBadge } from '../admin/components/display';
import styles from './support.module.css';

/** First letter of a name/email for the avatar, uppercased (falls back to "?"). */
export function initialOf(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

/**
 * A supported primary user. `onOpen` makes the identity clickable (→ their detail page);
 * `onRemove` adds an un-select action. Its display name/email is looked up via getUserProfile
 * (the support list itself only carries ids).
 */
export function SupportedUserCard({
  userId,
  onOpen,
  onRemove,
  removing,
}: {
  userId: string;
  onOpen?: (userId: string) => void;
  onRemove?: (userId: string) => void;
  removing?: boolean;
}) {
  const profileQuery = useUserProfile(userId);
  const profile = profileQuery.data;
  const name = profile?.displayName || profile?.email || userId;

  const identity = (
    <>
      <span className={styles.userAvatar} aria-hidden="true">
        {initialOf(name)}
      </span>
      <span className={styles.userBody}>
        <span className={styles.userName}>{profileQuery.isLoading ? 'Loading…' : name}</span>
        <span className={styles.userMeta}>{profile?.email ?? userId}</span>
      </span>
    </>
  );

  return (
    <div className={styles.userCard}>
      {onOpen ? (
        <button type="button" className={styles.userMain} onClick={() => onOpen(userId)}>
          {identity}
        </button>
      ) : (
        <span className={styles.userIdentity}>{identity}</span>
      )}
      <div className={styles.userActions}>
        <RoleBadge role={profile?.role} />
        {onRemove && (
          <Button
            size="sm"
            variant="ghost"
            icon={<UserMinus size={14} />}
            loading={removing}
            onClick={() => onRemove(userId)}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

/** A roster primary user available to start supporting. */
export function RosterUserCard({
  user,
  onSelect,
  selecting,
}: {
  user: UserProfile;
  onSelect: (userId: string) => void;
  selecting?: boolean;
}) {
  const name = user.displayName || user.userId;
  return (
    <div className={styles.userCard}>
      <span className={styles.userIdentity}>
        <span className={styles.userAvatar} aria-hidden="true">
          {initialOf(name)}
        </span>
        <span className={styles.userBody}>
          <span className={styles.userName}>{name}</span>
          <span className={styles.userMeta}>Primary user</span>
        </span>
      </span>
      <div className={styles.userActions}>
        <Button
          size="sm"
          variant="secondary"
          icon={<UserPlus size={14} />}
          loading={selecting}
          onClick={() => onSelect(user.userId)}
        >
          Support
        </Button>
      </div>
    </div>
  );
}
