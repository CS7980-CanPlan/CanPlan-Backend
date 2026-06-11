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

// Sample to-dos for local/dev, in the spirit of a real CanPlan user's task list.
// Each item only needs a title (required) and an optional description — taskId
// and createdAt are generated below. A few intentionally omit description to
// exercise the optional field.
const seedTasks = [
  { title: 'Buy groceries', description: 'Milk, eggs, and coffee' },
  {
    title: 'Call Zach about the weekend hike',
    description: 'Confirm carpool and trailhead meet-up time',
  },
  { title: 'Lunch with Siyi', description: 'New ramen place near campus, 12:30' },
  { title: 'Return Michael’s textbook', description: 'Algorithms book borrowed last month' },
  {
    title: 'Pick up Liecheng from the airport',
    description: 'Flight lands 7pm Saturday, Terminal B',
  },
  { title: 'Help Theodore move apartments', description: 'Saturday morning — bring the dolly' },
  { title: 'Submit CS7980 project proposal', description: 'Due Friday 11:59pm' },
  { title: 'Renew gym membership' },
  { title: 'Book a dentist appointment', description: 'Cleaning is overdue' },
  { title: 'Pay rent' },
  {
    title: 'Plan Siyi’s birthday dinner',
    description: 'Reserve a table for 6 and check dietary restrictions',
  },
  {
    title: 'Study group with Zach and Theodore',
    description: 'Review for the systems midterm — library room 204',
  },
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
