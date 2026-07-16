import {
  ensureOrganizationMembershipId,
  ORG_MEMBERSHIP_CHANGED,
  planMembershipTransition,
  revokeSupportLinksForOrganizationChange,
} from './organizationMembership';
import { dynamo } from './dynamodb';

jest.mock('./dynamodb', () => ({ dynamo: { send: jest.fn() }, TABLE_NAME: 'CanPlan-test' }));

const mockSend = dynamo.send as jest.Mock;

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose command mock helpers

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

const calls = () => mockSend.mock.calls.map((c) => c[0]);
const queries = () => calls().filter((c) => c.constructor.name === 'QueryCommand');
const revocationTransactions = () =>
  calls().filter((c) => c.constructor.name === 'TransactWriteCommand');
const revocationUpdates = () =>
  revocationTransactions().map((c) => c.input.TransactItems[1].Update);
const profileChecks = () =>
  revocationTransactions().map((c) => c.input.TransactItems[0].ConditionCheck);

describe('planMembershipTransition — the membership-session decision table', () => {
  it('joining from no organization mints a fresh membership id (an org change)', () => {
    const t = planMembershipTransition(undefined, undefined, 'org-1');
    expect(t.kind).toBe('rotate');
    expect(t.organizationChanged).toBe(true);
    expect((t as { membershipId: string }).membershipId).toBeTruthy();
  });

  it('moving to a different organization mints a fresh membership id (an org change)', () => {
    const t = planMembershipTransition('org-1', 'mid-1', 'org-2');
    expect(t.kind).toBe('rotate');
    expect(t.organizationChanged).toBe(true);
    expect((t as { membershipId: string }).membershipId).not.toBe('mid-1');
  });

  it('rejoining generates a DIFFERENT membership id every time (never reuses an old session)', () => {
    const first = planMembershipTransition(undefined, undefined, 'org-1');
    const second = planMembershipTransition(undefined, undefined, 'org-1');
    expect((first as { membershipId: string }).membershipId).not.toBe(
      (second as { membershipId: string }).membershipId,
    );
  });

  it('leaving clears the membership id (an org change)', () => {
    expect(planMembershipTransition('org-1', 'mid-1', undefined)).toEqual({
      kind: 'clear',
      organizationChanged: true,
    });
  });

  it('setting the SAME organizationId keeps the existing id — no rotation, NOT an org change', () => {
    expect(planMembershipTransition('org-1', 'mid-1', 'org-1')).toEqual({
      kind: 'keep',
      organizationChanged: false,
      membershipId: 'mid-1',
      initialized: false,
    });
  });

  it('an unchanged org on a LEGACY profile (no id yet) initializes lazily — still NOT an org change', () => {
    const t = planMembershipTransition('org-1', undefined, 'org-1');
    expect(t.kind).toBe('keep');
    expect(t.organizationChanged).toBe(false);
    expect((t as { initialized: boolean }).initialized).toBe(true);
    expect((t as { membershipId: string }).membershipId).toBeTruthy();
  });

  it('no org before or after is a no-op', () => {
    expect(planMembershipTransition(undefined, undefined, undefined)).toEqual({
      kind: 'none',
      organizationChanged: false,
    });
    expect(planMembershipTransition('  ', 'mid-x', '')).toEqual({
      kind: 'none',
      organizationChanged: false,
    });
  });
});

describe('ensureOrganizationMembershipId — concurrency-safe lazy initialization', () => {
  it('initializes if-absent (if_not_exists), preserves organizationId, and returns the STORED winner', async () => {
    // A concurrent initializer already won: the stored value comes back, not ours.
    mockSend.mockResolvedValueOnce({
      Attributes: { userId: 'u1', organizationId: 'org-1', organizationMembershipId: 'winner-mid' },
    });
    await expect(ensureOrganizationMembershipId('u1', 'org-1')).resolves.toBe('winner-mid');

    const cmd = calls()[0];
    expect(cmd.constructor.name).toBe('UpdateCommand');
    expect(cmd.input.Key).toEqual({ PK: 'USER#u1', SK: '#PROFILE' });
    // if_not_exists ⇒ an id that already exists is NEVER rotated; only one stable id wins.
    expect(cmd.input.UpdateExpression).toBe(
      'SET organizationMembershipId = if_not_exists(organizationMembershipId, :fresh)',
    );
    // Conditioned on the profile still being in this org — never resurrects a left membership.
    expect(cmd.input.ConditionExpression).toBe('attribute_exists(PK) AND organizationId = :org');
    expect(cmd.input.ExpressionAttributeValues[':org']).toBe('org-1');
    expect(typeof cmd.input.ExpressionAttributeValues[':fresh']).toBe('string');
  });

  it('maps a lost org race (condition failure) to the repository-standard retryable error', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(ensureOrganizationMembershipId('u1', 'org-1')).rejects.toThrow(
      /changed concurrently/,
    );
  });
});

