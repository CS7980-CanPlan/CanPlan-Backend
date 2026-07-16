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
      event(
        'createUserProfile',
        { input: { displayName: 'Sam' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        }),
      );
    await expect(
      handler(
        event(
          'createUserProfile',
          { input: { displayName: 'Sam', organizationId: 'org-1' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('organization org-1 is no longer available');
  });

  it('createUserProfile re-call setting an org uses a transaction with an org ConditionCheck (putProfile path)', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-1')) // resolveCreateOrganization pre-read
      .mockResolvedValueOnce({
        Item: { userId: 'sub-1', defaultCategoryId: 'def-1', createdAt: 'orig' },
      }) // getProfile (existing)
      .mockResolvedValueOnce({
        Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }); // default category validation
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    // calls: [0] org pre-read, [1] getProfile, [2] default-category validation, [3] the putProfile write.
    const tx = mockSend.mock.calls[3][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    expect(items.find((t: Rec) => t.Put?.Item?.SK === '#PROFILE')).toBeTruthy();
    const orgCheck = items.find((t: Rec) => t.ConditionCheck).ConditionCheck;
    expect(orgCheck.Key).toEqual({ PK: 'ORG#org-1', SK: '#META' });
    expect(orgCheck.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(deleting)',
    );
    // The membership row is written in the same putProfile transaction.
    const member = items.find((t: Rec) => String(t.Put?.Item?.SK).startsWith('MEMBER#')).Put.Item;
    expect(member.PK).toBe('ORG#org-1');
    expect(member.SK).toBe('MEMBER#sub-1');
    expect(member.entityType).toBe('OrganizationMember');
  });

  it('createUserProfile re-call MOVING orgs deletes the previous OrganizationMember row (putProfile path)', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-2')) // resolveCreateOrganization pre-read (new org)
      .mockResolvedValueOnce({
        Item: {
          userId: 'sub-1',
          defaultCategoryId: 'def-1',
          createdAt: 'orig',
          organizationId: 'org-1',
        },
      }) // existing profile in org-1
      .mockResolvedValueOnce({
        Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }); // default category validation
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-2' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
      .mockResolvedValueOnce({
        Item: {
          userId: 'sub-1',
          defaultCategoryId: 'def-1',
          createdAt: 'orig',
          organizationId: 'org-1',
        },
      }) // existing profile in org-1
      .mockResolvedValueOnce({
        Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }); // default category validation
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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

  it('createUserProfile re-call with the SAME org carries the existing membership id forward (no rotation, no revocation)', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-1')) // resolveCreateOrganization pre-read
      .mockResolvedValueOnce({
        Item: {
          userId: 'sub-1',
          defaultCategoryId: 'def-1',
          createdAt: 'orig',
          organizationId: 'org-1',
          organizationMembershipId: 'mid-keep',
        },
      }) // existing profile: same org, session already present
      .mockResolvedValueOnce({
        Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }); // default category validation
    const result = (await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    )) as unknown as Record<string, unknown>;
    // calls: [0] org pre-read, [1] getProfile, [2] category validation, [3] the putProfile write.
    const items = mockSend.mock.calls[3][0].input.TransactItems;
    const put = items.find((t: Rec) => t.Put?.Item?.SK === '#PROFILE').Put;
    // The stored membership session is preserved — a same-org re-create is NOT a rejoin.
    expect(put.Item.organizationMembershipId).toBe('mid-keep');
    // Bound to the pre-read org so a concurrent change aborts instead of mixing sessions.
    expect(put.ConditionExpression).toBe(
      'organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId',
    );
    expect(put.ExpressionAttributeValues[':prevOrg']).toBe('org-1');
    expect(put.ExpressionAttributeValues[':prevMembershipId']).toBe('mid-keep');
    expect(result.organizationMembershipId).toBe('mid-keep');
    // Unchanged org ⇒ no ensure Update and no revocation sweep: exactly 4 calls.
    expect(mockSend.mock.calls).toHaveLength(4);
  });

  it('createUserProfile re-call with the same org on a LEGACY profile lazily initializes the membership id first', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-1')) // resolveCreateOrganization pre-read
      .mockResolvedValueOnce({
        Item: {
          userId: 'sub-1',
          defaultCategoryId: 'def-1',
          createdAt: 'orig',
          organizationId: 'org-1',
        },
      }) // existing profile: same org, NO membership id (legacy)
      .mockResolvedValueOnce({
        Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }) // default category validation
      .mockResolvedValueOnce({
        Attributes: {
          userId: 'sub-1',
          organizationId: 'org-1',
          organizationMembershipId: 'mid-won',
        },
      }); // ensureOrganizationMembershipId → the authoritative stored winner
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    // calls: [0] org, [1] getProfile, [2] category, [3] if-absent init, [4] putProfile write.
    const init = mockSend.mock.calls[3][0];
    expect(init.constructor.name).toBe('UpdateCommand');
    expect(init.input.UpdateExpression).toBe(
      'SET organizationMembershipId = if_not_exists(organizationMembershipId, :fresh)',
    );
    // The Put carries the STORED winner, preserving organizationId (lazy init ≠ org change).
    const items = mockSend.mock.calls[4][0].input.TransactItems;
    const put = items.find((t: Rec) => t.Put?.Item?.SK === '#PROFILE').Put;
    expect(put.Item.organizationMembershipId).toBe('mid-won');
    expect(put.Item.organizationId).toBe('org-1');
    // The separate lazy-init write already stored mid-won, so the full Put must guard against
    // that authoritative winner (not against the pre-initialization absence).
    expect(put.ConditionExpression).toBe(
      'organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId',
    );
    expect(put.ExpressionAttributeValues[':prevMembershipId']).toBe('mid-won');
    // Unchanged org ⇒ no revocation sweep queries.
    expect(
      mockSend.mock.calls.filter((c) => c[0].constructor.name === 'QueryCommand'),
    ).toHaveLength(0);
  });

  it('createUserProfile re-call MOVING orgs mints a fresh membership id and runs the revocation sweep', async () => {
    mockSend
      .mockResolvedValueOnce(orgItem('org-2')) // resolveCreateOrganization pre-read (new org)
      .mockResolvedValueOnce({
        Item: {
          userId: 'sub-1',
          defaultCategoryId: 'def-1',
          createdAt: 'orig',
          organizationId: 'org-1',
          organizationMembershipId: 'mid-old',
        },
      }) // existing profile in org-1
      .mockResolvedValueOnce({
        Item: { categoryId: 'def-1', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }); // default category validation
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-2' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    // call[3] = putProfile TransactWrite: fresh session id, old membership row deleted.
    const items = mockSend.mock.calls[3][0].input.TransactItems;
    const put = items.find((t: Rec) => t.Put?.Item?.SK === '#PROFILE').Put;
    expect(put.Item.organizationMembershipId).toBeTruthy();
    expect(put.Item.organizationMembershipId).not.toBe('mid-old');
    // Moving IS an org change → the revocation sweep queried both directions after the write.
    expect(
      mockSend.mock.calls.filter((c) => c[0].constructor.name === 'QueryCommand'),
    ).toHaveLength(2);
  });

  it('createUserProfile rejects a non-existent organizationId (NotFound), writing nothing', async () => {
    mockSend.mockResolvedValueOnce({}); // org GET → no Item
    await expect(
      handler(
        event(
          'createUserProfile',
          { input: { displayName: 'Sam', organizationId: 'gone' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
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
        event(
          'createUserProfile',
          { input: { displayName: 'Sam', organizationId: 'org-x' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('being deleted');
  });

  it('createUserProfile rejects a blank organizationId before any read', async () => {
    await expect(
      handler(
        event(
          'createUserProfile',
          { input: { displayName: 'Sam', organizationId: '   ' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
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
      .mockResolvedValueOnce({
        Item: { userId: 'sub-1', defaultCategoryId: 'existing-def', createdAt: 'orig' },
      }) // GET profile
      .mockResolvedValueOnce({
        Item: {
          categoryId: 'existing-def',
          ownerId: 'sub-1',
          isDefault: true,
          name: 'No Category',
        },
      }); // GET default category (validation)
    const result = await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam 2' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
      handler(
        event(
          'createUserProfile',
          { input: { displayName: 'Sam' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('run the category migration to repair it');
  });

  it('createUserProfile reuses the existing default when a concurrent first call wins the race', async () => {
    // First GET: no profile yet → first-time create path. The TransactWrite is canceled
    // because a concurrent call already created the profile. We reread and reuse its default.
    const conflict = Object.assign(new Error('canceled'), { name: 'TransactionCanceledException' });
    mockSend
      .mockResolvedValueOnce({}) // GET profile → none
      .mockRejectedValueOnce(conflict) // TransactWrite → conflict
      .mockResolvedValueOnce({
        Item: { userId: 'sub-1', defaultCategoryId: 'winner-def', createdAt: 'w' },
      }) // reread
      .mockResolvedValueOnce({
        Item: { categoryId: 'winner-def', ownerId: 'sub-1', isDefault: true, name: 'No Category' },
      }) // validate default
      .mockResolvedValueOnce({}); // putProfile

    const result = await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
      event(
        'updateMyUserProfile',
        { input: { displayName: '  New name  ' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
    mockSend.mockResolvedValueOnce({
      Attributes: storedProfile({ accessibilitySettings: settings }),
    });
    await handler(
      event(
        'updateMyUserProfile',
        { input: { accessibilitySettings: settings } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
      event(
        'updateMyUserProfile',
        { input: { accessibilitySettings: null } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );

    const cmd = lastInput();
    expect(cmd.UpdateExpression).toContain('REMOVE accessibilitySettings');
    expect(cmd.ExpressionAttributeValues[':settings']).toBeUndefined();
  });

  it('leaves omitted fields unchanged — only updatedAt + the supplied field are written', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ displayName: 'Just name' }) });
    await handler(
      event(
        'updateMyUserProfile',
        { input: { displayName: 'Just name' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
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
        event(
          'updateMyUserProfile',
          { input: { displayName: '   ' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
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
        event(
          'updateMyUserProfile',
          { input: { displayName: 'New' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
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

  it('sets organizationId via a transaction (profile update + org check + member put), minting a membership session', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsableOrganization
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // profile pre-read (no current org)
      .mockResolvedValueOnce({}) // TransactWrite (returns no attributes)
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-2' }) }); // getProfile read-back
    const result = (await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: '  org-2  ' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    )) as unknown as Record<string, unknown>;

    // calls: [0] org GET, [1] profile pre-read, [2] TransactWrite, [3] read-back GET,
    // [4..5] the SupportLink revocation sweep (joining from none IS an org change).
    const tx = mockSend.mock.calls[2][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    const update = items.find((t: Rec) => t.Update).Update;
    expect(update.Key).toEqual({ PK: 'USER#sub-1', SK: '#PROFILE' });
    // Joining from no org mints a fresh internal membership session id in the same write.
    expect(update.UpdateExpression).toBe(
      'SET updatedAt = :now, organizationId = :organizationId, organizationMembershipId = :membershipId',
    );
    expect(update.ExpressionAttributeValues[':organizationId']).toBe('org-2'); // trimmed
    expect(typeof update.ExpressionAttributeValues[':membershipId']).toBe('string');
    // The write is bound to the org seen at pre-read (none) — a concurrent join aborts it.
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(organizationId)',
    );
    // The org existence/not-deleting check rides in the SAME transaction (item index 1).
    const orgCheck = items.find((t: Rec) => t.ConditionCheck).ConditionCheck;
    expect(orgCheck.Key).toEqual({ PK: 'ORG#org-2', SK: '#META' });
    expect(orgCheck.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(deleting)',
    );
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

  it('moving organizations rotates the membership session and deletes the previous OrganizationMember row', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsableOrganization
      .mockResolvedValueOnce({
        Item: storedProfile({ organizationId: 'org-1', organizationMembershipId: 'mid-old' }),
      }) // pre-read: in org-1
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-2' }) }); // read-back
    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: 'org-2' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    const items = mockSend.mock.calls[2][0].input.TransactItems;
    const update = items.find((t: Rec) => t.Update).Update;
    // A real move mints a FRESH membership id (never reuses the old session) …
    expect(update.UpdateExpression).toContain('organizationMembershipId = :membershipId');
    expect(update.ExpressionAttributeValues[':membershipId']).not.toBe('mid-old');
    // … bound to the org seen at pre-read.
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId',
    );
    expect(update.ExpressionAttributeValues[':prevOrg']).toBe('org-1');
    expect(update.ExpressionAttributeValues[':prevMembershipId']).toBe('mid-old');
    // New membership row for org-2 is put …
    const put = items.find((t: Rec) => t.Put).Put.Item;
    expect(put.PK).toBe('ORG#org-2');
    expect(put.SK).toBe('MEMBER#sub-1');
    // … and the stale org-1 membership row is deleted.
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#org-1', SK: 'MEMBER#sub-1' });
    // Moving IS an org change → the revocation sweep queried both link directions.
    const sweeps = mockSend.mock.calls.slice(4).map((c) => c[0]);
    expect(sweeps.filter((c: Rec) => c.constructor.name === 'QueryCommand')).toHaveLength(2);
  });

  it('re-setting the SAME organizationId keeps the membership session (if-absent init) and revokes nothing', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-1', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsableOrganization
      .mockResolvedValueOnce({
        Item: storedProfile({ organizationId: 'org-1', organizationMembershipId: 'mid-keep' }),
      }) // pre-read: same org
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-1' }) }); // read-back
    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    const update = mockSend.mock.calls[2][0].input.TransactItems.find((t: Rec) => t.Update).Update;
    // Same org ⇒ NOT a leave-and-rejoin: the stored id is kept via if_not_exists, never rotated.
    expect(update.UpdateExpression).toContain(
      'organizationMembershipId = if_not_exists(organizationMembershipId, :membershipId)',
    );
    expect(update.ExpressionAttributeValues[':membershipId']).toBe('mid-keep');
    // No org change ⇒ NO revocation sweep ran (nothing after the read-back).
    expect(mockSend.mock.calls).toHaveLength(4);
  });

  it('re-setting the same org on a LEGACY profile (no membership id) initializes it lazily without revoking', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-1', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsableOrganization
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-1' }) }) // pre-read: same org, NO membership id
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-1' }) }); // read-back
    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    const update = mockSend.mock.calls[2][0].input.TransactItems.find((t: Rec) => t.Update).Update;
    // Lazy init: if_not_exists with a fresh id — concurrent initializers converge on one value.
    expect(update.UpdateExpression).toContain(
      'organizationMembershipId = if_not_exists(organizationMembershipId, :membershipId)',
    );
    expect(typeof update.ExpressionAttributeValues[':membershipId']).toBe('string');
    // Unchanged org ⇒ no revocation sweep.
    expect(mockSend.mock.calls).toHaveLength(4);
  });

  it('leaving an organization soft-revokes every ACTIVE SupportLink in BOTH directions', async () => {
    const linkUpdates: Rec[] = [];
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand') {
        return Promise.resolve({
          Item: storedProfile({ organizationId: 'org-1', organizationMembershipId: 'mid-1' }),
        });
      }
      if (name === 'QueryCommand') {
        // Outgoing canonical links and incoming reverse pointers are both base-table queries.
        const isIncoming = cmd.input.ExpressionAttributeValues?.[':prefix'] === 'INCOMING_SUPPORT#';
        return Promise.resolve({
          Items: isIncoming
            ? [{ supporterId: 'other-sp' }]
            : [{ PK: 'SUPPORTER#sub-1', SK: 'USER#p1' }],
        });
      }
      if (name === 'TransactWriteCommand') {
        const linkUpdate = cmd.input.TransactItems.map((item: Rec) => item.Update).find(
          (update: Rec | undefined) => String(update?.Key?.PK).startsWith('SUPPORTER#'),
        );
        if (linkUpdate) linkUpdates.push(linkUpdate);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: null } as Record<string, unknown> },
        caller(['SupportPerson'], 'sub-1'),
      ),
    );

    // Both directions were revoked with the machine-readable reason; createdAt untouched.
    expect(linkUpdates.map((u) => u.Key)).toEqual([
      { PK: 'SUPPORTER#sub-1', SK: 'USER#p1' },
      { PK: 'SUPPORTER#other-sp', SK: 'USER#sub-1' },
    ]);
    for (const u of linkUpdates) {
      expect(u.UpdateExpression).toBe(
        'SET #status = :revoked, revokedReason = :reason, updatedAt = :now',
      );
      expect(u.ConditionExpression).toBe('attribute_exists(PK) AND #status = :active');
      expect(u.ExpressionAttributeValues[':reason']).toBe('ORG_MEMBERSHIP_CHANGED');
    }
  });

  it('moving organizations passes the FRESH membership id to the sweep so a link re-selected under it survives', async () => {
    const linkUpdates: Rec[] = [];
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand') {
        // org pre-read + profile pre-read + read-back all satisfied by shape-compatible items.
        return Promise.resolve({
          Item: {
            ...storedProfile({ organizationId: 'org-1', organizationMembershipId: 'mid-old' }),
            name: 'Acme', // lets the same Item satisfy assertUsableOrganization
          },
        });
      }
      if (name === 'QueryCommand') {
        return Promise.resolve({ Items: [{ PK: 'SUPPORTER#sub-1', SK: 'USER#p1' }] });
      }
      if (name === 'TransactWriteCommand') {
        const linkUpdate = cmd.input.TransactItems.map((item: Rec) => item.Update).find(
          (update: Rec | undefined) => String(update?.Key?.PK).startsWith('SUPPORTER#'),
        );
        if (linkUpdate) linkUpdates.push(linkUpdate);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: 'org-2' } },
        caller(['SupportPerson'], 'sub-1'),
      ),
    );

    const txUpdate = mockSend.mock.calls
      .map((c) => c[0])
      .find((c: Rec) => c.constructor.name === 'TransactWriteCommand')
      .input.TransactItems.find((t: Rec) => t.Update).Update;
    const freshMid = txUpdate.ExpressionAttributeValues[':membershipId'];
    // The sweep only revokes links NOT selected under the fresh session.
    for (const u of linkUpdates) {
      expect(u.ConditionExpression).toContain('<> :currentMid');
      expect(u.ExpressionAttributeValues[':currentMid']).toBe(freshMid);
    }
    expect(linkUpdates.length).toBeGreaterThan(0);
  });

  it('maps a concurrent org change (guard failure with the profile still present) to a retryable conflict', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // org GET
      .mockResolvedValueOnce({
        Item: storedProfile({ organizationId: 'org-1', organizationMembershipId: 'm1' }),
      }) // pre-read
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          // Item 0 = the guarded profile update: its organizationId = :prevOrg guard failed.
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      )
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: 'org-9' }) }); // guard-failure re-read: profile still exists
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: 'org-2' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('changed concurrently');
  });

  it('rejects setting organizationId to a non-existent org (NotFound), writing nothing', async () => {
    mockSend.mockResolvedValueOnce({}); // assertUsableOrganization GET → no Item
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: 'gone' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
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
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: 'org-x' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('being deleted');
    expect(
      mockSend.mock.calls.some((c) =>
        ['UpdateCommand', 'TransactWriteCommand'].includes(c[0].constructor.name),
      ),
    ).toBe(false);
  });

  it('surfaces a clear error when the org is deleted mid-transaction (race)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // org GET
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // profile pre-read
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          // index 0 = profile update (ok), index 1 = org ConditionCheck (failed), index 2 = member put.
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }),
      );
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: 'org-2' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('organization org-2 is no longer available');
  });

  it('maps a canceled profile update (missing profile) to NotFound when setting an org', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // org GET
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }) // profile pre-read (exists)
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          // Profile Update's attribute_exists(PK) failed (index 0); the org check held.
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      );
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: 'org-2' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('profile for user sub-1 not found');
  });

  it('returns NotFound when the profile is missing at the pre-read (setting an org), writing nothing', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'org-2', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // org GET
      .mockResolvedValueOnce({}); // profile pre-read → no Item
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: 'org-2' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
      ),
    ).rejects.toThrow('profile for user sub-1 not found');
    expect(mockSend.mock.calls.some((c) => c[0].constructor.name === 'TransactWriteCommand')).toBe(
      false,
    );
  });

  it('clears organizationId when the caller had none → a plain UpdateCommand (no transaction, no revocation)', async () => {
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
    expect(cmd.input.UpdateExpression).toContain('REMOVE organizationId, organizationMembershipId');
    expect(cmd.input.ExpressionAttributeValues[':organizationId']).toBeUndefined();
    expect(mockSend.mock.calls.some((c) => c[0].constructor.name === 'TransactWriteCommand')).toBe(
      false,
    );
    // No org change ⇒ no revocation sweep queries either.
    expect(mockSend.mock.calls).toHaveLength(2);
  });

  it('clears organizationId (caller was a member) via a transaction that drops the membership row + session', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: storedProfile({ organizationId: 'org-1', organizationMembershipId: 'mid-1' }),
      }) // pre-read
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({ Item: storedProfile({ organizationId: undefined }) }); // read-back
    const result = (await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: null } as Record<string, unknown> },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    )) as unknown as Record<string, unknown>;
    // calls: [0] pre-read GET, [1] TransactWrite, [2] read-back GET, [3..4] revocation sweep.
    const tx = mockSend.mock.calls[1][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    const update = items.find((t: Rec) => t.Update).Update;
    // Leaving removes BOTH the org and the internal membership session.
    expect(update.UpdateExpression).toContain('REMOVE organizationId, organizationMembershipId');
    // The write is bound to the org seen at pre-read.
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId',
    );
    expect(update.ExpressionAttributeValues[':prevOrg']).toBe('org-1');
    expect(update.ExpressionAttributeValues[':prevMembershipId']).toBe('mid-1');
    // The old membership row is deleted; clearing needs neither an org check nor a member Put.
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#org-1', SK: 'MEMBER#sub-1' });
    expect(items.some((t: Rec) => t.ConditionCheck)).toBe(false);
    expect(items.some((t: Rec) => t.Put)).toBe(false);
    expect(result.PK).toBeUndefined();
    // Leaving IS an org change → the revocation sweep queried both link directions.
    const sweeps = mockSend.mock.calls.slice(3).map((c) => c[0]);
    expect(sweeps.filter((c: Rec) => c.constructor.name === 'QueryCommand')).toHaveLength(2);
  });

  it('leaves organizationId unchanged when the key is omitted', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ displayName: 'X' }) });
    await handler(
      event(
        'updateMyUserProfile',
        { input: { displayName: 'X' } },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    expect(lastInput().UpdateExpression).not.toContain('organizationId');
  });

  it('rejects a whitespace-only organizationId (use null to clear)', async () => {
    await expect(
      handler(
        event(
          'updateMyUserProfile',
          { input: { organizationId: '   ' } },
          caller(['PrimaryUser'], 'sub-1'),
        ),
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
  // if all checks pass) the condition-checked transaction and a read-back of the stored link.
  // Queue EXACTLY the reads each path consumes so an unconsumed mockResolvedValueOnce never
  // leaks into the next test.
  const profileReads = (
    supporter: Record<string, unknown> | undefined,
    target: Record<string, unknown> | undefined,
  ) => {
    mockSend.mockResolvedValueOnce({ Item: supporter }).mockResolvedValueOnce({ Item: target });
  };
  const supporterProfile = (overrides: Rec = {}) => ({
    userId: SP,
    role: 'SUPPORT_PERSON',
    organizationId: 'org-1',
    organizationMembershipId: 'mid-sp',
    ...overrides,
  });
  const targetProfile = (overrides: Rec = {}) => ({
    userId: PU,
    role: 'PRIMARY_USER',
    organizationId: 'org-1',
    organizationMembershipId: 'mid-pu',
    ...overrides,
  });
  const storedLink = (overrides: Rec = {}) => ({
    PK: `SUPPORTER#${SP}`,
    SK: `USER#${PU}`,
    entityType: 'SupportLink',
    supporterId: SP,
    primaryUserId: PU,
    userId: PU,
    status: 'ACTIVE',
    organizationId: 'org-1',
    supporterOrganizationMembershipId: 'mid-sp',
    primaryUserOrganizationMembershipId: 'mid-pu',
    createdAt: 'c',
    updatedAt: 'u',
    ...overrides,
  });

  it('writes the link ACTIVE in a transaction that condition-checks BOTH live profiles and snapshots the membership', async () => {
    profileReads(supporterProfile(), targetProfile());
    mockSend.mockResolvedValueOnce({}); // TransactWrite
    mockSend.mockResolvedValueOnce({ Item: storedLink() }); // read the stored link back
    const result = (await handler(
      event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
    )) as { status: string; supporterId: string };

    // calls: [0] supporter GET, [1] target GET, [2] TransactWrite, [3] link read-back GET.
    const tx = mockSend.mock.calls[2][0];
    expect(tx.constructor.name).toBe('TransactWriteCommand');
    const items = tx.input.TransactItems;
    expect(items).toHaveLength(4);

    // [0] The supporter must still be in the expected org under the expected session …
    const supporterCheck = items[0].ConditionCheck;
    expect(supporterCheck.Key).toEqual({ PK: `USER#${SP}`, SK: '#PROFILE' });
    expect(supporterCheck.ConditionExpression).toBe(
      'attribute_exists(PK) AND organizationId = :org AND organizationMembershipId = :mid',
    );
    expect(supporterCheck.ExpressionAttributeValues).toEqual({ ':org': 'org-1', ':mid': 'mid-sp' });
    // [1] … and the target must still be a PRIMARY_USER in that org under ITS session.
    const targetCheck = items[1].ConditionCheck;
    expect(targetCheck.Key).toEqual({ PK: `USER#${PU}`, SK: '#PROFILE' });
    expect(targetCheck.ConditionExpression).toBe(
      'attribute_exists(PK) AND #role = :primaryRole AND organizationId = :org AND organizationMembershipId = :mid',
    );
    expect(targetCheck.ExpressionAttributeValues).toEqual({
      ':primaryRole': 'PRIMARY_USER',
      ':org': 'org-1',
      ':mid': 'mid-pu',
    });

    // [2] The link upsert stores the org + BOTH membership ids (the selection snapshot),
    // clears any old revocation reason, and preserves createdAt on a restore.
    const upsert = items[2].Update;
    expect(upsert.Key).toEqual({ PK: `SUPPORTER#${SP}`, SK: `USER#${PU}` });
    expect(upsert.ExpressionAttributeValues[':active']).toBe('ACTIVE');
    expect(upsert.ExpressionAttributeValues[':supporterId']).toBe(SP); // derived from identity
    expect(upsert.ExpressionAttributeValues[':org']).toBe('org-1');
    expect(upsert.ExpressionAttributeValues[':supporterMid']).toBe('mid-sp');
    expect(upsert.ExpressionAttributeValues[':primaryMid']).toBe('mid-pu');
    expect(upsert.UpdateExpression).toContain('organizationId = :org');
    expect(upsert.UpdateExpression).toContain('supporterOrganizationMembershipId = :supporterMid');
    expect(upsert.UpdateExpression).toContain('primaryUserOrganizationMembershipId = :primaryMid');
    expect(upsert.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
    expect(upsert.UpdateExpression).toContain('REMOVE revokedReason');

    // [3] The reverse pointer commits atomically with the canonical link, so target-side
    // revocation uses a strongly-consistent base-table query rather than an eventual GSI.
    expect(items[3].Put.Item).toEqual({
      PK: `USER#${PU}`,
      SK: `INCOMING_SUPPORT#${SP}`,
      supporterId: SP,
      primaryUserId: PU,
    });

    expect(result.status).toBe('ACTIVE');
    // The returned link is the stored row, stripped of storage attributes.
    expect((result as Record<string, unknown>).PK).toBeUndefined();
  });

  it('restores exactly the selected REVOKED link — an idempotent upsert on the SAME key (no new row)', async () => {
    profileReads(supporterProfile(), targetProfile());
    mockSend.mockResolvedValueOnce({}); // TransactWrite (restores in place)
    mockSend.mockResolvedValueOnce({ Item: storedLink() }); // read-back: ACTIVE again
    const result = (await handler(
      event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
    )) as { status: string };
    const upsert = mockSend.mock.calls[2][0].input.TransactItems[2].Update;
    // The upsert targets the one existing (supporter, primaryUser) key — restoring that exact
    // link — and if_not_exists(createdAt) keeps the original creation time.
    expect(upsert.Key).toEqual({ PK: `SUPPORTER#${SP}`, SK: `USER#${PU}` });
    expect(result.status).toBe('ACTIVE');
  });

  it("lazily initializes a LEGACY profile's missing membership id (if-absent) and snapshots the STORED winner", async () => {
    profileReads(supporterProfile({ organizationMembershipId: undefined }), targetProfile());
    // ensureOrganizationMembershipId: the stored (authoritative) id comes back.
    mockSend.mockResolvedValueOnce({
      Attributes: { userId: SP, organizationId: 'org-1', organizationMembershipId: 'mid-sp-init' },
    });
    mockSend.mockResolvedValueOnce({}); // TransactWrite
    mockSend.mockResolvedValueOnce({
      Item: storedLink({ supporterOrganizationMembershipId: 'mid-sp-init' }),
    });
    await handler(
      event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
    );

    // calls: [0] supporter GET, [1] target GET, [2] lazy init Update, [3] TransactWrite, [4] read-back.
    const init = mockSend.mock.calls[2][0];
    expect(init.constructor.name).toBe('UpdateCommand');
    expect(init.input.Key).toEqual({ PK: `USER#${SP}`, SK: '#PROFILE' });
    // if-absent init: preserves organizationId, never rotates an existing id.
    expect(init.input.UpdateExpression).toBe(
      'SET organizationMembershipId = if_not_exists(organizationMembershipId, :fresh)',
    );
    expect(init.input.ConditionExpression).toBe('attribute_exists(PK) AND organizationId = :org');
    // The transaction snapshots the AUTHORITATIVE stored id, not a locally-minted one.
    const items = mockSend.mock.calls[3][0].input.TransactItems;
    expect(items[0].ConditionCheck.ExpressionAttributeValues[':mid']).toBe('mid-sp-init');
    expect(items[2].Update.ExpressionAttributeValues[':supporterMid']).toBe('mid-sp-init');
  });

  it("fails with a clear retryable error when the TARGET's org membership changes mid-selection (no stale activation)", async () => {
    profileReads(supporterProfile(), targetProfile());
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('canceled'), {
        name: 'TransactionCanceledException',
        // Item 1 = the target profile's ConditionCheck failed: they left/moved concurrently.
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ],
      }),
    );
    await expect(
      handler(
        event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
      ),
    ).rejects.toThrow(/organization membership changed while selecting/);
  });

  it("fails with a clear retryable error when the CALLER's org membership changes mid-selection", async () => {
    profileReads(supporterProfile(), targetProfile());
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('canceled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );
    await expect(
      handler(
        event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
      ),
    ).rejects.toThrow(/your organization membership changed while selecting/);
  });

  it('rejects selecting a user outside the caller current organization', async () => {
    profileReads(supporterProfile(), targetProfile({ organizationId: 'org-2' }));
    await expect(
      handler(
        event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
      ),
    ).rejects.toThrow('not in your organization');
  });

  it('rejects selecting a non-PRIMARY_USER target', async () => {
    profileReads(supporterProfile(), targetProfile({ role: 'SUPPORT_PERSON' }));
    await expect(
      handler(
        event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
      ),
    ).rejects.toThrow('not a primary user');
  });

  it('rejects when the caller has no organization', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: SP, role: 'SUPPORT_PERSON' } }); // no org
    await expect(
      handler(
        event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
      ),
    ).rejects.toThrow('must belong to an organization');
  });

  it('a PRIMARY_USER cannot select (only a SupportPerson may activate or restore a link)', async () => {
    await expect(
      handler(
        event('selectPrimaryUser', { input: { primaryUserId: PU } }, caller(['PrimaryUser'], 'p9')),
      ),
    ).rejects.toThrow('SupportPerson access required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('unselectPrimaryUser soft-revokes the link (status REVOKED + reason UNSELECTED, never a delete)', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: { supporterId: SP, primaryUserId: PU, userId: PU, status: 'REVOKED' },
    });
    const result = (await handler(
      event('unselectPrimaryUser', { input: { primaryUserId: PU } }, caller(['SupportPerson'], SP)),
    )) as { status: string };
    const cmd = lastInput();
    expect(cmd.Key).toEqual({ PK: `SUPPORTER#${SP}`, SK: `USER#${PU}` });
    expect(cmd.UpdateExpression).toContain('#status = :revoked');
    expect(cmd.UpdateExpression).toContain('revokedReason = :reason');
    expect(cmd.ExpressionAttributeValues[':revoked']).toBe('REVOKED');
    expect(cmd.ExpressionAttributeValues[':reason']).toBe('UNSELECTED');
    // Conditioned on the link existing — never an upsert/create.
    expect(cmd.ConditionExpression).toBe('attribute_exists(PK)');
    expect(result.status).toBe('REVOKED');
  });

  it('a PRIMARY_USER cannot unselect', async () => {
    await expect(
      handler(
        event(
          'unselectPrimaryUser',
          { input: { primaryUserId: PU } },
          caller(['PrimaryUser'], 'p9'),
        ),
      ),
    ).rejects.toThrow('SupportPerson access required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('unselectPrimaryUser 404s when no link exists', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(
      handler(
        event(
          'unselectPrimaryUser',
          { input: { primaryUserId: PU } },
          caller(['SupportPerson'], SP),
        ),
      ),
    ).rejects.toThrow('no support link');
  });
});

