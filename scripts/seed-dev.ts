/**
 * Seed the dev DynamoDB table with sample CONTENT: one reusable task template and
 * its ordered steps.
 *
 * A task template is the only entity that doesn't depend on a real account or file:
 *   - UserProfile / SupportLink / Assignment are all tied to Cognito users (created
 *     via sign-up), so seeding them would create orphan rows for users that don't
 *     exist in the User Pool.
 *   - MediaAsset only stores an `s3Key`; seeding one points at an S3 object that was
 *     never uploaded. Real flow: upload the binary to the media bucket first, THEN
 *     call createMediaAsset.
 * None of those are seeded here.
 *
 * Run with: npx ts-node scripts/seed-dev.ts
 * Requires AWS credentials; set DYNAMODB_TABLE_NAME to the deployed table (e.g.
 * CanPlanTasks-sandbox). Override AWS_REGION if your profile's default isn't ca-central-1.
 */

import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  categorySk,
  ENTITY,
  META_SK,
  stepSk,
  taskCategoryKey,
  taskPk,
  userPk,
} from '../src/shared/keys';

// Default to the backend region (ca-central-1), matching src/shared/dynamodb.ts, so
// the seed targets the right table even if the profile's default region differs.
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const TABLE = process.env.DYNAMODB_TABLE_NAME ?? 'CanPlanTasks-dev';

const now = new Date().toISOString();
const taskId = randomUUID();
// Placeholder owner. In production this is the Cognito `sub` of the SupportPerson /
// OrgAdmin who created the template; here it's a known value so you can exercise
// listTasksByOwner without a real account.
const ownerId = 'seed-support-1';
// Every task belongs to a real Category, so seed one and file the task under it. (A real
// account also has a "No Category" default created with its profile; this standalone
// content seed just needs one valid category to reference.)
const categoryId = randomUUID();

const steps = (
  ['Wet your hands with warm water', 'Add soap and scrub for 20 seconds', 'Rinse and dry'] as const
).map((text, index) => ({
  stepId: randomUUID(),
  order: index + 1,
  text,
}));

const items: Array<Record<string, unknown>> = [
  {
    PK: userPk(ownerId),
    SK: categorySk(categoryId),
    entityType: ENTITY.CATEGORY,
    categoryId,
    ownerId,
    name: 'Hygiene',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  },
  {
    PK: taskPk(taskId),
    SK: META_SK,
    entityType: ENTITY.TASK,
    taskId,
    ownerId,
    title: 'Wash your hands',
    categoryId,
    taskCategoryKey: taskCategoryKey(ownerId, categoryId),
    createdAt: now,
    updatedAt: now,
  },
  ...steps.map((step) => ({
    PK: taskPk(taskId),
    SK: stepSk(step.stepId),
    entityType: ENTITY.TASK_STEP,
    stepId: step.stepId,
    taskId,
    order: step.order,
    text: step.text,
    createdAt: now,
    updatedAt: now,
  })),
];

async function seed() {
  console.log(`Seeding table: ${TABLE}`);
  for (const item of items) {
    await client.send(new PutCommand({ TableName: TABLE, Item: item }));
    console.log(`  Put ${item.entityType}: ${item.PK} / ${item.SK}`);
  }
  console.log(
    `Done. Seeded category ${categoryId} + task ${taskId} (owner ${ownerId}) with ${steps.length} steps.`,
  );
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
