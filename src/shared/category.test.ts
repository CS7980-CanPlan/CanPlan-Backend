import { assertUsableCategory, getDefaultCategoryId, getOwnedCategory } from './category';
import { dynamo } from './dynamodb';

jest.mock('./dynamodb', () => ({
  dynamo: { send: jest.fn() },
  TABLE_NAME: 'CanPlan-test',
}));

const mockSend = dynamo.send as jest.Mock;
afterEach(() => jest.clearAllMocks());

const calls = () => mockSend.mock.calls.map((c) => c[0]);

/**
 * Stub: profile GET (#PROFILE) → `profile`; category GET (CATEGORY#…) → `category`.
 * `category` may be a function of the requested categoryId.
 */
function stub(opts: {
  profile?: Record<string, unknown> | null;
  category?: Record<string, unknown> | null;
}) {
  mockSend.mockImplementation((cmd: { input: { Key?: { SK?: string } } }) => {
    const sk = cmd.input.Key?.SK ?? '';
    if (sk === '#PROFILE') return Promise.resolve(opts.profile ? { Item: opts.profile } : {});
    if (sk.startsWith('CATEGORY#')) return Promise.resolve(opts.category ? { Item: opts.category } : {});
    return Promise.resolve({});
  });
}

const validDefault = {
  categoryId: 'def-1',
  ownerId: 'owner-1',
  isDefault: true,
  name: 'No Category',
  taskCount: 0,
};

describe('getDefaultCategoryId', () => {
  it('returns the id for a valid default category (read strongly-consistently)', async () => {
    stub({ profile: { userId: 'owner-1', defaultCategoryId: 'def-1' }, category: { ...validDefault } });
    await expect(getDefaultCategoryId('owner-1')).resolves.toBe('def-1');
    // The category read used a consistent read.
    const catGet = calls().find((c) => c.input.Key?.SK === 'CATEGORY#def-1');
    expect(catGet.input.ConsistentRead).toBe(true);
  });

  it('rejects a missing profile', async () => {
    stub({ profile: null });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('no user profile');
  });

  it('rejects a profile with no defaultCategoryId', async () => {
    stub({ profile: { userId: 'owner-1' } });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('no default category');
  });

  it('rejects a pointer to a missing category row', async () => {
    stub({ profile: { userId: 'owner-1', defaultCategoryId: 'def-1' }, category: null });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('missing or invalid');
  });

  it('rejects a category owned by someone else', async () => {
    stub({
      profile: { userId: 'owner-1', defaultCategoryId: 'def-1' },
      category: { ...validDefault, ownerId: 'other' },
    });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('missing or invalid');
  });

  it('rejects a non-default category', async () => {
    stub({
      profile: { userId: 'owner-1', defaultCategoryId: 'def-1' },
      category: { ...validDefault, isDefault: false },
    });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('missing or invalid');
  });

  it('rejects a default category with the wrong (non-reserved) name', async () => {
    stub({
      profile: { userId: 'owner-1', defaultCategoryId: 'def-1' },
      category: { ...validDefault, name: 'Chores' },
    });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('missing or invalid');
  });

  it('rejects a non-canonical spelling of the reserved name', async () => {
    stub({
      profile: { userId: 'owner-1', defaultCategoryId: 'def-1' },
      category: { ...validDefault, name: 'no category' },
    });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('missing or invalid');
  });

  it('rejects a default category that is mid-deletion', async () => {
    stub({
      profile: { userId: 'owner-1', defaultCategoryId: 'def-1' },
      category: { ...validDefault, deleting: true },
    });
    await expect(getDefaultCategoryId('owner-1')).rejects.toThrow('missing or invalid');
  });
});

describe('assertUsableCategory', () => {
  it('returns a real, owned, non-deleting category', async () => {
    mockSend.mockResolvedValueOnce({ Item: { categoryId: 'c1', ownerId: 'owner-1', isDefault: false } });
    await expect(assertUsableCategory('owner-1', 'c1')).resolves.toMatchObject({ categoryId: 'c1' });
  });

  it('rejects a missing category and a deleting one', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(assertUsableCategory('owner-1', 'nope')).rejects.toThrow('not found');
    mockSend.mockResolvedValueOnce({ Item: { categoryId: 'c1', ownerId: 'owner-1', deleting: true } });
    await expect(assertUsableCategory('owner-1', 'c1')).rejects.toThrow('being deleted');
  });
});

describe('getOwnedCategory', () => {
  it('passes ConsistentRead through when requested', async () => {
    mockSend.mockResolvedValueOnce({ Item: { categoryId: 'c1' } });
    await getOwnedCategory('owner-1', 'c1', { consistentRead: true });
    expect(calls()[0].input.ConsistentRead).toBe(true);
  });
});
