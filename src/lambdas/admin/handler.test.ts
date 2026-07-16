import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { cognito, findCognitoUsernameBySub, listGroupsForUser } from '../../shared/cognito';
import { batchDelete, queryAllItems, queryAllKeys } from '../../shared/batch';
import { deleteTaskCascade } from '../../shared/taskCascade';
import { decodeNextToken, encodeNextToken } from '../../shared/pagination';
import type { Connection, Task } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

jest.mock('../../shared/cognito', () => ({
  cognito: { send: jest.fn() },
  USER_POOL_ID: 'pool-test',
  SYSTEM_ADMIN_GROUP: 'SystemAdmin',
  BASE_ROLE_GROUPS: ['PrimaryUser', 'SupportPerson', 'OrganizationAdmin'],
  BASE_ROLE_TO_GROUP: {
    PRIMARY_USER: 'PrimaryUser',
    SUPPORT_PERSON: 'SupportPerson',
    ORG_ADMIN: 'OrganizationAdmin',
  },
  findCognitoUsernameBySub: jest.fn(),
  listGroupsForUser: jest.fn(),
}));

jest.mock('../../shared/taskCascade', () => ({ deleteTaskCascade: jest.fn() }));
jest.mock('../../shared/batch', () => ({
  batchDelete: jest.fn(),
  queryAllKeys: jest.fn(),
  queryAllItems: jest.fn(),
}));

const mockSend = dynamo.send as jest.Mock;
const mockCognito = cognito.send as jest.Mock;
const mockFindUsername = findCognitoUsernameBySub as jest.Mock;
const mockListGroups = listGroupsForUser as jest.Mock;
const mockCascade = deleteTaskCascade as jest.Mock;
const mockBatchDelete = batchDelete as jest.Mock;
const mockQueryAllKeys = queryAllKeys as jest.Mock;
const mockQueryAllItems = queryAllItems as jest.Mock;

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose command/transact-item mock helpers

/** Default Cognito responses keyed by command type (overridable per test). */
function defaultCognito(command: {
  constructor: { name: string };
  input: Record<string, unknown>;
}) {
  switch (command.constructor.name) {
    case 'AdminCreateUserCommand':
      return Promise.resolve({
        User: { Username: command.input.Username, Attributes: [{ Name: 'sub', Value: 'sub-new' }] },
      });
    case 'AdminGetUserCommand':
      return Promise.resolve({
        Username: command.input.Username,
        UserAttributes: [
          { Name: 'sub', Value: 'sub-1' },
          { Name: 'email', Value: command.input.Username },
        ],
      });
    default:
      return Promise.resolve({});
  }
}

beforeEach(() => {
  mockSend.mockResolvedValue({});
  mockCognito.mockImplementation(defaultCognito as never);
  mockFindUsername.mockResolvedValue('user@example.com');
  mockListGroups.mockResolvedValue([]);
  mockCascade.mockResolvedValue(null);
  mockBatchDelete.mockResolvedValue(undefined);
  mockQueryAllKeys.mockResolvedValue([]);
  mockQueryAllItems.mockResolvedValue([]);
});
afterEach(() => jest.resetAllMocks());

const ADMIN = { groups: ['SystemAdmin'], sub: 'admin-self' };
function event(fieldName: string, args: Record<string, unknown>, identity: unknown = ADMIN) {
  return { arguments: args, info: { fieldName }, identity } as Parameters<typeof handler>[0];
}
const cognitoCalls = () => mockCognito.mock.calls.map((c) => c[0]);
const cognitoNames = () => cognitoCalls().map((c) => c.constructor.name);
const dynamoCalls = () => mockSend.mock.calls.map((c) => c[0]);
const findCmd = (name: string) => cognitoCalls().find((c) => c.constructor.name === name);
const findGroupAdds = () =>
  cognitoCalls()
    .filter((c) => c.constructor.name === 'AdminAddUserToGroupCommand')
    .map((c) => c.input.GroupName);
const findGroupRemoves = () =>
  cognitoCalls()
    .filter((c) => c.constructor.name === 'AdminRemoveUserFromGroupCommand')
    .map((c) => c.input.GroupName);

