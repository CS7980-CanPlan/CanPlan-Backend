import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { Connection } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose transact-item mock helpers

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

function event(
  fieldName: string,
  args: Record<string, unknown>,
  identity?: { sub?: string; groups?: string[] | null; claims?: Record<string, unknown> },
) {
  return { arguments: args, info: { fieldName }, identity } as Parameters<typeof handler>[0];
}

// A signed-in caller: Cognito sub + group membership + email claim.
const caller = (groups: string[], sub = 'cognito-sub-1', email = 'me@example.com') => ({
  sub,
  groups,
  claims: { email },
});

const lastInput = () => mockSend.mock.calls[0][0].input;

// createUserProfile reads the existing profile first, then (first-time) writes the profile
// + its default category atomically. Pull the Put items out of the TransactWrite the handler
// made (non-Put items, e.g. an org ConditionCheck, carry no `Put.Item` and are skipped).
const txRaw = (callIndex: number) => mockSend.mock.calls[callIndex][0].input.TransactItems;
const txItemsAt = (callIndex: number) =>
  txRaw(callIndex)
    .map((t: { Put?: { Item?: Record<string, unknown> } }) => t.Put?.Item)
    .filter(Boolean);
const profileItemAt = (callIndex = 1) =>
  txItemsAt(callIndex).find((i: Record<string, unknown>) => i.SK === '#PROFILE');
const categoryItemAt = (callIndex = 1) =>
  txItemsAt(callIndex).find((i: Record<string, unknown>) => String(i.SK).startsWith('CATEGORY#'));
// The OrganizationMember Put item written alongside a profile that sets organizationId.
const memberItemAt = (callIndex: number) =>
  txItemsAt(callIndex).find((i: Record<string, unknown>) => String(i.SK).startsWith('MEMBER#'));

