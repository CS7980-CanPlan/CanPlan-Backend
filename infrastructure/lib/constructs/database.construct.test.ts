import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Database } from './database.construct';

function synth() {
  const stack = new Stack(new App(), 'TestStack');
  new Database(stack, 'Database', { envName: 'test', isDestroyable: true });
  return Template.fromStack(stack);
}

describe('Database construct — DynamoDB single table', () => {
  it('uses a composite PK/SK key schema and PAY_PER_REQUEST billing', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  it('defines the entityTypeIndex GSI with entityType (HASH) + createdAt (RANGE), projection ALL', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'entityTypeIndex',
          KeySchema: [
            { AttributeName: 'entityType', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  it('defines the taskCategoryIndex GSI with taskCategoryKey (HASH) + createdAt (RANGE), projection ALL', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'taskCategoryIndex',
          KeySchema: [
            { AttributeName: 'taskCategoryKey', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  it('defines the primaryUserSupportLinkIndex GSI with userId (HASH) + supporterId (RANGE), projection ALL', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'primaryUserSupportLinkIndex',
          KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'supporterId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  it('still defines the original GSIs alongside taskCategoryIndex', () => {
    const template = synth();
    const table = Object.values(template.findResources('AWS::DynamoDB::Table'))[0];
    const indexNames = table.Properties.GlobalSecondaryIndexes.map(
      (g: { IndexName: string }) => g.IndexName,
    );
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'supporterIndex',
        'orgIndex',
        'taskOwnerIndex',
        'taskCategoryIndex',
        'entityTypeIndex',
        'primaryUserSupportLinkIndex',
      ]),
    );
  });
});
