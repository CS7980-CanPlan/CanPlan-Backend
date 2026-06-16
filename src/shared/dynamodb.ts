import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Single shared DynamoDB document client reused across Lambda invocations.
// The document client automatically marshals/unmarshals JS objects to DynamoDB items.
const rawClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });

export const dynamo = DynamoDBDocumentClient.from(rawClient, {
  // Drop attributes set to `undefined` so optional fields don't need manual pruning.
  marshallOptions: { removeUndefinedValues: true },
});

// Single-table store for every CanPlan entity (UserProfile, Task, Assignment, …).
// Keyed by composite PK/SK — see src/shared/keys.ts for the item-key conventions.
// The name keeps the historical CanPlanTasks-<env> pattern to avoid a rename.
export const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME ?? 'CanPlanTasks-dev';
