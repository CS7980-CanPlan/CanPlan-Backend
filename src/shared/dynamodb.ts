import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Single shared DynamoDB document client reused across Lambda invocations.
// The document client automatically marshals/unmarshals JS objects to DynamoDB items.
const rawClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });

export const dynamo = DynamoDBDocumentClient.from(rawClient);

export const TASKS_TABLE = process.env.DYNAMODB_TABLE_NAME ?? 'CanPlanTasks-dev';