describe('users handler — listMySupportList (currently effective relationships only)', () => {
  const SP = 'support-1';
  const callerProfile = (overrides: Rec = {}) => ({
    userId: SP,
    role: 'SUPPORT_PERSON',
    organizationId: 'org-1',
    organizationMembershipId: 'mid-sp',
    ...overrides,
  });
  const link = (primaryUserId: string, overrides: Rec = {}) => ({
    PK: `SUPPORTER#${SP}`,
    SK: `USER#${primaryUserId}`,
    supporterId: SP,
    primaryUserId,
    userId: primaryUserId,
    status: 'ACTIVE',
    organizationId: 'org-1',
    supporterOrganizationMembershipId: 'mid-sp',
    primaryUserOrganizationMembershipId: `mid-${primaryUserId}`,
    createdAt: 'c',
    ...overrides,
  });
  const profileRow = (userId: string, overrides: Rec = {}) => ({
    PK: `USER#${userId}`,
    SK: '#PROFILE',
    userId,
    role: 'PRIMARY_USER',
    organizationId: 'org-1',
    organizationMembershipId: `mid-${userId}`,
    ...overrides,
  });

  it('filters the caller side server-side and verifies each target via ONE BatchGet (no N+1)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: callerProfile() }) // caller profile
      .mockResolvedValueOnce({ Items: [link('p1'), link('p2')], LastEvaluatedKey: { k: 1 } }) // base-table link page
      .mockResolvedValueOnce({
        // BatchGet: p1 still matches; p2 rejoined the org under a NEW membership session.
        Responses: {
          'CanPlan-test': [
            profileRow('p1'),
            profileRow('p2', { organizationMembershipId: 'mid-p2-rejoined' }),
          ],
        },
      });
    const result = (await handler(
      event('listMySupportList', { limit: 2 }, caller(['SupportPerson'], SP)),
    )) as Connection<{ primaryUserId: string }>;

    // The caller's natural base-table partition is read consistently and pre-filters to
    // plausibly effective rows: ACTIVE + selected in the current org/session.
    const query = mockSend.mock.calls[1][0].input;
    expect(query.IndexName).toBeUndefined();
    expect(query.ConsistentRead).toBe(true);
    expect(query.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(query.FilterExpression).toBe(
      '#status = :active AND organizationId = :org AND supporterOrganizationMembershipId = :mid',
    );
    expect(query.ExpressionAttributeValues).toEqual({
      ':pk': `SUPPORTER#${SP}`,
      ':prefix': 'USER#',
      ':active': 'ACTIVE',
      ':org': 'org-1',
      ':mid': 'mid-sp',
    });
    expect(query.Limit).toBe(2);
    // The targets were loaded with a single BatchGet of their profile keys.
    const batch = mockSend.mock.calls[2][0];
    expect(batch.constructor.name).toBe('BatchGetCommand');
    expect(batch.input.RequestItems['CanPlan-test'].Keys).toEqual([
      { PK: 'USER#p1', SK: '#PROFILE' },
      { PK: 'USER#p2', SK: '#PROFILE' },
    ]);
    expect(batch.input.RequestItems['CanPlan-test'].ConsistentRead).toBe(true);
    // Only the still-matching relationship is a current supported user; pagination continues.
    expect(result.items.map((l) => l.primaryUserId)).toEqual(['p1']);
    expect(result.nextToken).not.toBeNull();
  });

  it('excludes targets that are no longer PRIMARY_USER or that left the organization', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: callerProfile() })
      .mockResolvedValueOnce({ Items: [link('p1'), link('p2'), link('p3')] })
      .mockResolvedValueOnce({
        Responses: {
          'CanPlan-test': [
            profileRow('p1', { role: 'SUPPORT_PERSON' }), // role changed → stale link
            profileRow('p2', { organizationId: 'org-9' }), // left the org
            // p3's profile is missing entirely (deleted user)
          ],
        },
      });
    const result = (await handler(
      event('listMySupportList', {}, caller(['SupportPerson'], SP)),
    )) as Connection<unknown>;
    expect(result.items).toEqual([]);
  });

  it('returns an empty list without querying links when the caller has no org or membership session', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: SP, role: 'SUPPORT_PERSON' } }); // no org
    const result = (await handler(
      event('listMySupportList', {}, caller(['SupportPerson'], SP)),
    )) as Connection<unknown>;
    expect(result).toEqual({ items: [], nextToken: null });
    expect(
      mockSend.mock.calls.filter((c) => c[0].constructor.name === 'QueryCommand'),
    ).toHaveLength(0);
  });

  it('rejects a PrimaryUser before reading a profile or any SupportLink rows', async () => {
    await expect(
      handler(event('listMySupportList', {}, caller(['PrimaryUser'], 'primary-1'))),
    ).rejects.toThrow('SupportPerson access required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps a valid nextToken when a page filters down to empty (callers can continue paging)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: callerProfile() })
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: { PK: 'SUPPORTER#support-1', SK: 'USER#p9' },
      });
    const result = (await handler(
      event('listMySupportList', { limit: 1 }, caller(['SupportPerson'], SP)),
    )) as Connection<unknown>;
    expect(result.items).toEqual([]);
    expect(result.nextToken).not.toBeNull();
  });
});

