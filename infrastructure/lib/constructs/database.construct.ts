import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DatabaseProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod') — namespaces the table. */
  readonly envName: string;
  /** Sandbox tears down cleanly (DESTROY); dev/prod RETAIN to protect data. */
  readonly isSandbox: boolean;
}

/**
 * Single-table DynamoDB store for CanPlan. Every entity (UserProfile, SupportLink,
 * Task, TaskStep, Assignment, ProgressEvent, MediaAsset, Report) lives in one table
 * keyed by a composite PK/SK plus an `entityType` discriminator — see
 * src/shared/keys.ts for the item-key conventions and the access patterns each GSI
 * serves. The table name keeps the historical CanPlanTasks-<env> pattern.
 */
export class Database extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    const { envName, isSandbox } = props;

    this.table = new dynamodb.Table(this, 'CanPlanTable', {
      tableName: `CanPlanTasks-${envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Sandbox: destroy with the stack. dev / prod: retain to prevent data loss.
      removalPolicy: isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    // supporterIndex — all primary users managed by a given support person.
    // SupportLink items carry supporterId + userId; no other entity has supporterId.
    this.table.addGlobalSecondaryIndex({
      indexName: 'supporterIndex',
      partitionKey: { name: 'supporterId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // orgIndex — all users in an organization. UserProfile items carry organizationId.
    // Lightweight roster projection: just enough to render a list (name + role).
    this.table.addGlobalSecondaryIndex({
      indexName: 'orgIndex',
      partitionKey: { name: 'organizationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['displayName', 'role'],
    });

    // taskOwnerIndex — all task templates created by a support person / org admin,
    // newest-sortable by createdAt. (MediaAsset items also carry ownerId, so the
    // listTasksByOwner resolver filters to Task rows by entityType.)
    this.table.addGlobalSecondaryIndex({
      indexName: 'taskOwnerIndex',
      partitionKey: { name: 'ownerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