// ── Authorization ────────────────────────────────────────────────────────────────
describe('admin handler — SystemAdmin authorization', () => {
  it('listAllUsers rejects a non-SystemAdmin', async () => {
    await expect(handler(event('listAllUsers', {}, { groups: ['SupportPerson'] }))).rejects.toThrow(
      'Unauthorized: SystemAdmin access required',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('admin mutations reject a non-SystemAdmin before any side effect', async () => {
    await expect(
      handler(event('setSystemAdmin', { input: { userId: 'u', enabled: true } }, { groups: [] })),
    ).rejects.toThrow('SystemAdmin');
    await expect(
      handler(
        event('adminDeleteUser', { input: { userId: 'u' } }, { groups: ['OrganizationAdmin'] }),
      ),
    ).rejects.toThrow('SystemAdmin');
    expect(mockCognito).not.toHaveBeenCalled();
    expect(mockCascade).not.toHaveBeenCalled();
  });

  it('admin organization APIs reject a non-SystemAdmin before any side effect', async () => {
    const orgFields: Array<[string, Record<string, unknown>]> = [
      ['listAllOrganizations', {}],
      ['adminCreateOrganization', { input: { name: 'Acme' } }],
      ['adminUpdateOrganization', { input: { organizationId: 'o1', name: 'Acme' } }],
      ['adminDeleteOrganization', { input: { organizationId: 'o1' } }],
      ['adminListOrganizationUsers', { organizationId: 'o1' }],
      ['adminSetUserOrganization', { input: { userId: 'u1', organizationId: 'o1' } }],
    ];
    for (const [field, args] of orgFields) {
      await expect(handler(event(field, args, { groups: ['OrganizationAdmin'] }))).rejects.toThrow(
        'SystemAdmin',
      );
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ── Listings (unchanged) ──────────────────────────────────────────────────────────
describe('admin handler — entityTypeIndex listings', () => {
  it('listAllUsers queries entityTypeIndex for UserProfile, newest-first', async () => {
    await handler(event('listAllUsers', {}));
    const input = dynamoCalls()[0].input;
    expect(dynamoCalls()[0].constructor.name).toBe('QueryCommand');
    expect(input.IndexName).toBe('entityTypeIndex');
    expect(input.ExpressionAttributeValues).toEqual({ ':et': 'UserProfile' });
    expect(input.ScanIndexForward).toBe(false);
  });

  it('decodes nextToken and re-encodes a LastEvaluatedKey', async () => {
    const lek = { entityType: 'Task', createdAt: 't', PK: 'TASK#t1', SK: '#META' };
    mockSend.mockResolvedValueOnce({ Items: [{ taskId: 't1' }], LastEvaluatedKey: lek });
    const result = (await handler(event('listAllTasks', { limit: 1 }))) as Connection<Task>;
    expect(result.items).toHaveLength(1);
    expect(decodeNextToken(result.nextToken!)).toEqual(lek);

    await handler(event('listAllUsers', { nextToken: encodeNextToken(lek)! }));
    expect(dynamoCalls().at(-1).input.ExclusiveStartKey).toEqual(lek);
  });

  it('listAllOrganizations queries entityTypeIndex for Organization, newest-first', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ organizationId: 'o1', name: 'Acme' }] });
    const result = (await handler(event('listAllOrganizations', {}))) as Connection<unknown>;
    const input = dynamoCalls()[0].input;
    expect(dynamoCalls()[0].constructor.name).toBe('QueryCommand');
    expect(input.IndexName).toBe('entityTypeIndex');
    expect(input.ExpressionAttributeValues).toEqual({ ':et': 'Organization' });
    expect(input.ScanIndexForward).toBe(false);
    expect(result.items).toHaveLength(1);
  });
});

// ── Organization management ─────────────────────────────────────────────────────--
describe('admin handler — adminCreateOrganization', () => {
  it('writes ORG#<id>/#META with a generated id, trimmed name, and an existence guard', async () => {
    const result = (await handler(
      event('adminCreateOrganization', { input: { name: '  Acme Inc  ' } }),
    )) as { organizationId: string; name: string };

    const put = dynamoCalls().find((c) => c.constructor.name === 'PutCommand').input;
    expect(put.Item.PK).toBe(`ORG#${result.organizationId}`);
    expect(put.Item.SK).toBe('#META');
    expect(put.Item.entityType).toBe('Organization');
    expect(put.Item.name).toBe('Acme Inc'); // trimmed
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
    // Response is the clean Organization (no PK/SK/entityType).
    expect(typeof result.organizationId).toBe('string');
    expect(result.name).toBe('Acme Inc');
    expect((result as Record<string, unknown>).PK).toBeUndefined();
  });

  it('rejects a blank name before any write', async () => {
    await expect(
      handler(event('adminCreateOrganization', { input: { name: '   ' } })),
    ).rejects.toThrow('name is required');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('admin handler — adminUpdateOrganization', () => {
  it('renames an existing org (aliases the reserved word name), returning the clean row', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { organizationId: 'o1', name: 'Old', createdAt: 'c', updatedAt: 'u' },
      }) // existence check
      .mockResolvedValueOnce({
        Attributes: {
          PK: 'ORG#o1',
          SK: '#META',
          entityType: 'Organization',
          organizationId: 'o1',
          name: 'New',
          createdAt: 'c',
          updatedAt: 'u2',
        },
      });
    const result = (await handler(
      event('adminUpdateOrganization', { input: { organizationId: 'o1', name: '  New  ' } }),
    )) as { name: string };

    const upd = dynamoCalls().find((c) => c.constructor.name === 'UpdateCommand').input;
    expect(upd.Key).toEqual({ PK: 'ORG#o1', SK: '#META' });
    expect(upd.UpdateExpression).toBe('SET #name = :name, updatedAt = :now');
    expect(upd.ExpressionAttributeNames).toEqual({ '#name': 'name' });
    expect(upd.ExpressionAttributeValues[':name']).toBe('New'); // trimmed
    expect(upd.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(deleting)');
    expect(result.name).toBe('New');
    expect((result as Record<string, unknown>).PK).toBeUndefined();
  });

  it('404s for a missing org and issues no update', async () => {
    mockSend.mockResolvedValueOnce({}); // existence check → no Item
    await expect(
      handler(event('adminUpdateOrganization', { input: { organizationId: 'gone', name: 'X' } })),
    ).rejects.toThrow('organization gone not found');
    expect(dynamoCalls().some((c) => c.constructor.name === 'UpdateCommand')).toBe(false);
  });

  it('rejects renaming a deleting org (VALIDATION)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { organizationId: 'o1', name: 'Old', deleting: true, createdAt: 'c', updatedAt: 'u' },
    });
    await expect(
      handler(event('adminUpdateOrganization', { input: { organizationId: 'o1', name: 'X' } })),
    ).rejects.toThrow('being deleted');
    expect(dynamoCalls().some((c) => c.constructor.name === 'UpdateCommand')).toBe(false);
  });

  it('rejects a blank name before any read', async () => {
    await expect(
      handler(event('adminUpdateOrganization', { input: { organizationId: 'o1', name: '  ' } })),
    ).rejects.toThrow('name is required');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('admin handler — adminDeleteOrganization', () => {
  const ORG = { organizationId: 'o1', name: 'Acme', createdAt: 'c', updatedAt: 'u' };

  /**
   * Route dynamo.send: org #META GET, MEMBER# query pages, per-member transactions + org writes.
   * SupportLink revocation-sweep queries (run after each successful detach) are answered with
   * `linkRows` for the member's SUPPORTER# partition and [] for incoming reverse pointers, so they
   * never consume the MEMBER# pages.
   */
  function routeDelete(opts: {
    org?: Record<string, unknown>;
    memberPages?: Array<Array<{ userId: string }>>;
    linkRows?: Array<{ PK: string; SK: string }>;
  }) {
    const pages = opts.memberPages ?? [[]];
    let queryIdx = 0;
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand') return Promise.resolve({ Item: opts.org });
      if (name === 'QueryCommand') {
        // The MEMBER# roster query is the only one keyed by the ':member' prefix.
        if (cmd.input.ExpressionAttributeValues?.[':member']) {
          const page = pages[queryIdx] ?? [];
          const more = queryIdx < pages.length - 1;
          queryIdx += 1;
          return Promise.resolve({
            Items: page,
            LastEvaluatedKey: more ? { k: queryIdx } : undefined,
          });
        }
        // Revocation-sweep queries: outgoing canonical links may carry rows; incoming pointers [].
        const incoming = cmd.input.ExpressionAttributeValues?.[':prefix'] === 'INCOMING_SUPPORT#';
        return Promise.resolve({ Items: incoming ? [] : (opts.linkRows ?? []) });
      }
      return Promise.resolve({}); // UpdateCommand (mark deleting / revoke) + TransactWriteCommand (detach) + DeleteCommand
    });
  }

  it('404s for a missing org without marking or deleting anything', async () => {
    routeDelete({ org: undefined });
    await expect(
      handler(event('adminDeleteOrganization', { input: { organizationId: 'gone' } })),
    ).rejects.toThrow('organization gone not found');
    expect(
      dynamoCalls().some((c) =>
        ['UpdateCommand', 'TransactWriteCommand', 'DeleteCommand'].includes(c.constructor.name),
      ),
    ).toBe(false);
  });

  it('marks deleting, detaches every member via consistent MEMBER# rows, deletes the org row last, no Scan', async () => {
    routeDelete({
      org: ORG,
      memberPages: [[{ userId: 'u1' }, { userId: 'u2' }], [{ userId: 'u3' }]],
    });
    const result = (await handler(
      event('adminDeleteOrganization', { input: { organizationId: 'o1' } }),
    )) as { organization: { organizationId: string }; removedUsers: number };

    // 1) Org marked deleting (a standalone UpdateCommand on the ORG# row — member detach and
    //    guarded SupportLink revocation both use transactions).
    const mark = dynamoCalls()
      .filter((c) => c.constructor.name === 'UpdateCommand')
      .map((c) => c.input)
      .find((u: Rec) => u.Key.PK === 'ORG#o1');
    expect(mark.UpdateExpression).toContain('deleting = :true');

    // 2) Every member detached in its OWN transaction: conditional profile REMOVE (org + the
    //    internal membership session) + membership Delete.
    const memberTx = dynamoCalls()
      .filter((c) => c.constructor.name === 'TransactWriteCommand')
      .map((c) => c.input.TransactItems);
    const profileUpdates = memberTx.map((items: Rec[]) => items.find((t: Rec) => t.Update)!.Update);
    expect(profileUpdates.map((u: Rec) => u.Key.PK).sort()).toEqual([
      'USER#u1',
      'USER#u2',
      'USER#u3',
    ]);
    for (const u of profileUpdates) {
      expect(u.Key.SK).toBe('#PROFILE');
      expect(u.UpdateExpression).toBe(
        'SET updatedAt = :now REMOVE organizationId, organizationMembershipId',
      );
      expect(u.ConditionExpression).toBe('organizationId = :org');
      expect(u.ExpressionAttributeValues[':org']).toBe('o1');
    }
    // …and the same transaction deletes that member's row under the org partition.
    const memberDeletes = memberTx.map((items: Rec[]) => items.find((t: Rec) => t.Delete)!.Delete);
    expect(memberDeletes.map((d: Rec) => d.Key.SK).sort()).toEqual([
      'MEMBER#u1',
      'MEMBER#u2',
      'MEMBER#u3',
    ]);
    for (const d of memberDeletes) expect(d.Key.PK).toBe('ORG#o1');

    // 3) Members found via a STRONGLY-CONSISTENT base-table Query of ORG#o1 / begins_with MEMBER#
    //    (not orgIndex), followed to completion — never a Scan.
    const query = dynamoCalls().find((c) => c.constructor.name === 'QueryCommand').input;
    expect(query.IndexName).toBeUndefined();
    expect(query.ConsistentRead).toBe(true);
    expect(query.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :member)');
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'ORG#o1', ':member': 'MEMBER#' });
    expect(dynamoCalls().some((c) => c.constructor.name === 'ScanCommand')).toBe(false);

    // 4) Org #META row deleted AFTER the last member transaction.
    const del = dynamoCalls().find((c) => c.constructor.name === 'DeleteCommand');
    expect(del.input.Key).toEqual({ PK: 'ORG#o1', SK: '#META' });
    const delIdx = dynamoCalls().findIndex((c) => c.constructor.name === 'DeleteCommand');
    const lastTxIdx = dynamoCalls().reduce(
      (acc, c, i) => (c.constructor.name === 'TransactWriteCommand' ? i : acc),
      -1,
    );
    expect(delIdx).toBeGreaterThan(lastTxIdx);

    // 5) Result.
    expect(result.removedUsers).toBe(3);
    expect(result.organization.organizationId).toBe('o1');
  });

  it("soft-revokes each detached member's ACTIVE SupportLinks (a detach is an org leave)", async () => {
    routeDelete({
      org: ORG,
      memberPages: [[{ userId: 'u1' }]],
      linkRows: [{ PK: 'SUPPORTER#u1', SK: 'USER#p1' }],
    });
    await handler(event('adminDeleteOrganization', { input: { organizationId: 'o1' } }));

    // The sweep queried both link directions for the detached member …
    const sweepQueries = dynamoCalls()
      .filter((c) => c.constructor.name === 'QueryCommand')
      .map((c) => c.input)
      .filter((q: Rec) => !q.ExpressionAttributeValues?.[':member']);
    expect(
      sweepQueries.some((q: Rec) => q.ExpressionAttributeValues[':pk'] === 'SUPPORTER#u1'),
    ).toBe(true);
    expect(
      sweepQueries.some(
        (q: Rec) =>
          q.ConsistentRead === true &&
          q.ExpressionAttributeValues[':pk'] === 'USER#u1' &&
          q.ExpressionAttributeValues[':prefix'] === 'INCOMING_SUPPORT#',
      ),
    ).toBe(true);
    // … and revoked the ACTIVE link with the machine-readable reason (soft — never a Delete).
    const revoke = dynamoCalls()
      .filter((c) => c.constructor.name === 'TransactWriteCommand')
      .flatMap((c) => c.input.TransactItems)
      .map((item: Rec) => item.Update)
      .find((update: Rec | undefined) => update?.Key?.PK === 'SUPPORTER#u1');
    expect(revoke.UpdateExpression).toBe(
      'SET #status = :revoked, revokedReason = :reason, updatedAt = :now',
    );
    expect(revoke.ExpressionAttributeValues[':reason']).toBe('ORG_MEMBERSHIP_CHANGED');
    expect(
      dynamoCalls().some(
        (c) =>
          c.constructor.name === 'DeleteCommand' && String(c.input.Key.PK).startsWith('SUPPORTER#'),
      ),
    ).toBe(false);
  });

  it('handles an empty org: marks deleting, deletes the row, removedUsers = 0, no member transactions', async () => {
    routeDelete({ org: ORG, memberPages: [[]] });
    const result = (await handler(
      event('adminDeleteOrganization', { input: { organizationId: 'o1' } }),
    )) as { removedUsers: number };
    expect(result.removedUsers).toBe(0);
    expect(dynamoCalls().some((c) => c.constructor.name === 'DeleteCommand')).toBe(true);
    expect(dynamoCalls().some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(false);
  });

  it('drops a stale membership row (member already moved) without clearing the moved profile, not counted', async () => {
    // The member's conditional profile update fails (they had moved orgs), canceling the transaction.
    // The now-stale membership row is deleted on its own so org deletion still completes.
    let queryIdx = 0;
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand') return Promise.resolve({ Item: ORG });
      if (name === 'QueryCommand') {
        const page = queryIdx === 0 ? [{ userId: 'moved' }] : [];
        queryIdx += 1;
        return Promise.resolve({ Items: page, LastEvaluatedKey: undefined });
      }
      if (name === 'TransactWriteCommand') {
        return Promise.reject(
          Object.assign(new Error('canceled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
          }),
        );
      }
      return Promise.resolve({}); // UpdateCommand (mark) + DeleteCommand (stale member row / org row)
    });
    const result = (await handler(
      event('adminDeleteOrganization', { input: { organizationId: 'o1' } }),
    )) as { removedUsers: number };

    // The stale membership row was deleted on its own (standalone DeleteCommand, ORG#o1 / MEMBER#moved).
    const staleDelete = dynamoCalls().find(
      (c) => c.constructor.name === 'DeleteCommand' && c.input.Key.SK === 'MEMBER#moved',
    );
    expect(staleDelete.input.Key).toEqual({ PK: 'ORG#o1', SK: 'MEMBER#moved' });
    // The moved profile was NOT counted as detached, and the org #META row is still deleted.
    expect(result.removedUsers).toBe(0);
    expect(
      dynamoCalls().some(
        (c) => c.constructor.name === 'DeleteCommand' && c.input.Key.SK === '#META',
      ),
    ).toBe(true);
  });

  it('rethrows a transient per-member cancellation (e.g. TransactionConflict) instead of dropping the row', async () => {
    // A transient transaction conflict is NOT a ConditionalCheckFailed on the profile guard (item 0),
    // so the membership row is still valid — it must be left intact and the whole operation aborted
    // for a retry (dropping the row now would orphan a profile still pointing at this org).
    let queryIdx = 0;
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand') return Promise.resolve({ Item: ORG });
      if (name === 'QueryCommand') {
        const page = queryIdx === 0 ? [{ userId: 'u1' }] : [];
        queryIdx += 1;
        return Promise.resolve({ Items: page, LastEvaluatedKey: undefined });
      }
      if (name === 'TransactWriteCommand') {
        return Promise.reject(
          Object.assign(new Error('conflict'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
          }),
        );
      }
      return Promise.resolve({});
    });
    await expect(
      handler(event('adminDeleteOrganization', { input: { organizationId: 'o1' } })),
    ).rejects.toThrow('conflict');
    // No membership row dropped on its own, and the org #META row was NOT deleted (aborted for retry).
    expect(dynamoCalls().some((c) => c.constructor.name === 'DeleteCommand')).toBe(false);
  });
});