describe('users handler — UserProfile', () => {
  /** An existing, non-deleting Organization row (the assertUsableOrganization GET). */
  const orgItem = (organizationId = 'org-1') => ({
    Item: { organizationId, name: 'Acme', createdAt: 'c', updatedAt: 'u' },
  });

  it('createUserProfile derives userId from the Cognito sub, role from group, email from the claim', async () => {
    // organizationId references a real org now: the first call is the org existence check.
    mockSend.mockResolvedValueOnce(orgItem('org-1'));
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-123', 'sam@example.com'),
      ),
    );
    // calls: [0] org GET, [1] getProfile, [2] TransactWrite.
    const profile = profileItemAt(2);
    expect(profile.PK).toBe('USER#sub-123');
    expect(profile.SK).toBe('#PROFILE');
    expect(profile.entityType).toBe('UserProfile');
    // userId comes from the Cognito sub, never the input.
    expect(profile.userId).toBe('sub-123');
    expect(profile.role).toBe('PRIMARY_USER');
    expect(profile.email).toBe('sam@example.com');
    expect(profile.displayName).toBe('Sam');
    expect(profile.organizationId).toBe('org-1');
    expect(typeof profile.defaultCategoryId).toBe('string');
    // The transaction ATOMICALLY re-checks the org still exists + isn't deleting.
    const orgCheck = txRaw(2).find((t: Rec) => t.ConditionCheck);
    expect(orgCheck.ConditionCheck.Key).toEqual({ PK: 'ORG#org-1', SK: '#META' });
    expect(orgCheck.ConditionCheck.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(deleting)',
    );
    // …and writes the strongly-consistent OrganizationMember row in the SAME transaction.
    const member = memberItemAt(2);
    expect(member.PK).toBe('ORG#org-1');
    expect(member.SK).toBe('MEMBER#sub-123');
    expect(member.entityType).toBe('OrganizationMember');
    expect(member.organizationId).toBe('org-1');
    expect(member.userId).toBe('sub-123');
  });

  it('createUserProfile without an organizationId includes NO org ConditionCheck', async () => {
    await handler(
      event('createUserProfile', { input: { displayName: 'Sam' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    // calls: [0] getProfile, [1] TransactWrite (profile + category only — no org check, no member).
    expect(txRaw(1).some((t: Rec) => t.ConditionCheck)).toBe(false);
    expect(memberItemAt(1)).toBeUndefined();
    expect(txRaw(1)).toHaveLength(2);
  });

  it('createUserProfile surfaces a clear error when the org is deleted mid-transaction (race)', async () => {
    // Pre-read passes, but the transaction's org ConditionCheck (index 2) is canceled.
    mockSend
      .mockResolvedValueOnce(orgItem('org-1')) // pre-read: org exists
      .mockResolvedValueOnce({}) // getProfile: none yet
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        }),
      );
    await expect(
      handler(
        event('createUserProfile', { input: { displayName: 'Sam', organizationId: 'org-1' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow('organization org-1 is no longer available');
  });

  it('createUserProfile re-call setting an org uses a transaction with an org ConditionCheck (putProfile path)', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-1')) // resolveCreateOrganization pre-read
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', defaultCategoryId: 'def-1', createdAt: 'orig' } }) // getProfile (existing)
      .mockResolvedValueOnce({ Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' } }); // default category validation
    await handler(
      event('createUserProfile', { input: { displayName: 'Sam', organizationId: 'org-1' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    // calls: [0] org pre-read, [1] getProfile, [2] default-category validation, [3] the putProfile write.
    const tx = mockSend.mock.calls[3][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    expect(items.find((t: Rec) => t.Put?.Item?.SK === '#PROFILE')).toBeTruthy();
    const orgCheck = items.find((t: Rec) => t.ConditionCheck).ConditionCheck;
    expect(orgCheck.Key).toEqual({ PK: 'ORG#org-1', SK: '#META' });
    expect(orgCheck.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(deleting)');
    // The membership row is written in the same putProfile transaction.
    const member = items.find((t: Rec) => String(t.Put?.Item?.SK).startsWith('MEMBER#')).Put.Item;
    expect(member.PK).toBe('ORG#org-1');
    expect(member.SK).toBe('MEMBER#sub-1');
    expect(member.entityType).toBe('OrganizationMember');
  });

  it('createUserProfile re-call MOVING orgs deletes the previous OrganizationMember row (putProfile path)', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-2')) // resolveCreateOrganization pre-read (new org)
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', defaultCategoryId: 'def-1', createdAt: 'orig', organizationId: 'org-1' } }) // existing profile in org-1
      .mockResolvedValueOnce({ Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' } }); // default category validation
    await handler(
      event('createUserProfile', { input: { displayName: 'Sam', organizationId: 'org-2' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    // call[3] = putProfile TransactWrite.
    const items = mockSend.mock.calls[3][0].input.TransactItems;
    // New membership row for org-2 …
    const put = items.find((t: Rec) => String(t.Put?.Item?.SK).startsWith('MEMBER#')).Put.Item;
    expect(put.PK).toBe('ORG#org-2');
    expect(put.SK).toBe('MEMBER#sub-1');
    // … and the stale org-1 membership row is deleted.
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#org-1', SK: 'MEMBER#sub-1' });
  });

  it('createUserProfile re-call WITHOUT an org clears the profile org and deletes the old membership row (putProfile path)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', defaultCategoryId: 'def-1', createdAt: 'orig', organizationId: 'org-1' } }) // existing profile in org-1
      .mockResolvedValueOnce({ Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' } }); // default category validation
    await handler(
      event('createUserProfile', { input: { displayName: 'Sam' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    // No org input ⇒ no org pre-read. calls: [0] getProfile, [1] category validation, [2] putProfile write.
    const write = mockSend.mock.calls[2][0];
    expect(write.constructor.name).toBe('TransactWriteCommand');
    const items = write.input.TransactItems;
    // The profile is Put (org cleared) and the old membership row deleted — no org check, no member Put.
    expect(items.find((t: Rec) => t.Put?.Item?.SK === '#PROFILE')).toBeTruthy();
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#org-1', SK: 'MEMBER#sub-1' });
    expect(items.some((t: Rec) => t.ConditionCheck)).toBe(false);
    expect(items.some((t: Rec) => String(t.Put?.Item?.SK).startsWith('MEMBER#'))).toBe(false);
  });

  it('createUserProfile rejects a non-existent organizationId (NotFound), writing nothing', async () => {
    mockSend.mockResolvedValueOnce({}); // org GET → no Item
    await expect(
      handler(
        event('createUserProfile', { input: { displayName: 'Sam', organizationId: 'gone' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow('organization gone not found');
    // Only the org existence check ran — no profile/category write.
    expect(mockSend.mock.calls.some((c) => c[0].input.TransactItems)).toBe(false);
  });

  it('createUserProfile rejects a deleting organizationId (VALIDATION)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { organizationId: 'org-x', name: 'X', deleting: true, createdAt: 'c', updatedAt: 'u' },
    });
    await expect(
      handler(
        event('createUserProfile', { input: { displayName: 'Sam', organizationId: 'org-x' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow('being deleted');
  });

  it('createUserProfile rejects a blank organizationId before any read', async () => {
    await expect(
      handler(
        event('createUserProfile', { input: { displayName: 'Sam', organizationId: '   ' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow('organizationId cannot be empty');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile creates exactly one real default "No Category" atomically with the profile', async () => {
    const result = await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    expect(mockSend).toHaveBeenCalledTimes(2); // GET existing, then ONE TransactWrite
    const items = txItemsAt(1);
    expect(items).toHaveLength(2);
    const profile = profileItemAt();
    const category = categoryItemAt();
    expect(category.PK).toBe('USER#sub-1');
    expect(category.SK).toBe(`CATEGORY#${category.categoryId}`);
    expect(category.entityType).toBe('Category');
    expect(category.name).toBe('No Category');
    expect(category.color).toBe('#64748B');
    expect(category.isDefault).toBe(true);
    expect(category.taskCount).toBe(0);
    expect(category.ownerId).toBe('sub-1');
    // The profile stores the generated default category id.
    expect(profile.defaultCategoryId).toBe(category.categoryId);
    expect((result as { defaultCategoryId?: string }).defaultCategoryId).toBe(category.categoryId);
    // The category Put is guarded so a retry never writes a second default.
    const catPut = mockSend.mock.calls[1][0].input.TransactItems.find(
      (t: { Put: { Item: Record<string, unknown> } }) =>
        String(t.Put.Item.SK).startsWith('CATEGORY#'),
    );
    expect(catPut.Put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('createUserProfile re-call preserves the existing (validated) defaultCategoryId and creates no second category', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', defaultCategoryId: 'existing-def', createdAt: 'orig' } }) // GET profile
      .mockResolvedValueOnce({
        Item: { categoryId: 'existing-def', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }); // GET default category (validation)
    const result = await handler(
      event('createUserProfile', { input: { displayName: 'Sam 2' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    // The write is a plain Put (no transaction / no new category), preserving id + createdAt.
    const write = mockSend.mock.calls[2][0];
    expect(write.input.TransactItems).toBeUndefined();
    expect(write.input.Item.defaultCategoryId).toBe('existing-def');
    expect(write.input.Item.createdAt).toBe('orig');
    expect((result as { defaultCategoryId?: string }).defaultCategoryId).toBe('existing-def');
    // No TransactWrite anywhere → no duplicate default category.
    expect(mockSend.mock.calls.some((c) => c[0].input.TransactItems)).toBe(false);
  });

  it('createUserProfile rejects a profile whose defaultCategoryId points at an invalid row', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', defaultCategoryId: 'bad' } }) // GET profile
      .mockResolvedValueOnce({}); // GET category → missing
    await expect(
      handler(event('createUserProfile', { input: { displayName: 'Sam' } }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('run the category migration to repair it');
  });

  it('createUserProfile reuses the existing default when a concurrent first call wins the race', async () => {
    // First GET: no profile yet → first-time create path. The TransactWrite is canceled
    // because a concurrent call already created the profile. We reread and reuse its default.
    const conflict = Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' });
    mockSend
      .mockResolvedValueOnce({}) // GET profile → none
      .mockRejectedValueOnce(conflict) // TransactWrite → conflict
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', defaultCategoryId: 'winner-def', createdAt: 'w' } }) // reread
      .mockResolvedValueOnce({
        Item: { categoryId: 'winner-def', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }) // validate default
      .mockResolvedValueOnce({}); // putProfile

    const result = await handler(
      event('createUserProfile', { input: { displayName: 'Sam' } }, caller(['PrimaryUser'], 'sub-1')),
    );

    expect((result as { defaultCategoryId?: string }).defaultCategoryId).toBe('winner-def');
    // Exactly one TransactWrite was attempted (the one that lost); no second default minted.
    expect(mockSend.mock.calls.filter((c) => c[0].input.TransactItems)).toHaveLength(1);
    const finalWrite = mockSend.mock.calls[4][0];
    expect(finalWrite.input.Item.defaultCategoryId).toBe('winner-def');
  });

  it('createUserProfile maps SupportPerson → SUPPORT_PERSON and OrganizationAdmin → ORG_ADMIN', async () => {
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Supporter' } },
        caller(['SupportPerson']),
      ),
    );
    expect(profileItemAt(1).role).toBe('SUPPORT_PERSON');

    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Organization admin' } },
        caller(['OrganizationAdmin']),
      ),
    );
    // Second handler call: GET at index 2, TransactWrite at index 3.
    expect(profileItemAt(3).role).toBe('ORG_ADMIN');
  });

  it('createUserProfile requires a non-empty displayName', async () => {
    await expect(
      handler(
        event('createUserProfile', { input: { displayName: '   ' } }, caller(['PrimaryUser'])),
      ),
    ).rejects.toThrow('displayName is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile ignores any client-supplied id/email/role — only identity is trusted', async () => {
    await handler(
      event(
        'createUserProfile',
        // Attacker tries to inject another user's id/email/role; these fields are not
        // part of the input type and must be ignored entirely.
        {
          input: {
            displayName: 'My profile',
            userId: 'victim',
            email: 'victim@evil.com',
            role: 'ORG_ADMIN',
          } as Record<string, unknown>,
        },
        caller(['PrimaryUser'], 'sub-me', 'me@example.com'),
      ),
    );
    const profile = profileItemAt();
    expect(profile.userId).toBe('sub-me'); // not 'victim'
    expect(profile.email).toBe('me@example.com'); // not 'victim@evil.com'
    expect(profile.role).toBe('PRIMARY_USER'); // not the injected ORG_ADMIN
  });

  it('createUserProfile rejects an unauthenticated caller (no sub)', async () => {
    await expect(handler(event('createUserProfile', { input: {} }, undefined))).rejects.toThrow(
      'authenticated user is required',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile rejects a caller with no base-role group', async () => {
    await expect(
      handler(event('createUserProfile', { input: {} }, caller(['SystemAdmin']))),
    ).rejects.toThrow(/exactly one base-role/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('createUserProfile rejects a caller with multiple base-role groups', async () => {
    await expect(
      handler(
        event('createUserProfile', { input: {} }, caller(['PrimaryUser', 'OrganizationAdmin'])),
      ),
    ).rejects.toThrow(/multiple base-role/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('getUserProfile reads PK=USER#<id>, SK=#PROFILE and returns null when absent', async () => {
    mockSend.mockResolvedValueOnce({}); // no Item
    const result = await handler(event('getUserProfile', { userId: 'u1' }));
    expect(lastInput().Key).toEqual({ PK: 'USER#u1', SK: '#PROFILE' });
    expect(result).toBeNull();
  });

});

describe('users handler — updateMyUserProfile', () => {
  // The stored row a conditional UpdateCommand returns via ReturnValues: ALL_NEW.
  const storedProfile = (overrides: Record<string, unknown> = {}) => ({
    PK: 'USER#sub-1',
    SK: '#PROFILE',
    entityType: 'UserProfile',
    userId: 'sub-1',
    role: 'PRIMARY_USER',
    email: 'me@example.com',
    organizationId: 'org-1',
    defaultCategoryId: 'def-1',
    displayName: 'Old name',
    createdAt: 'orig-created',
    updatedAt: 'orig-updated',
    ...overrides,
  });

  it('updates only displayName (trimmed), leaving accessibilitySettings untouched', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: storedProfile({ displayName: 'New name' }),
    });
    const result = (await handler(
      event('updateMyUserProfile', { input: { displayName: '  New name  ' } }, caller(['PrimaryUser'], 'sub-1')),
    )) as unknown as Record<string, unknown>;

    const cmd = lastInput();
    expect(cmd.Key).toEqual({ PK: 'USER#sub-1', SK: '#PROFILE' });
    expect(cmd.ConditionExpression).toBe('attribute_exists(PK)');
    // displayName set (trimmed), settings not referenced at all.
    expect(cmd.UpdateExpression).toContain('displayName = :displayName');
    expect(cmd.UpdateExpression).not.toContain('accessibilitySettings');
    expect(cmd.ExpressionAttributeValues[':displayName']).toBe('New name');
    // Returned row is stripped of internal storage attributes.
    expect(result.PK).toBeUndefined();
    expect(result.SK).toBeUndefined();
    expect(result.entityType).toBeUndefined();
    expect(result.displayName).toBe('New name');
  });

  it('updates only accessibilitySettings, fully replacing the stored value (no merge)', async () => {
    const settings = { fontScale: 1.5, highContrast: true };
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ accessibilitySettings: settings }) });
    await handler(
      event('updateMyUserProfile', { input: { accessibilitySettings: settings } }, caller(['PrimaryUser'], 'sub-1')),
    );

    const cmd = lastInput();
    expect(cmd.UpdateExpression).toContain('accessibilitySettings = :settings');
    expect(cmd.UpdateExpression).not.toContain('displayName');
    // The entire value is written as-is — no deep-merge expression.
    expect(cmd.ExpressionAttributeValues[':settings']).toEqual(settings);
  });

  it('clears accessibilitySettings with an explicit null (REMOVE)', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile() });
    await handler(
      event('updateMyUserProfile', { input: { accessibilitySettings: null } }, caller(['PrimaryUser'], 'sub-1')),
    );

    const cmd = lastInput();
    expect(cmd.UpdateExpression).toContain('REMOVE accessibilitySettings');
    expect(cmd.ExpressionAttributeValues[':settings']).toBeUndefined();
  });

  it('leaves omitted fields unchanged — only updatedAt + the supplied field are written', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ displayName: 'Just name' }) });
    await handler(
      event('updateMyUserProfile', { input: { displayName: 'Just name' } }, caller(['PrimaryUser'], 'sub-1')),
    );

    const cmd = lastInput();
    // SET updatedAt + displayName; nothing else, no REMOVE clause.
    expect(cmd.UpdateExpression).toBe('SET updatedAt = :now, displayName = :displayName');
    expect(Object.keys(cmd.ExpressionAttributeValues).sort()).toEqual([':displayName', ':now']);
  });

  it('rejects an empty input (no editable field supplied)', async () => {
    await expect(
      handler(event('updateMyUserProfile', { input: {} }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('at least one of displayName, accessibilitySettings, or organizationId');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only displayName', async () => {
    await expect(
      handler(
        event('updateMyUserProfile', { input: { displayName: '   ' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow('displayName cannot be empty');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an explicit null displayName (empty)', async () => {
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { displayName: null } as Record<string, unknown> },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('displayName cannot be empty');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns NotFound when the profile does not exist (conditional check fails, never creates)', async () => {
    const condFail = Object.assign(new Error('conditional'), {
      name: 'ConditionalCheckFailedException',
    });
    mockSend.mockRejectedValueOnce(condFail);
    await expect(
      handler(
        event('updateMyUserProfile', { input: { displayName: 'New' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow(/not found/);
    // It is an UpdateCommand guarded so it can never create a row.
    expect(lastInput().ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('rejects an unauthenticated caller (no sub)', async () => {
    await expect(
      handler(event('updateMyUserProfile', { input: { displayName: 'New' } }, undefined)),
    ).rejects.toThrow('authenticated user is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('derives the caller from the Cognito sub — never a client-supplied userId', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile() });
    await handler(
      event(
        'updateMyUserProfile',
        { input: { displayName: 'New', userId: 'victim' } as Record<string, unknown> },
        caller(['PrimaryUser'], 'sub-me'),
      ),
    );
    expect(lastInput().Key).toEqual({ PK: 'USER#sub-me', SK: '#PROFILE' });
  });

  it('never changes role, email, defaultCategoryId, or createdAt', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ displayName: 'New name' }) });
    await handler(
      event(
        'updateMyUserProfile',
        {
          // An attacker tries to slip protected fields into the input — they are not part
          // of the input type and must never appear in the write expression. (organizationId
          // IS editable now and is covered separately below.)
          input: {
            displayName: 'New name',
            role: 'ORG_ADMIN',
            email: 'evil@example.com',
            defaultCategoryId: 'evil-cat',
            createdAt: 'evil-time',
          } as Record<string, unknown>,
        },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );

    const cmd = lastInput();
    // Only updatedAt + displayName are written; no protected field appears.
    expect(cmd.UpdateExpression).toBe('SET updatedAt = :now, displayName = :displayName');
    for (const field of ['role', 'email', 'defaultCategoryId', 'createdAt']) {
      expect(cmd.UpdateExpression).not.toContain(field);
      expect(cmd.ExpressionAttributeValues[`:${field}`]).toBeUndefined();
    }
  });

  it('sets organizationId via a transaction (profile update + org check + member put), reading first + back', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' } }) // assertUsableOrganization
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // profile pre-read (no current org)
      .mockResolvedValueOnce({}) // TransactWrite (returns no attributes)
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-2' }) }); // getProfile read-back
    const result = (await handler(
      event('updateMyUserProfile', { input: { organizationId: '  org-2  ' } }, caller(['PrimaryUser'], 'sub-1')),
    )) as unknown as Record<string, unknown>;

    // calls: [0] org GET, [1] profile pre-read, [2] TransactWrite, [3] read-back GET.
    const tx = mockSend.mock.calls[2][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    const update = items.find((t: Rec) => t.Update).Update;
    expect(update.Key).toEqual({ PK: 'USER#sub-1', SK: '#PROFILE' });
    expect(update.UpdateExpression).toBe('SET updatedAt = :now, organizationId = :organizationId');
    expect(update.ExpressionAttributeValues[':organizationId']).toBe('org-2'); // trimmed
    expect(update.ConditionExpression).toBe('attribute_exists(PK)');
    // The org existence/not-deleting check rides in the SAME transaction (item index 1).
    const orgCheck = items.find((t: Rec) => t.ConditionCheck).ConditionCheck;
    expect(orgCheck.Key).toEqual({ PK: 'ORG#org-2', SK: '#META' });
    expect(orgCheck.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(deleting)');
    // …as does the new OrganizationMember row.
    const member = items.find((t: Rec) => t.Put).Put.Item;
    expect(member.PK).toBe('ORG#org-2');
    expect(member.SK).toBe('MEMBER#sub-1');
    expect(member.entityType).toBe('OrganizationMember');
    // No previous org → no membership Delete.
    expect(items.some((t: Rec) => t.Delete)).toBe(false);
    // The returned profile is the read-back, stripped of storage attributes.
    expect(result.organizationId).toBe('org-2');
    expect(result.PK).toBeUndefined();
  });

  it('moving organizations deletes the previous OrganizationMember row in the same transaction', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' } }) // assertUsableOrganization
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-1' }) }) // pre-read: currently in org-1
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-2' }) }); // read-back
    await handler(
      event('updateMyUserProfile', { input: { organizationId: 'org-2' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    const items = mockSend.mock.calls[2][0].input.TransactItems;
    // New membership row for org-2 is put …
    const put = items.find((t: Rec) => t.Put).Put.Item;
    expect(put.PK).toBe('ORG#org-2');
    expect(put.SK).toBe('MEMBER#sub-1');
    // … and the stale org-1 membership row is deleted.
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#org-1', SK: 'MEMBER#sub-1' });
  });

  it('rejects setting organizationId to a non-existent org (NotFound), writing nothing', async () => {
    mockSend.mockResolvedValueOnce({}); // assertUsableOrganization GET → no Item
    await expect(
      handler(event('updateMyUserProfile', { input: { organizationId: 'gone' } }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('organization gone not found');
    // Fails at the org existence check — no profile read, no write of any kind.
    expect(
      mockSend.mock.calls.some((c) =>
        ['UpdateCommand', 'TransactWriteCommand'].includes(c[0].constructor.name),
      ),
    ).toBe(false);
  });

  it('rejects setting organizationId to a deleting org (VALIDATION)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { organizationId: 'org-x', name: 'X', deleting: true, createdAt: 'c', updatedAt: 'u' },
    });
    await expect(
      handler(event('updateMyUserProfile', { input: { organizationId: 'org-x' } }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('being deleted');
    expect(
      mockSend.mock.calls.some((c) =>
        ['UpdateCommand', 'TransactWriteCommand'].includes(c[0].constructor.name),
      ),
    ).toBe(false);
  });

  it('surfaces a clear error when the org is deleted mid-transaction (race)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' } }) // org GET
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // profile pre-read
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          // index 0 = profile update (ok), index 1 = org ConditionCheck (failed), index 2 = member put.
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      );
    await expect(
      handler(event('updateMyUserProfile', { input: { organizationId: 'org-2' } }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('organization org-2 is no longer available');
  });

  it('maps a canceled profile update (missing profile) to NotFound when setting an org', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' } }) // org GET
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // profile pre-read (exists)
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          // Profile Update's attribute_exists(PK) failed (index 0); the org check held.
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
        }),
      );
    await expect(
      handler(event('updateMyUserProfile', { input: { organizationId: 'org-2' } }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('profile for user sub-1 not found');
  });

  it('returns NotFound when the profile is missing at the pre-read (setting an org), writing nothing', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' } }) // org GET
      .mockResolvedValueOnce({}); // profile pre-read → no Item
    await expect(
      handler(event('updateMyUserProfile', { input: { organizationId: 'org-2' } }, caller(['PrimaryUser'], 'sub-1'))),
    ).rejects.toThrow('profile for user sub-1 not found');
    expect(mockSend.mock.calls.some((c) => c[0].constructor.name === 'TransactWriteCommand')).toBe(false);
  });

  it('clears organizationId when the caller had none → a plain UpdateCommand (no transaction)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // pre-read: no current org
      .mockResolvedValueOnce({ Attributes: storedProfile({ organizationId: undefined }) }); // UpdateCommand ALL_NEW
    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: null } as Record<string, unknown> },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    // calls: [0] pre-read GET, [1] the plain conditional UpdateCommand (nothing to detach).
    const cmd = mockSend.mock.calls[1][0];
    expect(cmd.constructor.name).toBe('UpdateCommand');
    expect(cmd.input.UpdateExpression).toContain('REMOVE organizationId');
    expect(cmd.input.ExpressionAttributeValues[':organizationId']).toBeUndefined();
    expect(mockSend.mock.calls.some((c) => c[0].constructor.name === 'TransactWriteCommand')).toBe(false);
  });

  it('clears organizationId (caller was a member) via a transaction that deletes the OrganizationMember row', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-1' }) }) // pre-read: currently in org-1
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }); // read-back
    const result = (await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: null } as Record<string, unknown> },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    )) as unknown as Record<string, unknown>;
    // calls: [0] pre-read GET, [1] TransactWrite, [2] read-back GET.
    const tx = mockSend.mock.calls[1][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    const update = items.find((t: Rec) => t.Update).Update;
    expect(update.UpdateExpression).toContain('REMOVE organizationId');
    expect(update.ConditionExpression).toBe('attribute_exists(PK)');
    // The old membership row is deleted; clearing needs neither an org check nor a member Put.
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#org-1', SK: 'MEMBER#sub-1' });
    expect(items.some((t: Rec) => t.ConditionCheck)).toBe(false);
    expect(items.some((t: Rec) => t.Put)).toBe(false);
    expect(result.PK).toBeUndefined();
  });

  it('leaves organizationId unchanged when the key is omitted', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ displayName: 'X' }) });
    await handler(
      event('updateMyUserProfile', { input: { displayName: 'X' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    expect(lastInput().UpdateExpression).not.toContain('organizationId');
  });

  it('rejects a whitespace-only organizationId (use null to clear)', async () => {
    await expect(
      handler(
        event('updateMyUserProfile', { input: { organizationId: '   ' } }, caller(['PrimaryUser'], 'sub-1')),
      ),
    ).rejects.toThrow('organizationId cannot be empty');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('users handler — listMyOrganizationUsers', () => {
  it('reads the caller org from their profile, then queries orgIndex by THAT org', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', organizationId: 'org-1' } }) // caller profile
      .mockResolvedValueOnce({ Items: [{ userId: 'u2', role: 'PRIMARY_USER' }] }); // orgIndex query
    const result = (await handler(
      event('listMyOrganizationUsers', {}, caller(['SupportPerson'], 'sub-1')),
    )) as Connection<unknown>;
    // First call = caller profile GET; second = orgIndex query scoped to the caller's own org.
    const query = mockSend.mock.calls[1][0].input;
    expect(query.IndexName).toBe('orgIndex');
    expect(query.ExpressionAttributeValues).toEqual({ ':org': 'org-1', ':profileSk': '#PROFILE' });
    // OrganizationMember rows co-tenant orgIndex; the filter keeps the roster to UserProfile rows.
    expect(query.FilterExpression).toBe('SK = :profileSk');
    expect(result.items).toHaveLength(1);
  });

  it('rejects when the caller has no current organization', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: 'sub-1' } }); // no organizationId
    await expect(
      handler(event('listMyOrganizationUsers', {}, caller(['SupportPerson'], 'sub-1'))),
    ).rejects.toThrow('no current organization');
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(handler(event('listMyOrganizationUsers', {}, undefined))).rejects.toThrow(
      'authenticated user is required',
    );
  });
});

describe('users handler — selectPrimaryUser / unselectPrimaryUser', () => {
  const SP = 'support-1';
  const PU = 'primary-1';
  // selectPrimaryUser reads, in order: [0] supporter profile, [1] target profile, then (only
  // if all checks pass) [2] the upsert. Queue EXACTLY the reads each path consumes so an
  // unconsumed mockResolvedValueOnce never leaks into the next test.
  const profileReads = (
    supporter: Record<string, unknown> | undefined,
    target: Record<string, unknown> | undefined,
  ) => {
    mockSend.mockResolvedValueOnce({ Item: supporter }).mockResolvedValueOnce({ Item: target });
  };

  it('a SupportPerson selects an in-org PRIMARY_USER → writes the link ACTIVE (supporter from identity)', async () => {
    profileReads(
      { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-1' },
    );
    mockSend.mockResolvedValueOnce({
      Attributes: {
        PK: `SUPPORTER#${SP}`,
        SK: `USER#${PU}`,
        entityType: 'SupportLink',
        supporterId: SP,
        primaryUserId: PU,
        userId: PU,
        status: 'ACTIVE',
        createdAt: 'c',
        updatedAt: 'u',
      },
    });
    const result = (await handler(
      event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
    )) as { status: string; supporterId: string };

    const upsert = mockSend.mock.calls[2][0].input;
    expect(upsert.Key).toEqual({ PK: `SUPPORTER#${SP}`, SK: `USER#${PU}` });
    expect(upsert.ExpressionAttributeValues[':active']).toBe('ACTIVE');
    expect(upsert.ExpressionAttributeValues[':supporterId']).toBe(SP); // derived from identity
    // createdAt preserved on restore (if_not_exists) so a REVOKED→ACTIVE keeps the original.
    expect(upsert.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
    expect(result.status).toBe('ACTIVE');
    // The returned link is stripped of storage attributes.
    expect((result as Record<string, unknown>).PK).toBeUndefined();
  });

  it('rejects selecting a user outside the caller current organization', async () => {
    profileReads(
      { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-2' }, // different org
    );
    await expect(
      handler(event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP))),
    ).rejects.toThrow('not in your organization');
  });

  it('rejects selecting a non-PRIMARY_USER target', async () => {
    profileReads(
      { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
      { userId: PU, role: 'SUPPORT_PERSON', organizationId: 'org-1' },
    );
    await expect(
      handler(event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP))),
    ).rejects.toThrow('not a primary user');
  });

  it('rejects when the caller has no organization', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: SP, role: 'SUPPORT_PERSON' } }); // no org
    await expect(
      handler(event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP))),
    ).rejects.toThrow('must belong to an organization');
  });

  it('a PRIMARY_USER cannot select (only a SupportPerson may)', async () => {
    await expect(
      handler(event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['PrimaryUser'], 'p9'))),
    ).rejects.toThrow('SupportPerson access required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('unselectPrimaryUser soft-revokes the link (status REVOKED, never a delete)', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: { supporterId: SP, primaryUserId: PU, userId: PU, status: 'REVOKED' },
    });
    const result = (await handler(
      event('unselectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
    )) as { status: string };
    const cmd = lastInput();
    expect(cmd.Key).toEqual({ PK: `SUPPORTER#${SP}`, SK: `USER#${PU}` });
    expect(cmd.UpdateExpression).toContain('#status = :revoked');
    expect(cmd.ExpressionAttributeValues[':revoked']).toBe('REVOKED');
    // Conditioned on the link existing — never an upsert/create.
    expect(cmd.ConditionExpression).toBe('attribute_exists(PK)');
    expect(result.status).toBe('REVOKED');
  });

  it('a PRIMARY_USER cannot unselect', async () => {
    await expect(
      handler(event('unselectPrimaryUser', { input: { primaryUserId: PU } }, caller(['PrimaryUser'], 'p9'))),
    ).rejects.toThrow('SupportPerson access required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('unselectPrimaryUser 404s when no link exists', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(
      handler(event('unselectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP))),
    ).rejects.toThrow('no support link');
  });
});

describe('users handler — createSupportLink (deprecated alias)', () => {
  const SP = 'support-1';
  const PU = 'primary-1';

  it('ignores a client-supplied supporterId, deriving the supporter from identity, and writes ACTIVE', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: SP, role: 'SUPPORT_PERSON', organizationId: 'org-1' } })
      .mockResolvedValueOnce({ Item: { userId: PU, role: 'PRIMARY_USER', organizationId: 'org-1' } })
      .mockResolvedValueOnce({ Attributes: { supporterId: SP, primaryUserId: PU, status: 'ACTIVE' } });
    const result = (await handler(
      event(
        'createSupportLink',
        // Attacker tries to set supporterId to a victim; it must be ignored.
        { input: { supporterId: 'victim', primaryUserId: PU, status: 'PENDING' } },
        caller(['SupportPerson'], SP),
      ),
    )) as { supporterId: string; status: string };
    const upsert = mockSend.mock.calls[2][0].input;
    expect(upsert.Key).toEqual({ PK: `SUPPORTER#${SP}`, SK: `USER#${PU}` }); // NOT victim
    expect(upsert.ExpressionAttributeValues[':supporterId']).toBe(SP);
    expect(upsert.ExpressionAttributeValues[':active']).toBe('ACTIVE'); // client status ignored
    expect(result.status).toBe('ACTIVE');
  });
});

describe('users handler — support list queries', () => {
  it('listMySupportList queries supporterIndex by the caller sub (identity-derived)', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ supporterId: 'support-1', userId: 'primary-1' }] });
    const result = (await handler(
      event('listMySupportList', {}, caller(['SupportPerson'], 'support-1')),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('supporterIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':sup': 'support-1' });
    expect(result.items).toHaveLength(1);
  });

  it('listPrimaryUsersBySupporter allows the caller to list their OWN support list', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ supporterId: 'support-1', userId: 'primary-1' }] });
    const result = (await handler(
      event('listPrimaryUsersBySupporter', { supporterId: 'support-1' }, caller(['SupportPerson'], 'support-1')),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('supporterIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':sup': 'support-1' });
    expect(result.items).toHaveLength(1);
  });

  it('listPrimaryUsersBySupporter rejects listing another supporter list (no arbitrary supporterId)', async () => {
    await expect(
      handler(
        event('listPrimaryUsersBySupporter', { supporterId: 'someone-else' }, caller(['SupportPerson'], 'support-1')),
      ),
    ).rejects.toThrow('only list your own support list');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('users handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
