import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { cognito, findCognitoUsernameBySub, listGroupsForUser } from '../../shared/cognito';
import { batchDelete, queryAllKeys } from '../../shared/batch';
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
}));

const mockSend = dynamo.send as jest.Mock;
const mockCognito = cognito.send as jest.Mock;
const mockFindUsername = findCognitoUsernameBySub as jest.Mock;
const mockListGroups = listGroupsForUser as jest.Mock;
const mockCascade = deleteTaskCascade as jest.Mock;
const mockBatchDelete = batchDelete as jest.Mock;
const mockQueryAllKeys = queryAllKeys as jest.Mock;

/** Default Cognito responses keyed by command type (overridable per test). */
function defaultCognito(command: { constructor: { name: string }; input: Record<string, unknown> }) {
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
    await expect(
      handler(event('listAllUsers', {}, { groups: ['SupportPerson'] })),
    ).rejects.toThrow('Unauthorized: SystemAdmin access required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('admin mutations reject a non-SystemAdmin before any side effect', async () => {
    await expect(
      handler(event('setSystemAdmin', { input: { userId: 'u', enabled: true } }, { groups: [] })),
    ).rejects.toThrow('SystemAdmin');
    await expect(
      handler(event('adminDeleteUser', { input: { userId: 'u' } }, { groups: ['OrganizationAdmin'] })),
    ).rejects.toThrow('SystemAdmin');
    expect(mockCognito).not.toHaveBeenCalled();
    expect(mockCascade).not.toHaveBeenCalled();
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
    mockCognito.mockImplementation((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'AdminCreateUserCommand') {
        return Promise.reject(Object.assign(new Error('exists'), { name: 'UsernameExistsException' }));
      }
      return defaultCognito(command);
    });
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
    expect(result.deletedUserItems).toBe(2);
    expect(result.deletedSupportLinks).toBe(2); // 1 supporter-side + 1 primary-side
    expect(result.deletedCognitoUser).toBe(true);
    // Disable happens before delete; delete is the LAST Cognito call.
    expect(cognitoNames().indexOf('AdminDisableUserCommand')).toBeLessThan(
      cognitoNames().indexOf('AdminDeleteUserCommand'),
    );
    expect(cognitoNames().at(-1)).toBe('AdminDeleteUserCommand');
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
});

describe('admin handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