// ── adminListOrganizationUsers ────────────────────────────────────────────────────
describe('admin handler — adminListOrganizationUsers', () => {
  it('pages ORG#<id>/MEMBER# rows (no Scan), loads profiles, skips missing, passes nextToken', async () => {
    const lek = { PK: 'ORG#o1', SK: 'MEMBER#u2' };
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      if (cmd.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'gone' }],
          LastEvaluatedKey: lek,
        });
      }
      if (cmd.constructor.name === 'GetCommand') {
        const pk = cmd.input.Key.PK as string;
        if (pk === 'USER#gone') return Promise.resolve({}); // membership row → missing profile
        return Promise.resolve({
          Item: {
            PK: pk,
            SK: '#PROFILE',
            entityType: 'UserProfile',
            userId: pk.replace('USER#', ''),
            role: 'PRIMARY_USER',
          },
        });
      }
      return Promise.resolve({});
    });

    const result = (await handler(
      event('adminListOrganizationUsers', { organizationId: 'o1', limit: 3 }),
    )) as Connection<{ userId: string }>;

    // Base-table MEMBER# query — no GSI, no Scan, strongly consistent.
    const query = dynamoCalls().find((c) => c.constructor.name === 'QueryCommand').input;
    expect(query.IndexName).toBeUndefined();
    expect(query.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :member)');
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'ORG#o1', ':member': 'MEMBER#' });
    expect(query.ConsistentRead).toBe(true);
    expect(query.Limit).toBe(3);
    expect(dynamoCalls().some((c) => c.constructor.name === 'ScanCommand')).toBe(false);
    // The missing profile is skipped; only the two real profiles come back.
    expect(result.items.map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
    // Storage attributes are stripped from the returned profiles.
    expect((result.items[0] as Record<string, unknown>).PK).toBeUndefined();
    // nextToken passes through and decodes to the member-row LastEvaluatedKey.
    expect(decodeNextToken(result.nextToken!)).toEqual(lek);
  });

  it('threads an incoming nextToken as the ExclusiveStartKey', async () => {
    const start = { PK: 'ORG#o1', SK: 'MEMBER#u5' };
    mockSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
    await handler(
      event('adminListOrganizationUsers', {
        organizationId: 'o1',
        nextToken: encodeNextToken(start)!,
      }),
    );
    expect(dynamoCalls()[0].input.ExclusiveStartKey).toEqual(start);
  });

  it('rejects a blank organizationId', async () => {
    await expect(
      handler(event('adminListOrganizationUsers', { organizationId: '  ' })),
    ).rejects.toThrow('organizationId is required');
  });
});

