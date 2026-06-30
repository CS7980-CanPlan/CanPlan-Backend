import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { encodeNextToken } from '../../shared/pagination';
import type { Connection } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

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
// + its default category atomically. Pull items out of the TransactWrite the handler made.
const txItemsAt = (callIndex: number) =>
  mockSend.mock.calls[callIndex][0].input.TransactItems.map(
    (t: { Put: { Item: Record<string, unknown> } }) => t.Put.Item,
  );
const profileItemAt = (callIndex = 1) =>
  txItemsAt(callIndex).find((i: Record<string, unknown>) => i.SK === '#PROFILE');
const categoryItemAt = (callIndex = 1) =>
  txItemsAt(callIndex).find((i: Record<string, unknown>) => String(i.SK).startsWith('CATEGORY#'));

describe('users handler — UserProfile', () => {
  it('createUserProfile derives userId from the Cognito sub, role from group, email from the claim', async () => {
    await handler(
      event(
        'createUserProfile',
        { input: { displayName: 'Sam', organizationId: 'org-1' } },
        caller(['PrimaryUser'], 'sub-123', 'sam@example.com'),
      ),
    );
    const profile = profileItemAt();
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

  it('listUsersByOrganization (deprecated, self-scoped) lists the caller OWN org via orgIndex', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', organizationId: 'org-1' } }) // caller profile
      .mockResolvedValueOnce({ Items: [{ userId: 'u1', role: 'PRIMARY_USER' }] }); // orgIndex query
    const result = (await handler(
      event('listUsersByOrganization', { organizationId: 'org-1' }, caller(['SupportPerson'], 'sub-1')),
    )) as Connection<unknown>;
    // First call = caller profile GET; second = orgIndex query scoped to the caller's own org.
    const query = mockSend.mock.calls[1][0].input;
    expect(query.IndexName).toBe('orgIndex');
    expect(query.ExpressionAttributeValues).toEqual({ ':org': 'org-1' });
    expect(result.items).toHaveLength(1);
    expect(result.nextToken).toBeNull();
  });

  it('listUsersByOrganization forwards limit and decodes nextToken into ExclusiveStartKey', async () => {
    const startKey = { organizationId: 'org-1', userId: 'u0', PK: 'USER#u0', SK: '#PROFILE' };
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'sub-1', organizationId: 'org-1' } }) // caller profile
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: startKey }); // orgIndex query
    const result = (await handler(
      event(
        'listUsersByOrganization',
        { organizationId: 'org-1', limit: 10, nextToken: encodeNextToken(startKey)! },
        caller(['SupportPerson'], 'sub-1'),
      ),
    )) as Connection<unknown>;
    const query = mockSend.mock.calls[1][0].input;
    expect(query.Limit).toBe(10);
    expect(query.ExclusiveStartKey).toEqual(startKey);
    expect(result.nextToken).not.toBeNull(); // LastEvaluatedKey present → another page
  });

  it('listUsersByOrganization rejects listing another organization', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: 'sub-1', organizationId: 'org-1' } }); // caller profile
    await expect(
      handler(event('listUsersByOrganization', { organizationId: 'org-2' }, caller(['SupportPerson'], 'sub-1'))),
    ).rejects.toThrow('only list your own organization');
    // It must never run the roster query for a foreign org.
    expect(mockSend.mock.calls.some((c) => c[0].input.IndexName === 'orgIndex')).toBe(false);
  });

  it('listUsersByOrganization rejects a caller with no organization (VALIDATION)', async () => {
    mockSend.mockResolvedValueOnce({ Item: { userId: 'sub-1' } }); // profile has no organizationId
    await expect(
      handler(event('listUsersByOrganization', { organizationId: 'org-1' }, caller(['SupportPerson'], 'sub-1'))),
    ).rejects.toThrow('no current organization');
  });

  it('listUsersByOrganization rejects an unauthenticated caller', async () => {
    await expect(
      handler(event('listUsersByOrganization', { organizationId: 'org-1' }, undefined)),
    ).rejects.toThrow('authenticated user is required');
    expect(mockSend).not.toHaveBeenCalled();
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

  it('sets organizationId from a non-empty string (any signed-in user — MVP self-service)', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ organizationId: 'org-2' }) });
    await handler(
      event('updateMyUserProfile', { input: { organizationId: '  org-2  ' } }, caller(['PrimaryUser'], 'sub-1')),
    );
    const cmd = lastInput();
    expect(cmd.UpdateExpression).toBe('SET updatedAt = :now, organizationId = :organizationId');
    expect(cmd.ExpressionAttributeValues[':organizationId']).toBe('org-2'); // trimmed
  });

  it('clears organizationId with an explicit null (REMOVE)', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile() });
    await handler(
      event(
        'updateMyUserProfile',
        { input: { organizationId: null } as Record<string, unknown> },
        caller(['PrimaryUser'], 'sub-1'),
      ),
    );
    const cmd = lastInput();
    expect(cmd.UpdateExpression).toContain('REMOVE organizationId');
    expect(cmd.ExpressionAttributeValues[':organizationId']).toBeUndefined();
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
    expect(query.ExpressionAttributeValues).toEqual({ ':org': 'org-1' });
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
