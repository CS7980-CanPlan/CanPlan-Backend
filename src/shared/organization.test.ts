import {
  assertUsableOrganization,
  getOrganization,
  organizationMemberDelete,
  organizationMemberPut,
  stripOrganization,
} from './organization';
import { dynamo } from './dynamodb';

jest.mock('./dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));

const mockSend = dynamo.send as jest.Mock;
const lastInput = () => mockSend.mock.calls[0][0].input;

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

const orgRow = (overrides: Record<string, unknown> = {}) => ({
  PK: 'ORG#o1',
  SK: '#META',
  entityType: 'Organization',
  organizationId: 'o1',
  name: 'Acme',
  createdAt: 'c',
  updatedAt: 'u',
  ...overrides,
});

describe('getOrganization', () => {
  it('reads PK=ORG#<id>, SK=#META and returns the row', async () => {
    mockSend.mockResolvedValueOnce({ Item: orgRow() });
    const org = await getOrganization('o1');
    expect(lastInput().Key).toEqual({ PK: 'ORG#o1', SK: '#META' });
    expect(lastInput().ConsistentRead).toBe(true);
    expect(org?.organizationId).toBe('o1');
  });

  it('returns undefined for a blank id without touching DynamoDB', async () => {
    expect(await getOrganization('   ')).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns undefined when the row does not exist', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await getOrganization('o1')).toBeUndefined();
  });
});

describe('assertUsableOrganization', () => {
  it('returns the stripped org when it exists and is not deleting', async () => {
    mockSend.mockResolvedValueOnce({ Item: orgRow() });
    const org = await assertUsableOrganization('o1');
    expect(org).toEqual({ organizationId: 'o1', name: 'Acme', createdAt: 'c', updatedAt: 'u' });
    // Internal storage attributes are stripped.
    const raw = org as unknown as Record<string, unknown>;
    expect(raw.PK).toBeUndefined();
    expect(raw.deleting).toBeUndefined();
  });

  it('throws ValidationError for a blank id', async () => {
    await expect(assertUsableOrganization('  ')).rejects.toThrow('organizationId is required');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the org does not exist', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(assertUsableOrganization('gone')).rejects.toThrow('organization gone not found');
  });

  it('throws ValidationError when the org is being deleted', async () => {
    mockSend.mockResolvedValueOnce({ Item: orgRow({ deleting: true }) });
    await expect(assertUsableOrganization('o1')).rejects.toThrow('being deleted');
  });
});

describe('stripOrganization', () => {
  it('removes PK/SK/entityType/deleting', () => {
    expect(stripOrganization(orgRow({ deleting: true }))).toEqual({
      organizationId: 'o1',
      name: 'Acme',
      createdAt: 'c',
      updatedAt: 'u',
    });
  });
});

describe('organizationMemberPut', () => {
  it('builds a Put transact item for the ORG#<id>/MEMBER#<user> membership row', () => {
    const item = organizationMemberPut('o1', 'u1').Put;
    expect(item.TableName).toBe('CanPlan-test');
    expect(item.Item.PK).toBe('ORG#o1');
    expect(item.Item.SK).toBe('MEMBER#u1');
    expect(item.Item.entityType).toBe('OrganizationMember');
    expect(item.Item.organizationId).toBe('o1');
    expect(item.Item.userId).toBe('u1');
    expect(typeof item.Item.createdAt).toBe('string');
    expect(typeof item.Item.updatedAt).toBe('string');
  });
});

describe('organizationMemberDelete', () => {
  it('builds a Delete transact item keyed by ORG#<id>/MEMBER#<user>', () => {
    expect(organizationMemberDelete('o1', 'u1').Delete).toEqual({
      TableName: 'CanPlan-test',
      Key: { PK: 'ORG#o1', SK: 'MEMBER#u1' },
    });
  });
});