// ── adminSetUserOrganization ──────────────────────────────────────────────────────
describe('admin handler — adminSetUserOrganization', () => {
  const tx = () =>
    dynamoCalls().find((c) => c.constructor.name === 'TransactWriteCommand').input.TransactItems;

  it('adds a user to an org: pre-reads, verifies the org, transacts profile update + member put, mints a session', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'target', role: 'PRIMARY_USER' } }) // pre-read: no org
      .mockResolvedValueOnce({
        Item: { organizationId: 'o1', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsableOrganization
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({}) // revocation sweep: outgoing links query (joining IS an org change)
      .mockResolvedValueOnce({}) // revocation sweep: incoming links query
      .mockResolvedValueOnce({
        Item: { userId: 'target', role: 'PRIMARY_USER', organizationId: 'o1' },
      }); // read-back
    const result = (await handler(
      event('adminSetUserOrganization', { input: { userId: 'target', organizationId: 'o1' } }),
    )) as { organizationId?: string };

    const items = tx();
    const update = items.find((t: Rec) => t.Update).Update;
    expect(update.Key).toEqual({ PK: 'USER#target', SK: '#PROFILE' });
    // Joining from no org mints a fresh internal membership session id in the same write.
    expect(update.UpdateExpression).toBe(
      'SET organizationId = :org, organizationMembershipId = :membershipId, updatedAt = :now',
    );
    expect(update.ExpressionAttributeValues[':org']).toBe('o1');
    expect(typeof update.ExpressionAttributeValues[':membershipId']).toBe('string');
    // Bound to the pre-read state (no org) so a concurrent move can't leave a stale membership row.
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(organizationId)',
    );
    const orgCheck = items.find((t: Rec) => t.ConditionCheck).ConditionCheck;
    expect(orgCheck.Key).toEqual({ PK: 'ORG#o1', SK: '#META' });
    expect(orgCheck.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(deleting)',
    );
    const put = items.find((t: Rec) => t.Put).Put.Item;
    expect(put).toMatchObject({
      PK: 'ORG#o1',
      SK: 'MEMBER#target',
      entityType: 'OrganizationMember',
      userId: 'target',
    });
    expect(items.some((t: Rec) => t.Delete)).toBe(false); // no previous org ⇒ no delete
    expect(result.organizationId).toBe('o1');
  });

  it('removes a user from their org with organizationId: null (drops the membership row + session, revokes links)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: {
          userId: 'target',
          role: 'PRIMARY_USER',
          organizationId: 'o1',
          organizationMembershipId: 'mid-1',
        },
      }) // pre-read: in o1
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({}) // revocation sweep: outgoing links query
      .mockResolvedValueOnce({}) // revocation sweep: incoming links query
      .mockResolvedValueOnce({ Item: { userId: 'target', role: 'PRIMARY_USER' } }); // read-back: no org
    const result = (await handler(
      event('adminSetUserOrganization', {
        input: { userId: 'target', organizationId: null } as Record<string, unknown>,
      }),
    )) as { organizationId?: string };

    const items = tx();
    const update = items.find((t: Rec) => t.Update).Update;
    // Leaving removes BOTH the org and the internal membership session.
    expect(update.UpdateExpression).toBe(
      'SET updatedAt = :now REMOVE organizationId, organizationMembershipId',
    );
    // Bound to the pre-read org so a concurrent move can't orphan the new org's membership row.
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId',
    );
    expect(update.ExpressionAttributeValues[':prevOrg']).toBe('o1');
    expect(update.ExpressionAttributeValues[':prevMembershipId']).toBe('mid-1');
    const del = items.find((t: Rec) => t.Delete).Delete;
    expect(del.Key).toEqual({ PK: 'ORG#o1', SK: 'MEMBER#target' });
    // Clearing needs no org existence check or member put — and never reads an ORG# row.
    expect(items.some((t: Rec) => t.ConditionCheck)).toBe(false);
    expect(items.some((t: Rec) => t.Put)).toBe(false);
    expect(
      dynamoCalls().some(
        (c) => c.constructor.name === 'GetCommand' && String(c.input.Key.PK).startsWith('ORG#'),
      ),
    ).toBe(false);
    // Leaving IS an org change → the revocation sweep queried both link directions.
    expect(dynamoCalls().filter((c) => c.constructor.name === 'QueryCommand')).toHaveLength(2);
    expect(result.organizationId).toBeUndefined();
  });

  it('moving a user to a different org rotates the session, deletes the old membership row, and revokes links', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: {
          userId: 'target',
          role: 'PRIMARY_USER',
          organizationId: 'o1',
          organizationMembershipId: 'mid-old',
        },
      }) // pre-read: in o1
      .mockResolvedValueOnce({
        Item: { organizationId: 'o2', name: 'New', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsable o2
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({}) // sweep: outgoing links (none)
      .mockResolvedValueOnce({ Items: [{ supporterId: 'other-sp' }] }) // sweep: incoming pointer
      .mockResolvedValueOnce({}) // revocation update for the found link
      .mockResolvedValueOnce({
        Item: { userId: 'target', role: 'PRIMARY_USER', organizationId: 'o2' },
      }); // read-back
    await handler(
      event('adminSetUserOrganization', { input: { userId: 'target', organizationId: 'o2' } }),
    );

    const items = tx();
    const update = items.find((t: Rec) => t.Update).Update;
    // The profile write is bound to the pre-read org (o1), so a concurrent move aborts this one,
    // and the move mints a FRESH membership session id (never reuses mid-old).
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND organizationId = :prevOrg AND organizationMembershipId = :prevMembershipId',
    );
    expect(update.ExpressionAttributeValues[':prevOrg']).toBe('o1');
    expect(update.ExpressionAttributeValues[':prevMembershipId']).toBe('mid-old');
    expect(update.UpdateExpression).toContain('organizationMembershipId = :membershipId');
    expect(update.ExpressionAttributeValues[':membershipId']).not.toBe('mid-old');
    expect(items.find((t: Rec) => t.Put).Put.Item.PK).toBe('ORG#o2');
    expect(items.find((t: Rec) => t.Delete).Delete.Key).toEqual({
      PK: 'ORG#o1',
      SK: 'MEMBER#target',
    });
    // The ACTIVE link found by the sweep was soft-revoked with the machine-readable reason.
    const revoke = dynamoCalls()
      .filter((c) => c.constructor.name === 'TransactWriteCommand')
      .flatMap((c) => c.input.TransactItems)
      .map((item: Rec) => item.Update)
      .find((update: Rec | undefined) => String(update?.Key?.PK).startsWith('SUPPORTER#'));
    expect(revoke.ExpressionAttributeValues[':revoked']).toBe('REVOKED');
    expect(revoke.ExpressionAttributeValues[':reason']).toBe('ORG_MEMBERSHIP_CHANGED');
  });

  it('re-setting the SAME org keeps the membership session (if-absent init) and revokes nothing', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: {
          userId: 'target',
          role: 'PRIMARY_USER',
          organizationId: 'o1',
          organizationMembershipId: 'mid-keep',
        },
      }) // pre-read: already in o1
      .mockResolvedValueOnce({
        Item: { organizationId: 'o1', name: 'Acme', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsable o1
      .mockResolvedValueOnce({}) // TransactWrite
      .mockResolvedValueOnce({
        Item: { userId: 'target', role: 'PRIMARY_USER', organizationId: 'o1' },
      }); // read-back
    await handler(
      event('adminSetUserOrganization', { input: { userId: 'target', organizationId: 'o1' } }),
    );

    const update = tx().find((t: Rec) => t.Update).Update;
    // Same org ⇒ NOT a leave-and-rejoin: keep the stored id (if_not_exists also lazily
    // initializes a legacy profile without ever rotating an existing one).
    expect(update.UpdateExpression).toBe(
      'SET organizationId = :org, organizationMembershipId = if_not_exists(organizationMembershipId, :membershipId), updatedAt = :now',
    );
    expect(update.ExpressionAttributeValues[':membershipId']).toBe('mid-keep');
    // No org change ⇒ NO revocation sweep queries.
    expect(dynamoCalls().filter((c) => c.constructor.name === 'QueryCommand')).toHaveLength(0);
  });

  it('aborts with a conflict error when the profile moved orgs concurrently (item-0 guard fails)', async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: { userId: 'target', role: 'PRIMARY_USER', organizationId: 'o1' },
      }) // pre-read: in o1
      .mockResolvedValueOnce({
        Item: { organizationId: 'o2', name: 'New', createdAt: 'c', updatedAt: 'u' },
      }) // assertUsable o2
      .mockRejectedValueOnce(
        Object.assign(new Error('canceled'), {
          name: 'TransactionCanceledException',
          // item 0 = profile guard (organizationId = :prevOrg) failed: the user moved since pre-read.
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      );
    await expect(
      handler(
        event('adminSetUserOrganization', { input: { userId: 'target', organizationId: 'o2' } }),
      ),
    ).rejects.toThrow('changed concurrently');
    // The transaction is atomic: nothing (including the stale o1 delete) was committed.
    expect(dynamoCalls().filter((c) => c.constructor.name === 'TransactWriteCommand')).toHaveLength(
      1,
    );
  });

  it('rejects an OMITTED organizationId (only null clears), so a dropped variable cannot wipe an org', async () => {
    await expect(
      handler(event('adminSetUserOrganization', { input: { userId: 'target' } })),
    ).rejects.toThrow('organizationId is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects adding a user to a missing org (NotFound), writing nothing', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'target', role: 'PRIMARY_USER' } }) // pre-read
      .mockResolvedValueOnce({}); // assertUsableOrganization GET → no Item
    await expect(
      handler(
        event('adminSetUserOrganization', { input: { userId: 'target', organizationId: 'gone' } }),
      ),
    ).rejects.toThrow('organization gone not found');
    expect(dynamoCalls().some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(false);
  });

  it('rejects adding a user to a deleting org (VALIDATION)', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { userId: 'target', role: 'PRIMARY_USER' } }) // pre-read
      .mockResolvedValueOnce({
        Item: { organizationId: 'o1', name: 'X', deleting: true, createdAt: 'c', updatedAt: 'u' },
      }); // deleting
    await expect(
      handler(
        event('adminSetUserOrganization', { input: { userId: 'target', organizationId: 'o1' } }),
      ),
    ).rejects.toThrow('being deleted');
    expect(dynamoCalls().some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(false);
  });

  it('rejects when the target user has no profile (NotFound)', async () => {
    mockSend.mockResolvedValueOnce({}); // pre-read → no profile
    await expect(
      handler(
        event('adminSetUserOrganization', { input: { userId: 'ghost', organizationId: 'o1' } }),
      ),
    ).rejects.toThrow('user ghost not found');
    expect(dynamoCalls().some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(false);
  });

  it('rejects a blank userId', async () => {
    await expect(
      handler(event('adminSetUserOrganization', { input: { userId: '  ', organizationId: 'o1' } })),
    ).rejects.toThrow('userId is required');
  });
});

