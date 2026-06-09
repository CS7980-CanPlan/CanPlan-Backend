/**
 * Seed the dev DynamoDB table with a few sample tasks.
 * Run with: npx ts-node scripts/seed-dev.ts
 *
 * Requires AWS credentials and DYNAMODB_TABLE_NAME in your environment.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE_NAME ?? 'CanPlanTasks-dev';

const seedTasks = [
  { title: 'Set up project repo', description: 'Initialize CanPlan 2.0 backend' },
  { title: 'Design database schema', description: 'Plan DynamoDB access patterns' },
  { title: 'Build createTask Lambda', description: 'Proof-of-concept Lambda function' },
];

async function seed() {
  console.log(`Seeding table: ${TABLE}`);

  for (const t of seedTasks) {
    const item = {
      taskId: crypto.randomUUID(),
      title: t.title,
      description: t.description,
      createdAt: new Date().toISOString(),
    };

    await client.send(new PutCommand({ TableName: TABLE, Item: item }));
    console.log(`  Created: ${item.taskId} — ${item.title}`);
  }

  console.log('Done.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