describe('users handler — listMySupportLinkHistory (history rows)', () => {
  it('returns the unfiltered, consistently read base-table rows — ACTIVE, REVOKED, and legacy links alike', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { supporterId: 'support-1', userId: 'p1', status: 'ACTIVE' },
        {
          supporterId: 'support-1',
          userId: 'p2',
          status: 'REVOKED',
          revokedReason: 'ORG_MEMBERSHIP_CHANGED',
        },
      ],
    });
    const result = (await handler(
      event('listMySupportLinkHistory', {}, caller(['SupportPerson'], 'support-1')),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBeUndefined();
    expect(lastInput().ConsistentRead).toBe(true);
    expect(lastInput().KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(lastInput().ExpressionAttributeValues).toEqual({
      ':pk': 'SUPPORTER#support-1',
      ':prefix': 'USER#',
    });
    expect(lastInput().FilterExpression).toBeUndefined();
    expect(result.items).toHaveLength(2);
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(handler(event('listMySupportLinkHistory', {}, undefined))).rejects.toThrow(
      'authenticated user is required',
    );
  });

  it('rejects a PrimaryUser because support-list history belongs to SupportPerson callers', async () => {
    await expect(
      handler(event('listMySupportLinkHistory', {}, caller(['PrimaryUser'], 'primary-1'))),
    ).rejects.toThrow('SupportPerson access required');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('users handler — organization directory (listAvailableOrganizations / getOrganization)', () => {
  const orgRow = (organizationId: string, overrides: Rec = {}) => ({
    PK: `ORG#${organizationId}`,
    SK: '#META',
    entityType: 'Organization',
    organizationId,
    name: `Org ${organizationId}`,
    createdAt: 'c',
    updatedAt: 'u',
    ...overrides,
  });

  it('a PrimaryUser lists available organizations via entityTypeIndex (no Scan), deleting excluded, fields stripped', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [orgRow('o1'), orgRow('o2')],
        LastEvaluatedKey: { k: 1 },
      })
      .mockResolvedValueOnce({
        Responses: {
          'CanPlan-test': [orgRow('o1'), orgRow('o2', { deleting: true })],
        },
      });
    const result = (await handler(
      event('listAvailableOrganizations', { limit: 2 }, caller(['PrimaryUser'], 'u1')),
    )) as unknown as Connection<Record<string, unknown>>;

    const query = lastInput();
    expect(query.IndexName).toBe('entityTypeIndex');
    expect(query.KeyConditionExpression).toBe('entityType = :et');
    expect(query.ExpressionAttributeValues).toEqual({ ':et': 'Organization' });
    // Orgs mid-deletion are not joinable and are filtered out server-side.
    expect(query.FilterExpression).toBe('attribute_not_exists(deleting)');
    // Deterministic ordering: newest-first, exactly like listAllOrganizations.
    expect(query.ScanIndexForward).toBe(false);
    expect(query.Limit).toBe(2);
    // An authoritative consistent BatchGet closes a stale-GSI deletion window. o2 was marked
    // deleting after the index page was produced, so it is excluded and storage fields stripped.
    const batch = mockSend.mock.calls[1][0].input.RequestItems['CanPlan-test'];
    expect(batch.ConsistentRead).toBe(true);
    expect(result.items).toEqual([
      { organizationId: 'o1', name: 'Org o1', createdAt: 'c', updatedAt: 'u' },
    ]);
    expect(result.nextToken).not.toBeNull();
  });

  it('a SupportPerson can list available organizations too', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [orgRow('o1')] })
      .mockResolvedValueOnce({ Responses: { 'CanPlan-test': [orgRow('o1')] } });
    const result = (await handler(
      event('listAvailableOrganizations', {}, caller(['SupportPerson'], 'sp1')),
    )) as Connection<unknown>;
    expect(result.items).toHaveLength(1);
  });

  it('rejects disallowed groups (OrganizationAdmin / bare SystemAdmin) in the Lambda, before any read', async () => {
    await expect(
      handler(event('listAvailableOrganizations', {}, caller(['OrganizationAdmin'], 'oa1'))),
    ).rejects.toThrow(/one of \[PrimaryUser, SupportPerson\] access required/);
    await expect(
      handler(event('listAvailableOrganizations', {}, caller(['SystemAdmin'], 'sa1'))),
    ).rejects.toThrow(/access required/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated / API-key callers (no Cognito groups at all)', async () => {
    await expect(handler(event('listAvailableOrganizations', {}, undefined))).rejects.toThrow(
      /access required/,
    );
    await expect(
      handler(event('getOrganization', { organizationId: 'o1' }, undefined)),
    ).rejects.toThrow(/access required/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a SystemAdmin who ALSO holds an allowed base role may use the directory', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    await expect(
      handler(
        event('listAvailableOrganizations', {}, caller(['SystemAdmin', 'SupportPerson'], 'sa2')),
      ),
    ).resolves.toEqual({ items: [], nextToken: null });
  });

  it('rejects an invalid nextToken like every other list API', async () => {
    await expect(
      handler(
        event(
          'listAvailableOrganizations',
          { nextToken: '%%%not-base64-json%%%' },
          caller(['PrimaryUser'], 'u1'),
        ),
      ),
    ).rejects.toThrow('invalid nextToken');
  });

  it('getOrganization trims the id, reads the base-table key, and strips internal fields', async () => {
    mockSend.mockResolvedValueOnce({ Item: orgRow('o1') });
    const result = (await handler(
      event('getOrganization', { organizationId: '  o1  ' }, caller(['PrimaryUser'], 'u1')),
    )) as unknown as Record<string, unknown>;
    expect(lastInput().Key).toEqual({ PK: 'ORG#o1', SK: '#META' });
    expect(result).toEqual({
      organizationId: 'o1',
      name: 'Org o1',
      createdAt: 'c',
      updatedAt: 'u',
    });
  });

  it('getOrganization works for a SupportPerson and returns null when the org does not exist', async () => {
    mockSend.mockResolvedValueOnce({}); // no Item
    await expect(
      handler(
        event('getOrganization', { organizationId: 'gone' }, caller(['SupportPerson'], 'sp1')),
      ),
    ).resolves.toBeNull();
  });

  it('getOrganization returns null for an org that is being deleted (not available to join)', async () => {
    mockSend.mockResolvedValueOnce({ Item: orgRow('o1', { deleting: true }) });
    await expect(
      handler(event('getOrganization', { organizationId: 'o1' }, caller(['PrimaryUser'], 'u1'))),
    ).resolves.toBeNull();
  });

  it('getOrganization rejects a blank organizationId', async () => {
    await expect(
      handler(event('getOrganization', { organizationId: '   ' }, caller(['PrimaryUser'], 'u1'))),
    ).rejects.toThrow('organizationId is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('getOrganization rejects disallowed groups in the Lambda', async () => {
    await expect(
      handler(
        event('getOrganization', { organizationId: 'o1' }, caller(['OrganizationAdmin'], 'oa1')),
      ),
    ).rejects.toThrow(/access required/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('users handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
