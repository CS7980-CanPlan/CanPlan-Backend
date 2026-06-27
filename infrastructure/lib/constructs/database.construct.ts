import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DatabaseProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod', or a personal owner). */
  readonly envName: string;
  /** Destroyable environments use DESTROY; dev/prod use RETAIN to protect data. */
  readonly isDestroyable: boolean;
}

/**
 * Single-table DynamoDB store for CanPlan. Every entity (UserProfile, SupportLink,
 * Category, Task, TaskStep, Assignment, AssignmentStep, MediaAsset, Report) lives in
 * one table keyed by a composite PK/SK plus an `entityType` discriminator — see
 * src/shared/keys.ts for the item-key conventions and the access patterns each GSI
 * serves. The table name keeps the historical CanPlanTasks-<env> pattern.
 */
export class Database extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    const { envName, isDestroyable } = props;

    this.table = new dynamodb.Table(this, 'CanPlanTable', {
      tableName: `CanPlanTasks-${envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Destroyable environments delete with the stack. dev / prod retain data.
      removalPolicy: isDestroyable ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    // supporterIndex — all primary users managed by a given support person.
    // SupportLink items carry supporterId + userId; no other entity has supporterId.
    this.table.addGlobalSecondaryIndex({
      indexName: 'supporterIndex',
      partitionKey: { name: 'supporterId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // primaryUserSupportLinkIndex — SupportLinks by the PRIMARY user they manage. Keyed on
    // userId (a SupportLink's mirror of primaryUserId) + supporterId. supporterIndex finds a
    // supporter's links; this finds the links where a given user is the primary, which full
    // user deletion needs. Sparse to SupportLink (only it carries supporterId).
    this.table.addGlobalSecondaryIndex({
      indexName: 'primaryUserSupportLinkIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'supporterId', type: dynamodb.AttributeType.STRING },
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

    // taskCategoryIndex — all tasks in one owner's category, newest-sortable by
    // createdAt. Keyed on the denormalized taskCategoryKey (<ownerId>#<categoryId>),
    // which only Task items carry — so this GSI is sparse and listTasksByCategory
    // needs no entityType filter (unlike taskOwnerIndex, whose ownerId is shared).
    this.table.addGlobalSecondaryIndex({
      indexName: 'taskCategoryIndex',
      partitionKey: { name: 'taskCategoryKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // entityTypeIndex — general-purpose index for SystemAdmin/admin listing APIs:
    // list every item of one entityType (UserProfile, Task, Assignment, MediaAsset,
    // …) newest-first, without scanning the table. Every item carries entityType +
    // createdAt. NOTE: partitioning by entityType concentrates each type on one
    // partition (a hot-partition trade-off acceptable for low-volume admin/debug
    // reads — see follow-up notes).
    this.table.addGlobalSecondaryIndex({
      indexName: 'entityTypeIndex',
      partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
