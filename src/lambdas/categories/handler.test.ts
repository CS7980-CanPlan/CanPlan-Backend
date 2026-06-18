import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { Category, Connection } from '../../shared/types';

jest.mock('../../shared/dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

function event(fieldName: string, args: Record<string, unknown>) {
  return { arguments: args, info: { fieldName } } as Parameters<typeof handler>[0];
}

const lastInput = () => mockSend.mock.calls[0][0].input;

describe('categories handler', () => {
  it('createCategory writes PK=USER#<ownerId>, SK=CATEGORY#<categoryId> with entityType=Category', async () => {
    const result = (await handler(
      event('createCategory', { input: { ownerId: 'u1', name: 'Morning routine' } }),
    )) as Category;

    expect(mockSend).toHaveBeenCalledTimes(1);
    const { Item } = lastInput();
    expect(Item.PK).toBe('USER#u1');
    expect(Item.SK).toBe(`CATEGORY#${result.categoryId}`);
    expect(Item.entityType).toBe('Category');
    expect(Item.ownerId).toBe('u1');
    expect(Item.name).toBe('Morning routine');
    expect(typeof Item.categoryId).toBe('string');
    expect(typeof Item.createdAt).toBe('string');
    expect(Item.updatedAt).toBe(Item.createdAt);
    expect(result.categoryId).toMatch(/[0-9a-f-]{36}/);
  });

  it('createCategory trims ownerId, name, and color and stores optional fields', async () => {
    await handler(
      event('createCategory', {
        input: { ownerId: '  u1  ', name: '  Chores  ', color: '  #ff0000  ', sortOrder: 3 },
      }),
    );
    const { Item } = lastInput();
    expect(Item.PK).toBe('USER#u1');
    expect(Item.ownerId).toBe('u1');
    expect(Item.name).toBe('Chores');
    expect(Item.color).toBe('#ff0000');
    expect(Item.sortOrder).toBe(3);
  });

  it('createCategory rejects a missing ownerId and a blank name without writing', async () => {
    await expect(handler(event('createCategory', { input: { name: 'X' } }))).rejects.toThrow(
      'ownerId is required',
    );
    await expect(
      handler(event('createCategory', { input: { ownerId: 'u1', name: '   ' } })),
    ).rejects.toThrow('name is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('listCategoriesByOwner queries USER#<ownerId> with a CATEGORY# sort-key prefix', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ categoryId: 'c1', ownerId: 'u1' }] });
    const result = (await handler(
      event('listCategoriesByOwner', { ownerId: 'u1' }),
    )) as Connection<Category>;

    expect(lastInput().KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(lastInput().ExpressionAttributeValues).toEqual({
      ':pk': 'USER#u1',
      ':prefix': 'CATEGORY#',
    });
    expect(result.items).toHaveLength(1);
  });

  it('listCategoriesByOwner requires an ownerId', async () => {
    await expect(handler(event('listCategoriesByOwner', { ownerId: '  ' }))).rejects.toThrow(
      'ownerId is required',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws on an unsupported field', async () => {
    await expect(handler(event('nope', {}))).rejects.toThrow('unsupported field');
  });
});