describe('admin handler — adminGetUserData', () => {
  it('aggregates profile, tasks, categories, task assignments, and support links (no Scan)', async () => {
    // GetCommand → profile; taskOwnerIndex → tasks; primaryUserSupportLinkIndex → primary-side links.
    mockSend.mockImplementation(
      (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
        const input = command.input ?? {};
        if (command.constructor.name === 'GetCommand') {
          return Promise.resolve({ Item: { userId: 'u1', role: 'PRIMARY_USER' } });
        }
        if (input.IndexName === 'taskOwnerIndex')
          return Promise.resolve({ Items: [{ taskId: 't1' }] });
        if (input.IndexName === 'primaryUserSupportLinkIndex') {
          return Promise.resolve({ Items: [{ supporterId: 's9', primaryUserId: 'u1' }] });
        }
        return Promise.resolve({});
      },
    );
    // queryAllItems(pk, prefix) drives categories / task assignments / supporter-side links.
    mockQueryAllItems.mockImplementation((_pk: string, prefix: string) => {
      if (prefix === 'CATEGORY#')
        return Promise.resolve([{ categoryId: 'c1' }, { categoryId: 'c2' }]);
      if (prefix === 'TASK_ASSIGNMENT#') return Promise.resolve([{ assignmentId: 'a1' }]);
      if (prefix === 'USER#') return Promise.resolve([{ supporterId: 'u1', primaryUserId: 'p1' }]);
      return Promise.resolve([]);
    });

    const result = (await handler(event('adminGetUserData', { userId: 'u1' }))) as {
      userId: string;
      profile: { userId: string } | null;
      tasks: unknown[];
      categories: unknown[];
      taskAssignments: unknown[];
      supportLinks: Array<{ supporterId: string; primaryUserId: string }>;
    };

    expect(result.userId).toBe('u1');
    expect(result.profile?.userId).toBe('u1');
    expect(result.tasks).toHaveLength(1);
    expect(result.categories).toHaveLength(2);
    expect(result.taskAssignments).toHaveLength(1);
    // One link as supporter (u1→p1) + one as primary (s9→u1), deduped by pair.
    expect(result.supportLinks).toHaveLength(2);
    // Never a Scan.
    expect(dynamoCalls().every((c) => c.constructor.name !== 'ScanCommand')).toBe(true);
  });

  it('rejects a blank userId', async () => {
    await expect(handler(event('adminGetUserData', { userId: '   ' }))).rejects.toThrow(
      'userId is required',
    );
  });
});

