/**
 * Seed the dev DynamoDB table with a small single-table sample: a support person,
 * a primary user, the support link between them, a task template with steps, an
 * assignment of that task to the primary user, a progress event, and a media asset.
 *
 * Run with: npx ts-node scripts/seed-dev.ts
 * Requires AWS credentials, and DYNAMODB_TABLE_NAME set to the deployed table
 * (e.g. CanPlanTasks-sandbox). The table lives in the backend region — override
 * with AWS_REGION if your default profile region isn't ca-central-1.
 */

import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  assignSk,
  ENTITY,
  mediaSk,
  META_SK,
  PROFILE_SK,
  progressSk,
  stepSk,
  supporterPk,
  taskPk,
  userLinkSk,
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
const supporterId = 'seed-support-1';
const primaryUserId = 'seed-primary-1';
const taskId = randomUUID();
const assignmentId = randomUUID();
const eventId = randomUUID();
const assetId = randomUUID();

// Task steps captured as a list so the media asset below can reference a real stepId.
const stepItems = [
  'Wet your hands with warm water',
  'Add soap and scrub for 20 seconds',
  'Rinse and dry',
].map((text, index) => ({
  PK: taskPk(taskId),
  SK: stepSk(index + 1),
  entityType: ENTITY.TASK_STEP,
  stepId: randomUUID(),
  taskId,
  order: index + 1,
  text,
  createdAt: now,
  updatedAt: now,
}));

const items: Array<Record<string, unknown>> = [
  {
    PK: userPk(supporterId),
    SK: PROFILE_SK,
    entityType: ENTITY.USER_PROFILE,
    userId: supporterId,
    role: 'SUPPORT_PERSON',
    displayName: 'Sample Supporter',
    organizationId: 'seed-org-1',
    createdAt: now,
    updatedAt: now,
  },
  {
    PK: userPk(primaryUserId),
    SK: PROFILE_SK,
    entityType: ENTITY.USER_PROFILE,
    userId: primaryUserId,
    role: 'PRIMARY_USER',
    displayName: 'Sample Primary User',
    organizationId: 'seed-org-1',
    createdAt: now,
    updatedAt: now,
  },
  {
    PK: supporterPk(supporterId),
    SK: userLinkSk(primaryUserId),
    entityType: ENTITY.SUPPORT_LINK,
    supporterId,
    primaryUserId,
    userId: primaryUserId,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  },
  {
    PK: taskPk(taskId),
    SK: META_SK,
    entityType: ENTITY.TASK,
    taskId,
    ownerId: supporterId,
    title: 'Wash your hands',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  },
  ...stepItems,
  {
    PK: userPk(primaryUserId),
    SK: assignSk(assignmentId),
    entityType: ENTITY.ASSIGNMENT,
    assignmentId,
    taskId,
    userId: primaryUserId,
    assignedBy: supporterId,
    active: true,
    status: 'ACTIVE',
    assignedAt: now,
    createdAt: now,
    updatedAt: now,
  },
  {
    // Append-only progress event — ProgressEvent has createdAt but no updatedAt.
    PK: userPk(primaryUserId),
    SK: progressSk(now, eventId),
    entityType: ENTITY.PROGRESS_EVENT,
    eventId,
    assignmentId,
    taskId,
    userId: primaryUserId,
    eventType: 'COMPLETED',
    timestamp: now,
    source: 'seed',
    metadata: { note: 'seeded sample event' },
    createdAt: now,
  },
  {
    // Metadata only — the binary itself would live in the S3 media bucket.
    PK: taskPk(taskId),
    SK: mediaSk(assetId),
    entityType: ENTITY.MEDIA_ASSET,
    assetId,
    taskId,
    stepId: stepItems[0].stepId,
    s3Key: `media/${taskId}/sample.png`,
    type: 'IMAGE',
    mimeType: 'image/png',
    ownerId: supporterId,
    size: 2048,
    createdAt: now,
    updatedAt: now,
  },
];

async function seed() {
  console.log(`Seeding table: ${TABLE}`);
  for (const item of items) {
    await client.send(new PutCommand({ TableName: TABLE, Item: item }));
    console.log(`  Put ${item.entityType}: ${item.PK} / ${item.SK}`);
  }
  console.log('Done.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
