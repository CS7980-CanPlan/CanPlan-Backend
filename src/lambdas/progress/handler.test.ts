import { handler } from './handler';
import { dynamo } from '../../shared/dynamodb';
import type { ProgressEvent } from '../../shared/types';

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

describe('progress handler', () => {
  it('createProgressEvent writes PK=USER#<id>, SK=PROGRESS#<timestamp>#<eventId>', async () => {
    const ts = '2026-06-15T10:00:00.000Z';
    const result = (await handler(
      event('createProgressEvent', {
        input: { userId: 'u1', assignmentId: 'a1', eventType: 'COMPLETED', timestamp: ts },
      }),
    )) as ProgressEvent;
    const { Item } = lastInput();
    expect(Item.PK).toBe('USER#u1');
    expect(Item.SK).toBe(`PROGRESS#${ts}#${Item.eventId}`);
    expect(result.eventId).toBe(Item.eventId);
    expect(Item.entityType).toBe('ProgressEvent');
    expect(Item.eventType).toBe('COMPLETED');
    expect(Item.timestamp).toBe(ts);
  });

  it('createProgressEvent is append-only (refuses to overwrite) and generates a unique eventId', async () => {
    await handler(event('createProgressEvent', { input: { userId: 'u1', eventType: 'STARTED' } }));
    expect(lastInput().ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(lastInput().Item.eventId).toMatch(/[0-9a-f-]{36}/);
  });

  it('createProgressEvent defaults the timestamp to now when omitted', async () => {
    const result = (await handler(
      event('createProgressEvent', { input: { userId: 'u1', eventType: 'SYNCED' } }),
    )) as ProgressEvent;
    expect(typeof result.timestamp).toBe('string');
    expect(lastInput().Item.SK).toBe(`PROGRESS#${result.timestamp}#${result.eventId}`);
  });

  it('createProgressEvent validates userId and eventType', async () => {
    await expect(handler(event('createProgressEvent', { input: { eventType: 'STARTED' } }))).rejects.toThrow(
      'userId is required',
    );
    await expect(handler(event('createProgressEvent', { input: { userId: 'u1' } }))).rejects.toThrow(
      'eventType is required',
    );
  });

  it('listProgressEventsForUser queries SK begins_with PROGRESS#', async () => {
    mockSend.mockResolvedValueOnce({ Items: [{ eventId: 'e1' }] });
    await handler(event('listProgressEventsForUser', { userId: 'u1' }));
    expect(lastInput().ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':prefix': 'PROGRESS#' });
    expect(lastInput().FilterExpression).toBeUndefined();
  });

  it('listProgressEventsForUser filters by assignmentId when provided', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    await handler(event('listProgressEventsForUser', { userId: 'u1', assignmentId: 'a1' }));
    expect(lastInput().FilterExpression).toBe('assignmentId = :assignmentId');
    expect(lastInput().ExpressionAttributeValues[':assignmentId']).toBe('a1');
  });
});