// ── Invite ──────────────────────────────────────────────────────────────────────
describe('admin handler — invite', () => {
  it('inviteSupportPerson creates a user and adds ONLY the SupportPerson group', async () => {
    mockListGroups.mockResolvedValue(['SupportPerson']);
    const result = await handler(event('inviteSupportPerson', { input: { email: 'new@e.com' } }));
    expect(findCmd('AdminCreateUserCommand')).toBeDefined();
    expect(findGroupAdds()).toEqual(['SupportPerson']);
    expect(findGroupAdds()).not.toContain('PrimaryUser');
    expect((result as { groups: string[] }).groups).toEqual(['SupportPerson']);
  });

  it('inviteOrganizationAdmin adds ONLY the OrganizationAdmin group', async () => {
    await handler(event('inviteOrganizationAdmin', { input: { email: 'oa@e.com' } }));
    expect(findGroupAdds()).toEqual(['OrganizationAdmin']);
  });

  it('handles an already-existing user (UsernameExistsException) by adopting it', async () => {
    mockCognito.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'AdminCreateUserCommand') {
          return Promise.reject(
            Object.assign(new Error('exists'), { name: 'UsernameExistsException' }),
          );
        }
        return defaultCognito(command);
      },
    );
    await handler(event('inviteSupportPerson', { input: { email: 'exists@e.com' } }));
    // Looked the user up via AdminGetUser, then still applied the group.
    expect(cognitoNames()).toContain('AdminGetUserCommand');
    expect(findGroupAdds()).toEqual(['SupportPerson']);
  });
});

