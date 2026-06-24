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

  it('listUsersByOrganization queries the orgIndex by organizationId and returns a connection', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ userId: 'u1', role: 'PRIMARY_USER' }] });
    const result = (await handler(
      event('listUsersByOrganization', { organizationId: 'org-1' }),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('orgIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':org': 'org-1' });
    expect(result.items).toHaveLength(1);
    expect(result.nextToken).toBeNull();
  });

  it('listUsersByOrganization forwards limit and decodes nextToken into ExclusiveStartKey', async () => {
    const startKey = { organizationId: 'org-1', userId: 'u0', PK: 'USER#u0', SK: '#PROFILE' };
    mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: startKey });
    const result = (await handler(
      event('listUsersByOrganization', {
        organizationId: 'org-1',
        limit: 10,
        nextToken: encodeNextToken(startKey)!,
      }),
    )) as Connection<unknown>;
    expect(lastInput().Limit).toBe(10);
    expect(lastInput().ExclusiveStartKey).toEqual(startKey);
    expect(result.nextToken).not.toBeNull(); // LastEvaluatedKey present → another page
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
    ).rejects.toThrow('at least one of displayName or accessibilitySettings');
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

  it('never changes organizationId, role, email, defaultCategoryId, or createdAt', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: storedProfile({ displayName: 'New name' }) });
    await handler(
      event(
        'updateMyUserProfile',
        {
          // An attacker tries to slip protected fields into the input — they are not part
          // of the input type and must never appear in the write expression.
          input: {
            displayName: 'New name',
            organizationId: 'evil-org',
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
    for (const field of ['organizationId', 'role', 'email', 'defaultCategoryId', 'createdAt']) {
      expect(cmd.UpdateExpression).not.toContain(field);
      expect(cmd.ExpressionAttributeValues[`:${field}`]).toBeUndefined();
    }
  });
});

describe('users handler — SupportLink', () => {
  it('createSupportLink writes SUPPORTER#<id>/USER#<id> carrying the supporterIndex fields (supporterId, userId)', async () => {
    await handler(
      event('createSupportLink', {
        input: { supporterId: 's1', primaryUserId: 'u1', status: 'ACTIVE' },
      }),
    );
    const { Item } = lastInput();
    expect(Item.PK).toBe('SUPPORTER#s1');
    expect(Item.SK).toBe('USER#u1');
    expect(Item.entityType).toBe('SupportLink');
    expect(Item.supporterId).toBe('s1');
    expect(Item.primaryUserId).toBe('u1');
    // userId mirrors primaryUserId so it can be the supporterIndex sort key.
    expect(Item.userId).toBe('u1');
    expect(Item.status).toBe('ACTIVE');
  });

  it('createSupportLink defaults status to PENDING and validates ids', async () => {
    await handler(
      event('createSupportLink', { input: { supporterId: 's1', primaryUserId: 'u1' } }),
    );
    expect(lastInput().Item.status).toBe('PENDING');
    await expect(
      handler(event('createSupportLink', { input: { supporterId: 's1' } })),
    ).rejects.toThrow('primaryUserId is required');
  });

  it('listPrimaryUsersBySupporter queries the supporterIndex by supporterId', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ supporterId: 's1', userId: 'u1' }] });
    const result = (await handler(
      event('listPrimaryUsersBySupporter', { supporterId: 's1' }),
    )) as Connection<unknown>;
    expect(lastInput().IndexName).toBe('supporterIndex');
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':sup': 's1' });
    expect(result.items).toHaveLength(1);
  });
});

describe('users handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
