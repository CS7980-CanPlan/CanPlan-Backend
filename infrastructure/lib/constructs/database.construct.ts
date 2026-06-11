import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DatabaseProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod') — namespaces the table. */
  readonly envName: string;
  /** Sandbox tears down cleanly (DESTROY); dev/prod RETAIN to protect data. */
  readonly isSandbox: boolean;
}

/** DynamoDB tables for CanPlan. */
export class Database extends Construct {
  public readonly tasksTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    const { envName, isSandbox } = props;

    this.tasksTable = new dynamodb.Table(this, 'CanPlanTasksTable', {
      tableName: `CanPlanTasks-${envName}`,
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Sandbox: destroy with the stack. dev / prod: retain to prevent data loss.
      removalPolicy: isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });
  }
}