// ── setUserBaseRole ─────────────────────────────────────────────────────────────
describe('admin handler — setUserBaseRole', () => {
  it('removes all base groups, adds the target, leaves SystemAdmin alone', async () => {
    mockFindUsername.mockResolvedValue('u@e.com');
    await handler(event('setUserBaseRole', { input: { userId: 'sub-1', role: 'ORG_ADMIN' } }));
    expect(findGroupRemoves()).toEqual(['PrimaryUser', 'SupportPerson', 'OrganizationAdmin']);
    expect(findGroupRemoves()).not.toContain('SystemAdmin');
    expect(findGroupAdds()).toEqual(['OrganizationAdmin']);
  });

  it('mirrors the role onto an existing UserProfile', async () => {
    await handler(event('setUserBaseRole', { input: { userId: 'sub-1', role: 'ORG_ADMIN' } }));
    const update = dynamoCalls().find((c) => c.constructor.name === 'UpdateCommand');
    expect(update.input.ExpressionAttributeValues[':role']).toBe('ORG_ADMIN');
    expect(update.input.ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('does not fail (or create) when no profile exists', async () => {
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.reject(
          Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }),
        );
      }
      return Promise.resolve({});
    });
    await expect(
      handler(event('setUserBaseRole', { input: { userId: 'sub-1', role: 'SUPPORT_PERSON' } })),
    ).resolves.toBeDefined();
  });

  it('throws NotFound when no Cognito user matches the sub', async () => {
    mockFindUsername.mockResolvedValue(undefined);
    await expect(
      handler(event('setUserBaseRole', { input: { userId: 'ghost', role: 'PRIMARY_USER' } })),
    ).rejects.toThrow('no Cognito user found');
  });
});

// ── setSystemAdmin ──────────────────────────────────────────────────────────────
describe('admin handler — setSystemAdmin', () => {
  it('adds the SystemAdmin group without touching base groups', async () => {
    await handler(event('setSystemAdmin', { input: { userId: 'sub-2', enabled: true } }));
    expect(findGroupAdds()).toEqual(['SystemAdmin']);
    expect(findGroupRemoves()).toEqual([]);
  });

  it('removes the SystemAdmin group for another user', async () => {
    await handler(event('setSystemAdmin', { input: { userId: 'sub-2', enabled: false } }));
    expect(findGroupRemoves()).toEqual(['SystemAdmin']);
  });

  it('rejects self-demotion outright (no Cognito mutation)', async () => {
    await expect(
      handler(event('setSystemAdmin', { input: { userId: 'admin-self', enabled: false } })),
    ).rejects.toThrow('cannot remove SystemAdmin from yourself');
    expect(mockCognito).not.toHaveBeenCalled();
  });
});

// ── adminDeleteTask ─────────────────────────────────────────────────────────────
describe('admin handler — adminDeleteTask', () => {
  it('delegates to the shared cascade with no ownership check', async () => {
    mockCascade.mockResolvedValue({ taskId: 't1' } as Task);
    const result = await handler(event('adminDeleteTask', { taskId: 't1' }));
    expect(mockCascade).toHaveBeenCalledWith('t1');
    expect((result as Task).taskId).toBe('t1');
  });
});

