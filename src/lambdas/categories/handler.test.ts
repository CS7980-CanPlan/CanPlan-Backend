import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import { assertCanActForUser } from '../../shared/delegation';
import { UnauthorizedError } from '../../shared/response';
import type { Category, Connection } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

// Delegated-access authorization is exercised via its own unit tests; here we stub it so the
// category handler can be tested for "does it authorize the right target and key rows under
// that target's partition" without standing up SupportLink/profile fixtures.
jest.mock('../../shared/delegation', () => ({
  assertCanActForUser: jest.fn(),
}));

const mockSend = dynamo.send as jest.Mock;
const mockAssert = assertCanActForUser as jest.Mock;

beforeEach(() => {
  mockSend.mockResolvedValue({});
  // Default: authorization passes (self, or an authorized delegated target).
  mockAssert.mockResolvedValue(undefined);
});
afterEach(() => jest.clearAllMocks());

function event(fieldName: string, args: Record<string, unknown>, sub: string | null = 'owner-1') {
  return { arguments: args, info: { fieldName }, identity: sub ? { sub } : undefined } as Parameters<
    typeof handler
  >[0];
}

const firstInput = () => mockSend.mock.calls[0][0].input;
const calls = () => mockSend.mock.calls.map((c) => c[0]);

describe('categories handler — createCategory', () => {
  it('derives ownerId from the identity, sets isDefault:false + taskCount:0, and keys the row', async () => {
    const result = (await handler(
      event('createCategory', { input: { name: 'Morning routine' } }, 'owner-9'),
    )) as Category;

    expect(mockSend).toHaveBeenCalledTimes(1);
    const { Item } = firstInput();
    expect(Item.PK).toBe('USER#owner-9');
    expect(Item.SK).toBe(`CATEGORY#${result.categoryId}`);
    expect(Item.entityType).toBe('Category');
    expect(Item.ownerId).toBe('owner-9');
    expect(Item.name).toBe('Morning routine');
    expect(Item.isDefault).toBe(false);
    expect(Item.taskCount).toBe(0);
  });

  it('ignores any client-supplied ownerId — use userId for the delegated target path', async () => {
    await handler(
      event('createCategory', { input: { ownerId: 'victim', name: 'X' } as Record<string, unknown> }, 'me'),
    );
    expect(firstInput().Item.ownerId).toBe('me');
    expect(firstInput().Item.PK).toBe('USER#me');
  });

  it('authorizes the caller against themselves when userId is omitted', async () => {
    await handler(event('createCategory', { input: { name: 'X' } }, 'me'));
    expect(mockAssert).toHaveBeenCalledWith(expect.objectContaining({ sub: 'me' }), 'me');
    expect(firstInput().Item.PK).toBe('USER#me');
  });

  it('treats a self userId the same as omitting it', async () => {
    await handler(event('createCategory', { input: { userId: 'me', name: 'X' } }, 'me'));
    expect(mockAssert).toHaveBeenCalledWith(expect.objectContaining({ sub: 'me' }), 'me');
    expect(firstInput().Item.ownerId).toBe('me');
    expect(firstInput().Item.PK).toBe('USER#me');
  });

  it('delegated create keys the row under the TARGET user, not the SupportPerson', async () => {
    const result = (await handler(
      event('createCategory', { input: { userId: 'primary-1', name: 'Chores' } }, 'support-1'),
    )) as Category;
    expect(mockAssert).toHaveBeenCalledWith(expect.objectContaining({ sub: 'support-1' }), 'primary-1');
    expect(firstInput().Item.PK).toBe('USER#primary-1');
    expect(firstInput().Item.ownerId).toBe('primary-1');
    expect(result.ownerId).toBe('primary-1');
  });

  it('rejects an unauthorized delegated create WITHOUT writing to DynamoDB', async () => {
    mockAssert.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(
      handler(event('createCategory', { input: { userId: 'victim', name: 'X' } }, 'support-1')),
    ).rejects.toThrow('no active support link');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('trims name/color and stores sortOrder', async () => {
    await handler(
      event('createCategory', { input: { name: '  Chores  ', color: '  #ff0000  ', sortOrder: 3 } }),
    );
    const { Item } = firstInput();
    expect(Item.name).toBe('Chores');
    expect(Item.color).toBe('#ff0000');
    expect(Item.sortOrder).toBe(3);
  });

  it('rejects a blank name and the reserved "No Category" name without writing', async () => {
    await expect(handler(event('createCategory', { input: { name: '   ' } }))).rejects.toThrow(
      'name is required',
    );
    await expect(handler(event('createCategory', { input: { name: 'No Category' } }))).rejects.toThrow(
      'reserved',
    );
    await expect(handler(event('createCategory', { input: { name: ' no category ' } }))).rejects.toThrow(
      'reserved',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(handler(event('createCategory', { input: { name: 'X' } }, null))).rejects.toThrow(
      'authenticated user is required',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('categories handler — listMyCategories', () => {
  it('queries the caller-owned CATEGORY# partition and strips internal fields', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          categoryId: 'c1',
          ownerId: 'owner-1',
          name: 'A',
          isDefault: false,
          deleting: true,
          taskCount: 5,
          PK: 'x',
          SK: 'y',
        },
      ],
    });
    const result = (await handler(event('listMyCategories', {}, 'owner-1'))) as Connection<Category>;
    expect(firstInput().KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(firstInput().ExpressionAttributeValues).toEqual({
      ':pk': 'USER#owner-1',
      ':prefix': 'CATEGORY#',
    });
    const item = result.items[0] as unknown as Record<string, unknown>;
    expect(item.PK).toBeUndefined();
    expect(item.deleting).toBeUndefined();
    expect(item.taskCount).toBeUndefined();
  });

  it('delegated list queries the TARGET user partition, not the SupportPerson', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    await handler(event('listMyCategories', { userId: 'primary-1' }, 'support-1'));
    expect(mockAssert).toHaveBeenCalledWith(expect.objectContaining({ sub: 'support-1' }), 'primary-1');
    expect(firstInput().ExpressionAttributeValues).toEqual({
      ':pk': 'USER#primary-1',
      ':prefix': 'CATEGORY#',
    });
  });

  it('rejects an unauthorized delegated list WITHOUT querying DynamoDB', async () => {
    mockAssert.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(
      handler(event('listMyCategories', { userId: 'victim' }, 'support-1')),
    ).rejects.toThrow('no active support link');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(handler(event('listMyCategories', {}, null))).rejects.toThrow(
      'authenticated user is required',
    );
  });
});

describe('categories handler — updateCategory', () => {
  const normal = {
    PK: 'USER#owner-1',
    SK: 'CATEGORY#c1',
    entityType: 'Category',
    categoryId: 'c1',
    ownerId: 'owner-1',
    name: 'Chores',
    isDefault: false,
    taskCount: 4,
    createdAt: 'c',
    updatedAt: 'c',
  };
  const def = { ...normal, categoryId: 'def-1', SK: 'CATEGORY#def-1', name: 'No Category', isDefault: true };
  const updateCmd = () => calls().find((c) => c.constructor.name === 'UpdateCommand');

  it('requires at least one updatable field', async () => {
    await expect(handler(event('updateCategory', { input: { categoryId: 'c1' } }))).rejects.toThrow(
      'at least one of name, color, or sortOrder',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('updates a normal category with a targeted UpdateCommand that preserves the deleting lock', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal } }) // getOwnedCategory
      .mockResolvedValueOnce({ Attributes: { ...normal, name: 'Errands', color: '#0f0', sortOrder: 2 } }); // UpdateCommand ALL_NEW
    const result = (await handler(
      event('updateCategory', {
        input: { categoryId: 'c1', name: '  Errands  ', color: '#0f0', sortOrder: 2 },
      }),
    )) as Category;

    const upd = updateCmd()!.input;
    expect(upd.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(deleting)');
    expect(upd.UpdateExpression).toContain('#name = :name');
    expect(upd.UpdateExpression).toContain('color = :color');
    expect(upd.UpdateExpression).toContain('sortOrder = :sortOrder');
    expect(upd.ExpressionAttributeNames).toEqual({ '#name': 'name' });
    expect(upd.ExpressionAttributeValues[':name']).toBe('Errands');
    expect(result.name).toBe('Errands');
    expect((result as unknown as Record<string, unknown>).taskCount).toBeUndefined();
  });

  it('clears color/sortOrder on explicit null (REMOVE) but rejects a null name', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal } })
      .mockResolvedValueOnce({ Attributes: { ...normal } });
    await handler(event('updateCategory', { input: { categoryId: 'c1', color: null, sortOrder: null } }));
    expect(updateCmd()!.input.UpdateExpression).toContain('REMOVE color, sortOrder');

    jest.clearAllMocks();
    mockSend.mockResolvedValueOnce({ Item: { ...normal } });
    await expect(
      handler(event('updateCategory', { input: { categoryId: 'c1', name: null } as Record<string, unknown> })),
    ).rejects.toThrow('name cannot be null');
  });

  it('rejects renaming a normal category to the reserved default name', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...normal } });
    await expect(
      handler(event('updateCategory', { input: { categoryId: 'c1', name: 'No Category' } })),
    ).rejects.toThrow('reserved');
  });

  it('rejects any name change on the default category (even unchanged)', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...def } });
    await expect(
      handler(event('updateCategory', { input: { categoryId: 'def-1', name: 'No Category' } })),
    ).rejects.toThrow('default category cannot be renamed');
  });

  it('allows color/sortOrder changes on the default category', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...def } })
      .mockResolvedValueOnce({ Attributes: { ...def, color: '#abc', sortOrder: 0 } });
    const result = (await handler(
      event('updateCategory', { input: { categoryId: 'def-1', color: '#abc', sortOrder: 0 } }),
    )) as Category;
    expect(result.isDefault).toBe(true);
    expect(result.name).toBe('No Category');
  });

  it('rejects updating a category that is already being deleted (no write attempted)', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...normal, deleting: true } });
    await expect(
      handler(event('updateCategory', { input: { categoryId: 'c1', color: '#000' } })),
    ).rejects.toThrow('being deleted');
    expect(calls().some((c) => c.constructor.name === 'UpdateCommand')).toBe(false);
  });

  it('maps a mid-update deletion (ConditionalCheckFailed) to a clear error', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal } })
      .mockRejectedValueOnce(
        Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }),
      );
    await expect(
      handler(event('updateCategory', { input: { categoryId: 'c1', color: '#000' } })),
    ).rejects.toThrow('being deleted');
  });

  it('returns NotFound when the category does not exist for the caller', async () => {
    mockSend.mockResolvedValueOnce({}); // GET → no Item
    await expect(
      handler(event('updateCategory', { input: { categoryId: 'missing', color: '#000' } })),
    ).rejects.toThrow('category missing not found');
  });

  it('delegated update reads/writes the TARGET user partition, not the SupportPerson', async () => {
    const targetNormal = { ...normal, PK: 'USER#primary-1', ownerId: 'primary-1' };
    mockSend
      .mockResolvedValueOnce({ Item: { ...targetNormal } }) // getOwnedCategory (target)
      .mockResolvedValueOnce({ Attributes: { ...targetNormal, color: '#0f0' } }); // UpdateCommand
    await handler(
      event('updateCategory', { input: { userId: 'primary-1', categoryId: 'c1', color: '#0f0' } }, 'support-1'),
    );
    expect(mockAssert).toHaveBeenCalledWith(expect.objectContaining({ sub: 'support-1' }), 'primary-1');
    expect(updateCmd()!.input.Key).toEqual({ PK: 'USER#primary-1', SK: 'CATEGORY#c1' });
  });

  it('rejects an unauthorized delegated update WITHOUT touching DynamoDB', async () => {
    mockAssert.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(
      handler(event('updateCategory', { input: { userId: 'victim', categoryId: 'c1', color: '#000' } }, 'support-1')),
    ).rejects.toThrow('no active support link');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('categories handler — deleteCategory', () => {
  const normal = {
    PK: 'USER#owner-1',
    SK: 'CATEGORY#c1',
    entityType: 'Category',
    categoryId: 'c1',
    ownerId: 'owner-1',
    name: 'Chores',
    isDefault: false,
    deleting: false,
    taskCount: 2,
    createdAt: 'c',
    updatedAt: 'c',
  };
  const validDefault = {
    PK: 'USER#owner-1',
    SK: 'CATEGORY#def-1',
    entityType: 'Category',
    categoryId: 'def-1',
    ownerId: 'owner-1',
    name: 'No Category',
    isDefault: true,
    taskCount: 0,
    createdAt: 'c',
    updatedAt: 'c',
  };

  it('rejects deleting the default category', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...normal, isDefault: true } });
    await expect(handler(event('deleteCategory', { input: { categoryId: 'def-1' } }))).rejects.toThrow(
      'default category cannot be deleted',
    );
  });

  it('returns NotFound when the category does not exist', async () => {
    mockSend.mockResolvedValueOnce({}); // GET → none
    await expect(handler(event('deleteCategory', { input: { categoryId: 'gone' } }))).rejects.toThrow(
      'category gone not found',
    );
  });

  it('fails clearly when the owner has no default category to reparent into', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal } }) // GET category
      .mockResolvedValueOnce({ Item: { userId: 'owner-1' } }); // GET profile → no defaultCategoryId
    await expect(handler(event('deleteCategory', { input: { categoryId: 'c1' } }))).rejects.toThrow(
      'no default category',
    );
  });

  it('flags deleting, reparents tasks (adjusting both counts), then deletes once taskCount is 0', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal, taskCount: 2 } }) // GET category
      .mockResolvedValueOnce({ Item: { userId: 'owner-1', defaultCategoryId: 'def-1' } }) // GET profile
      .mockResolvedValueOnce({ Item: validDefault }) // strongly-consistent GET default category
      .mockResolvedValueOnce({}) // Update set deleting
      .mockResolvedValueOnce({
        Items: [
          { taskId: 't1', ownerId: 'owner-1', categoryId: 'c1' },
          { taskId: 't2', ownerId: 'owner-1', categoryId: 'c1' },
        ],
      }) // Query taskCategoryIndex
      .mockResolvedValueOnce({}) // TransactWrite move t1
      .mockResolvedValueOnce({}) // TransactWrite move t2
      .mockResolvedValueOnce({ Item: { ...normal, deleting: true, taskCount: 0 } }) // consistent read
      .mockResolvedValueOnce({}); // Delete category

    const result = (await handler(event('deleteCategory', { input: { categoryId: 'c1' } }))) as Category;

    const cmds = calls();
    expect(
      cmds.some(
        (c) =>
          c.constructor.name === 'UpdateCommand' && c.input.UpdateExpression.includes('deleting = :true'),
      ),
    ).toBe(true);
    const txs = cmds.filter((c) => c.input.TransactItems);
    expect(txs).toHaveLength(2);
    const items0 = txs[0].input.TransactItems;
    expect(items0[0].Update.UpdateExpression).toContain('categoryId = :to');
    expect(items0[0].Update.ExpressionAttributeValues[':to']).toBe('def-1');
    expect(items0[1].Update.Key.SK).toBe('CATEGORY#c1');
    expect(items0[1].Update.ExpressionAttributeValues[':delta']).toBe(-1);
    expect(items0[2].Update.Key.SK).toBe('CATEGORY#def-1');
    expect(items0[2].Update.ExpressionAttributeValues[':delta']).toBe(1);
    const consistentGet = cmds.find((c) => c.constructor.name === 'GetCommand' && c.input.ConsistentRead);
    expect(consistentGet).toBeDefined();
    const del = cmds.find((c) => c.constructor.name === 'DeleteCommand');
    expect(del!.input.ConditionExpression).toContain('taskCount = :zero');
    expect(result.categoryId).toBe('c1');
  });

  it('does NOT delete when the GSI shows no tasks but the durable taskCount is still positive', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal, taskCount: 1 } }) // GET category
      .mockResolvedValueOnce({ Item: { userId: 'owner-1', defaultCategoryId: 'def-1' } }) // GET profile
      .mockResolvedValueOnce({ Item: validDefault }) // strongly-consistent GET default category
      .mockResolvedValueOnce({}) // Update set deleting
      .mockResolvedValueOnce({ Items: [] }) // Query → GSI lag, nothing visible
      .mockResolvedValueOnce({ Item: { ...normal, deleting: true, taskCount: 1 } }); // consistent read → still 1

    await expect(handler(event('deleteCategory', { input: { categoryId: 'c1' } }))).rejects.toThrow(
      'still has 1 task',
    );
    expect(calls().some((c) => c.constructor.name === 'DeleteCommand')).toBe(false);
  });

  it('treats an already-moved task (reparent transaction conflict) as a safe no-op and still deletes', async () => {
    const conflict = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    });
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal, taskCount: 1 } }) // GET category
      .mockResolvedValueOnce({ Item: { userId: 'owner-1', defaultCategoryId: 'def-1' } }) // GET profile
      .mockResolvedValueOnce({ Item: validDefault }) // strongly-consistent GET default category
      .mockResolvedValueOnce({}) // Update set deleting
      .mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: 'owner-1', categoryId: 'c1' }] }) // Query
      .mockRejectedValueOnce(conflict) // TransactWrite move → already moved
      .mockResolvedValueOnce({ Item: { ...normal, deleting: true, taskCount: 0 } }) // consistent read → 0
      .mockResolvedValueOnce({}); // Delete

    const result = (await handler(event('deleteCategory', { input: { categoryId: 'c1' } }))) as Category;
    expect(result.categoryId).toBe('c1');
    expect(calls().some((c) => c.constructor.name === 'DeleteCommand')).toBe(true);
  });

  it('propagates a reparent transaction failure that is NOT a benign already-moved skip', async () => {
    const realFailure = Object.assign(new Error('canceled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    mockSend
      .mockResolvedValueOnce({ Item: { ...normal, taskCount: 1 } })
      .mockResolvedValueOnce({ Item: { userId: 'owner-1', defaultCategoryId: 'def-1' } })
      .mockResolvedValueOnce({ Item: validDefault })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: 'owner-1', categoryId: 'c1' }] })
      .mockRejectedValueOnce(realFailure);
    await expect(handler(event('deleteCategory', { input: { categoryId: 'c1' } }))).rejects.toThrow(
      'canceled',
    );
  });

  it('delegated delete reparents into the TARGET user default and keys every row under the target', async () => {
    const targetNormal = { ...normal, PK: 'USER#primary-1', ownerId: 'primary-1', taskCount: 1 };
    const targetDefault = { ...validDefault, PK: 'USER#primary-1', ownerId: 'primary-1' };
    mockSend
      .mockResolvedValueOnce({ Item: { ...targetNormal } }) // GET category (target)
      .mockResolvedValueOnce({ Item: { userId: 'primary-1', defaultCategoryId: 'def-1' } }) // GET target profile
      .mockResolvedValueOnce({ Item: targetDefault }) // strongly-consistent GET target default
      .mockResolvedValueOnce({}) // Update set deleting
      .mockResolvedValueOnce({ Items: [{ taskId: 't1', ownerId: 'primary-1', categoryId: 'c1' }] }) // Query
      .mockResolvedValueOnce({}) // TransactWrite move t1
      .mockResolvedValueOnce({ Item: { ...targetNormal, deleting: true, taskCount: 0 } }) // consistent read
      .mockResolvedValueOnce({}); // Delete category

    const result = (await handler(
      event('deleteCategory', { input: { userId: 'primary-1', categoryId: 'c1' } }, 'support-1'),
    )) as Category;

    expect(mockAssert).toHaveBeenCalledWith(expect.objectContaining({ sub: 'support-1' }), 'primary-1');
    const cmds = calls();
    // The reparent query and move target the primary user's partition/default category.
    const tx = cmds.find((c) => c.input.TransactItems)!.input.TransactItems;
    expect(tx[0].Update.Key.PK).toBe('TASK#t1');
    expect(tx[0].Update.ExpressionAttributeValues[':to']).toBe('def-1');
    expect(tx[1].Update.Key.PK).toBe('USER#primary-1'); // source category count row
    expect(tx[2].Update.Key.PK).toBe('USER#primary-1'); // target default count row
    const del = cmds.find((c) => c.constructor.name === 'DeleteCommand')!;
    expect(del.input.Key).toEqual({ PK: 'USER#primary-1', SK: 'CATEGORY#c1' });
    expect(result.categoryId).toBe('c1');
  });

  it('rejects an unauthorized delegated delete WITHOUT touching DynamoDB', async () => {
    mockAssert.mockRejectedValueOnce(new UnauthorizedError('no active support link'));
    await expect(
      handler(event('deleteCategory', { input: { userId: 'victim', categoryId: 'c1' } }, 'support-1')),
    ).rejects.toThrow('no active support link');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('categories handler — routing', () => {
  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
