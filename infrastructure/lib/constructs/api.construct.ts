import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiProps {
  readonly envName: string;
  /** Cognito User Pool used as the API's primary authorizer. */
  readonly userPool: cognito.IUserPool;
  readonly createTaskFn: lambda.IFunction;
  readonly generateTaskStepsFn: lambda.IFunction;
  /** Domain Lambdas — each backs several fields, routed internally by fieldName. */
  readonly usersFn: lambda.IFunction;
  readonly categoriesFn: lambda.IFunction;
  readonly tasksFn: lambda.IFunction;
  readonly assignmentsFn: lambda.IFunction;
  readonly mediaFn: lambda.IFunction;
  readonly adminFn: lambda.IFunction;
}

/** A (typeName, fieldName) pair wired to a Lambda data source. */
interface FieldBinding {
  readonly typeName: 'Query' | 'Mutation';
  readonly fieldName: string;
}

/** AppSync GraphQL API and its resolvers. */
export class Api extends Construct {
  public readonly graphqlUrl: string;
  public readonly apiKey: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { envName, userPool } = props;

    const api = new appsync.GraphqlApi(this, 'CanPlanApi', {
      name: `canplan-api-${envName}`,
      schema: appsync.SchemaFile.fromAsset(path.join(__dirname, '../../../graphql/schema.graphql')),
      authorizationConfig: {
        // Cognito User Pool is the primary authorizer — frontend clients send a
        // user's JWT in the Authorization header.
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        // API key is kept as a secondary mode for the unauthenticated
        // healthCheck query and proof-of-concept tooling.
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.API_KEY,
            apiKeyConfig: {
              expires: cdk.Expiration.after(cdk.Duration.days(365)),
            },
          },
        ],
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ERROR,
      },
      xrayEnabled: false,
    });

    // Wire a Lambda to one or more (typeName, fieldName) resolvers via a single
    // data source. Domain Lambdas route on info.fieldName, so they back several fields.
    const wire = (dsId: string, fn: lambda.IFunction, bindings: FieldBinding[]): void => {
      const ds = api.addLambdaDataSource(dsId, fn);
      for (const { typeName, fieldName } of bindings) {
        ds.createResolver(`${fieldName}Resolver`, { typeName, fieldName });
      }
    };

    // createTask — dedicated Lambda (writes a task + its steps atomically).
    wire('CreateTaskDataSource', props.createTaskFn, [
      { typeName: 'Mutation', fieldName: 'createTask' },
    ]);

    // generateTaskSteps — Bedrock KB + RAG.
    wire('GenerateTaskStepsDataSource', props.generateTaskStepsFn, [
      { typeName: 'Mutation', fieldName: 'generateTaskSteps' },
    ]);

    // UserProfile + SupportLink.
    wire('UsersDataSource', props.usersFn, [
      { typeName: 'Mutation', fieldName: 'createUserProfile' },
      { typeName: 'Mutation', fieldName: 'updateMyUserProfile' },
      { typeName: 'Mutation', fieldName: 'createSupportLink' },
      { typeName: 'Query', fieldName: 'getUserProfile' },
      { typeName: 'Query', fieldName: 'listUsersByOrganization' },
      { typeName: 'Query', fieldName: 'listPrimaryUsersBySupporter' },
    ]);

    // User-owned task categories (private to the caller — owner derived from identity).
    wire('CategoriesDataSource', props.categoriesFn, [
      { typeName: 'Mutation', fieldName: 'createCategory' },
      { typeName: 'Mutation', fieldName: 'updateCategory' },
      { typeName: 'Mutation', fieldName: 'deleteCategory' },
      { typeName: 'Query', fieldName: 'listMyCategories' },
    ]);

    // Task reads + edits + standalone step creation, update, delete, and reordering.
    wire('TasksDataSource', props.tasksFn, [
      { typeName: 'Mutation', fieldName: 'updateTask' },
      { typeName: 'Mutation', fieldName: 'createTaskStep' },
      { typeName: 'Mutation', fieldName: 'updateTaskStep' },
      { typeName: 'Mutation', fieldName: 'deleteTaskStep' },
      { typeName: 'Mutation', fieldName: 'reorderTaskSteps' },
      { typeName: 'Mutation', fieldName: 'deleteTask' },
      { typeName: 'Query', fieldName: 'getTask' },
      { typeName: 'Query', fieldName: 'listTaskSteps' },
      { typeName: 'Query', fieldName: 'listTasksByOwner' },
      { typeName: 'Query', fieldName: 'listTasksByCategory' },
    ]);

    // Assignments + per-assignment step snapshots.
    wire('AssignmentsDataSource', props.assignmentsFn, [
      { typeName: 'Mutation', fieldName: 'createAssignment' },
      { typeName: 'Mutation', fieldName: 'updateAssignmentStatus' },
      { typeName: 'Mutation', fieldName: 'setAssignmentStepCompletion' },
      { typeName: 'Mutation', fieldName: 'deleteAssignment' },
      { typeName: 'Query', fieldName: 'listAssignmentsForUser' },
      { typeName: 'Query', fieldName: 'listAssignmentSteps' },
    ]);

    // Media assets — presigned upload + download URLs, metadata registration, listing.
    wire('MediaDataSource', props.mediaFn, [
      { typeName: 'Mutation', fieldName: 'createMediaUploadUrl' },
      { typeName: 'Mutation', fieldName: 'createTaskCoverImageUploadUrl' },
      { typeName: 'Mutation', fieldName: 'createMediaAsset' },
      { typeName: 'Mutation', fieldName: 'deleteMediaAsset' },
      { typeName: 'Query', fieldName: 'getMediaDownloadUrl' },
      { typeName: 'Query', fieldName: 'listMediaForTask' },
    ]);

    // SystemAdmin-only list-all APIs (the schema also gates these to the SystemAdmin
    // group via @aws_cognito_user_pools; the Lambda re-checks as defense-in-depth).
    wire('AdminDataSource', props.adminFn, [
      { typeName: 'Query', fieldName: 'listAllUsers' },
      { typeName: 'Query', fieldName: 'listAllTasks' },
    ]);

    // healthCheck query — returns a static string, no data source needed
    const noneDs = api.addNoneDataSource('NoneDataSource');
    noneDs.createResolver('HealthCheckResolver', {
      typeName: 'Query',
      fieldName: 'healthCheck',
      requestMappingTemplate: appsync.MappingTemplate.fromString(
        '{"version":"2018-05-29","payload":{}}',
      ),
      responseMappingTemplate: appsync.MappingTemplate.fromString('"OK"'),
    });

    this.graphqlUrl = api.graphqlUrl;
    this.apiKey = api.apiKey ?? '';
  }
}