// ── adminDeleteUser ─────────────────────────────────────────────────────────────
describe('admin handler — adminDeleteUser', () => {
  function wireDeletion() {
    mockFindUsername.mockResolvedValue('target@e.com');
    mockSend.mockImplementation((command: { input?: Record<string, unknown> }) => {
      const input = command.input ?? {};
      if (input.IndexName === 'taskOwnerIndex') {
        return Promise.resolve({ Items: [{ taskId: 't1' }, { taskId: 't2' }] });
      }
      if (input.IndexName === 'primaryUserSupportLinkIndex') {
        return Promise.resolve({ Items: [{ PK: 'SUPPORTER#x', SK: 'USER#target' }] });
      }
      return Promise.resolve({});
    });
    mockQueryAllKeys
      .mockResolvedValueOnce([
        { PK: 'USER#target', SK: '#PROFILE' },
        { PK: 'USER#target', SK: 'CATEGORY#c1' },
        { PK: 'USER#target', SK: 'INCOMING_SUPPORT#x' },
      ]) // user partition rows
      .mockResolvedValueOnce([{ PK: 'SUPPORTER#target', SK: 'USER#p1' }]); // supporter-side links
  }

  it('rejects deleting yourself', async () => {
    await expect(
      handler(event('adminDeleteUser', { input: { userId: 'admin-self' } })),
    ).rejects.toThrow('cannot delete yourself');
    expect(mockCascade).not.toHaveBeenCalled();
  });

  it('cascades owned tasks, deletes partition + support links, then the Cognito user LAST', async () => {
    wireDeletion();
    const result = (await handler(event('adminDeleteUser', { input: { userId: 'target' } }))) as {
      deletedTasks: number;
      deletedUserItems: number;
      deletedSupportLinks: number;
      deletedCognitoUser: boolean;
    };
    expect(mockCascade).toHaveBeenCalledTimes(2);
    expect(result.deletedTasks).toBe(2);
    expect(result.deletedUserItems).toBe(3);
    // 1 supporter-side + 1 primary-side; the durable pointer and compatibility GSI return the
    // same canonical target-side link, which must be de-duplicated.
    expect(result.deletedSupportLinks).toBe(2);
    expect(result.deletedCognitoUser).toBe(true);
    // Disable happens before delete; delete is the LAST Cognito call.
    expect(cognitoNames().indexOf('AdminDisableUserCommand')).toBeLessThan(
      cognitoNames().indexOf('AdminDeleteUserCommand'),
    );
    expect(cognitoNames().at(-1)).toBe('AdminDeleteUserCommand');
  });

  it("deletes active TaskAssignments that reference the owner's tasks (even in another user's partition)", async () => {
    mockFindUsername.mockResolvedValue('target@e.com');
    // t1 is assigned to ANOTHER user; that active assignment would dangle once t1's template
    // is cascaded, so adminDeleteUser must remove it explicitly.
    mockSend.mockImplementation((command: { input?: Record<string, unknown> }) => {
      const input = command.input ?? {};
      if (input.IndexName === 'taskOwnerIndex') {
        return Promise.resolve({ Items: [{ taskId: 't1' }, { taskId: 't2' }] });
      }
      if (input.IndexName === 'activeTaskAssignmentTaskIndex') {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        return Promise.resolve(
          values[':taskId'] === 't1'
            ? { Items: [{ PK: 'USER#other', SK: 'TASK_ASSIGNMENT#a9' }] }
            : { Items: [] },
        );
      }
      return Promise.resolve({});
    });
    mockQueryAllKeys.mockResolvedValue([]);

    await handler(event('adminDeleteUser', { input: { userId: 'target' } }));

    // The orphaned active assignment key was batch-deleted (before/with the task cascades).
    const batchedKeys = mockBatchDelete.mock.calls.flatMap((c) => c[0] as Array<{ SK: string }>);
    expect(batchedKeys).toContainEqual({ PK: 'USER#other', SK: 'TASK_ASSIGNMENT#a9' });
  });

  it('does NOT delete the Cognito user when DynamoDB cleanup fails', async () => {
    wireDeletion();
    mockBatchDelete.mockRejectedValueOnce(new Error('boom'));
    await expect(
      handler(event('adminDeleteUser', { input: { userId: 'target' } })),
    ).rejects.toThrow('boom');
    expect(cognitoNames()).not.toContain('AdminDeleteUserCommand');
  });

  it('treats an already-missing Cognito user as a successful delete', async () => {
    mockFindUsername.mockResolvedValue(undefined);
    const result = (await handler(event('adminDeleteUser', { input: { userId: 'target' } }))) as {
      deletedCognitoUser: boolean;
    };
    expect(result.deletedCognitoUser).toBe(true);
    expect(cognitoNames()).not.toContain('AdminDeleteUserCommand');
    expect(cognitoNames()).not.toContain('AdminDisableUserCommand');
  });

  it('skips the Cognito delete when deleteCognitoUser=false', async () => {
    wireDeletion();
    const result = (await handler(
      event('adminDeleteUser', { input: { userId: 'target', deleteCognitoUser: false } }),
    )) as { deletedCognitoUser: boolean };
    expect(result.deletedCognitoUser).toBe(false);
    expect(cognitoNames()).not.toContain('AdminDeleteUserCommand');
  });

  it("deletes the user's profile and OrganizationMember row in one transaction before remaining USER# rows", async () => {
    mockFindUsername.mockResolvedValue('target@e.com');
    // The profile read up front reports the user's org; everything else is empty.
    mockSend.mockImplementation((command: { constructor: { name: string }; input?: Rec }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { userId: 'target', organizationId: 'org-9' } });
      }
      return Promise.resolve({});
    });
    mockQueryAllKeys
      .mockResolvedValueOnce([
        { PK: 'USER#target', SK: '#PROFILE' },
        { PK: 'USER#target', SK: 'CATEGORY#c1' },
      ]) // USER# partition rows
      .mockResolvedValueOnce([]); // supporter-side links
    await handler(event('adminDeleteUser', { input: { userId: 'target' } }));

    const txCallIndex = dynamoCalls().findIndex(
      (c) => c.constructor.name === 'TransactWriteCommand',
    );
    expect(txCallIndex).toBeGreaterThanOrEqual(0);
    const txItems = dynamoCalls()[txCallIndex].input.TransactItems;
    expect(txItems).toContainEqual({
      Delete: {
        TableName: 'CanPlan-test',
        Key: { PK: 'USER#target', SK: '#PROFILE' },
        ConditionExpression: 'attribute_not_exists(PK) OR organizationId = :org',
        ExpressionAttributeValues: { ':org': 'org-9' },
      },
    });
    expect(txItems).toContainEqual({
      Delete: {
        TableName: 'CanPlan-test',
        Key: { PK: 'ORG#org-9', SK: 'MEMBER#target' },
      },
    });

    const calls = mockBatchDelete.mock.calls.map((c) => c[0] as Array<{ PK: string; SK: string }>);
    // The remaining USER# partition batch excludes #PROFILE; the profile was handled atomically
    // with the org membership row above.
    const partitionIdx = calls.findIndex((keys) => keys.some((k) => k.PK === 'USER#target'));
    expect(calls[partitionIdx]).toEqual([{ PK: 'USER#target', SK: 'CATEGORY#c1' }]);
    expect(mockBatchDelete.mock.invocationCallOrder[partitionIdx]).toBeGreaterThan(
      mockSend.mock.invocationCallOrder[txCallIndex],
    );
  });
});

describe('admin handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