describe('revokeSupportLinksForOrganizationChange — the shared revocation sweep', () => {
  /** Route both base-table directions; everything else resolves {} (revocation transactions succeed). */
  function routeLinks(opts: {
    outgoingPages?: Array<Array<Rec>>;
    incomingPages?: Array<Array<Rec>>;
    failLinkConditions?: number[]; // 0-based revocations whose link condition loses a race
    failProfileConditions?: number[]; // 0-based revocations whose profile-state guard is stale
  }) {
    const out = opts.outgoingPages ?? [[]];
    const inc = opts.incomingPages ?? [[]];
    let outIdx = 0;
    let incIdx = 0;
    let revocationIdx = 0;
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Rec }) => {
      if (cmd.constructor.name === 'QueryCommand') {
        const isIncoming = cmd.input.ExpressionAttributeValues?.[':prefix'] === 'INCOMING_SUPPORT#';
        const pages = isIncoming ? inc : out;
        const idx = isIncoming ? incIdx++ : outIdx++;
        const page = pages[idx] ?? [];
        const more = idx < pages.length - 1;
        return Promise.resolve({ Items: page, LastEvaluatedKey: more ? { k: idx } : undefined });
      }
      if (cmd.constructor.name === 'TransactWriteCommand') {
        const i = revocationIdx++;
        if (opts.failProfileConditions?.includes(i)) {
          return Promise.reject(
            Object.assign(new Error('cond'), {
              name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
            }),
          );
        }
        if (opts.failLinkConditions?.includes(i)) {
          return Promise.reject(
            Object.assign(new Error('cond'), {
              name: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
            }),
          );
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
  }
  const link = (pk: string, sk: string): Rec => ({ PK: pk, SK: sk });
  const incomingPointer = (supporterId: string): Rec => ({ supporterId });

  it('rejects an impossible partial post-change membership state before reading DynamoDB', async () => {
    await expect(
      revokeSupportLinksForOrganizationChange('u1', { organizationId: 'org-1' }),
    ).rejects.toThrow(/requires organizationId and organizationMembershipId together/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('queries BOTH directions consistently from base-table partitions (no GSI and no Scan)', async () => {
    routeLinks({});
    await revokeSupportLinksForOrganizationChange('u1', {});

    const [outgoing, incoming] = queries().map((c) => c.input);
    // Outgoing: the user's own SUPPORTER# partition on the base table.
    expect(outgoing.IndexName).toBeUndefined();
    expect(outgoing.ConsistentRead).toBe(true);
    expect(outgoing.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(outgoing.ExpressionAttributeValues[':pk']).toBe('SUPPORTER#u1');
    expect(outgoing.ExpressionAttributeValues[':prefix']).toBe('USER#');
    expect(outgoing.FilterExpression).toBe('#status = :active');
    // Incoming: durable reverse pointers under the primary user's USER# partition.
    expect(incoming.IndexName).toBeUndefined();
    expect(incoming.ConsistentRead).toBe(true);
    expect(incoming.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
    expect(incoming.ExpressionAttributeValues).toEqual({
      ':pk': 'USER#u1',
      ':prefix': 'INCOMING_SUPPORT#',
    });
    expect(incoming.FilterExpression).toBeUndefined();
    expect(calls().some((c) => c.constructor.name === 'ScanCommand')).toBe(false);
  });

  it('soft-revokes each ACTIVE link with reason ORG_MEMBERSHIP_CHANGED, preserving createdAt (targeted update, no rewrite)', async () => {
    routeLinks({
      outgoingPages: [[link('SUPPORTER#u1', 'USER#p1')]],
      incomingPages: [[incomingPointer('s9')]],
    });
    const revoked = await revokeSupportLinksForOrganizationChange('u1', {});
    expect(revoked).toBe(2);

    expect(revocationUpdates()).toHaveLength(2);
    for (const update of revocationUpdates()) {
      // Only status/reason/updatedAt are touched — createdAt and every other field survive,
      // and the row is never deleted or recreated (attribute_exists guard).
      expect(update.UpdateExpression).toBe(
        'SET #status = :revoked, revokedReason = :reason, updatedAt = :now',
      );
      expect(update.ConditionExpression).toBe('attribute_exists(PK) AND #status = :active');
      expect(update.ExpressionAttributeValues[':revoked']).toBe('REVOKED');
      expect(update.ExpressionAttributeValues[':reason']).toBe(ORG_MEMBERSHIP_CHANGED);
    }
    expect(revocationUpdates().map((update) => update.Key)).toEqual([
      { PK: 'SUPPORTER#u1', SK: 'USER#p1' },
      { PK: 'SUPPORTER#s9', SK: 'USER#u1' },
    ]);
    for (const check of profileChecks()) {
      expect(check.Key).toEqual({ PK: 'USER#u1', SK: '#PROFILE' });
      expect(check.ConditionExpression).toBe(
        'attribute_exists(PK) AND attribute_not_exists(organizationId) AND attribute_not_exists(organizationMembershipId)',
      );
    }
  });

  it('follows pagination on both queries so a user with many links is fully swept', async () => {
    routeLinks({
      outgoingPages: [
        [link('SUPPORTER#u1', 'USER#p1'), link('SUPPORTER#u1', 'USER#p2')],
        [link('SUPPORTER#u1', 'USER#p3')],
      ],
      incomingPages: [[incomingPointer('s1')], [incomingPointer('s2')]],
    });
    const revoked = await revokeSupportLinksForOrganizationChange('u1', {});
    expect(revoked).toBe(5);
    expect(queries()).toHaveLength(4); // 2 outgoing pages + 2 incoming pages
    expect(revocationUpdates()).toHaveLength(5);
  });

  it('with a current membership id, skips links selected under the NEW session (condition excludes them)', async () => {
    routeLinks({ outgoingPages: [[link('SUPPORTER#u1', 'USER#p1')]] });
    await revokeSupportLinksForOrganizationChange('u1', {
      organizationId: 'org-new',
      organizationMembershipId: 'mid-new',
    });

    const outgoingUpdate = revocationUpdates()[0];
    expect(outgoingUpdate.ConditionExpression).toBe(
      'attribute_exists(PK) AND #status = :active AND ' +
        '(attribute_not_exists(supporterOrganizationMembershipId) OR ' +
        'supporterOrganizationMembershipId <> :currentMid)',
    );
    expect(outgoingUpdate.ExpressionAttributeValues[':currentMid']).toBe('mid-new');
    expect(profileChecks()[0]).toMatchObject({
      ConditionExpression:
        'attribute_exists(PK) AND organizationId = :expectedOrg AND organizationMembershipId = :expectedMid',
      ExpressionAttributeValues: { ':expectedOrg': 'org-new', ':expectedMid': 'mid-new' },
    });
  });

  it('guards the PRIMARY side with primaryUserOrganizationMembershipId for incoming links', async () => {
    routeLinks({ incomingPages: [[incomingPointer('s1')]] });
    await revokeSupportLinksForOrganizationChange('u1', {
      organizationId: 'org-new',
      organizationMembershipId: 'mid-new',
    });
    expect(revocationUpdates()[0].ConditionExpression).toContain(
      'primaryUserOrganizationMembershipId <> :currentMid',
    );
  });

  it('does not let a delayed old sweep revoke a link after the profile moves or rejoins again', async () => {
    routeLinks({
      outgoingPages: [[link('SUPPORTER#u1', 'USER#p1')]],
      failProfileConditions: [0],
    });
    const revoked = await revokeSupportLinksForOrganizationChange('u1', {
      organizationId: 'org-old-transition',
      organizationMembershipId: 'mid-old-transition',
    });
    expect(revoked).toBe(0);
    expect(profileChecks()).toHaveLength(1);
  });

  it('is idempotent: an already-REVOKED/deleted/re-selected link (condition failure) is skipped, others proceed', async () => {
    routeLinks({
      outgoingPages: [[link('SUPPORTER#u1', 'USER#p1'), link('SUPPORTER#u1', 'USER#p2')]],
      failLinkConditions: [0], // first link lost a race — swallowed, not fatal
    });
    const revoked = await revokeSupportLinksForOrganizationChange('u1', {});
    expect(revoked).toBe(1);
    expect(revocationUpdates()).toHaveLength(2);
  });

  it('rethrows non-conditional update failures (transient errors must surface for a retry)', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'QueryCommand') {
        return Promise.resolve({ Items: [link('SUPPORTER#u1', 'USER#p1')] });
      }
      return Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    });
    await expect(revokeSupportLinksForOrganizationChange('u1', {})).rejects.toThrow('throttled');
  });
});
