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
  readonly askAiFn: lambda.IFunction;
  readonly generateTaskStepsFn: lambda.IFunction;
}

/** AppSync GraphQL API and its resolvers. */
export class Api extends Construct {
  public readonly graphqlUrl: string;
  public readonly apiKey: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { envName, userPool, createTaskFn, askAiFn, generateTaskStepsFn } = props;

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

    // createTask mutation → Lambda data source
    const createTaskDs = api.addLambdaDataSource('CreateTaskDataSource', createTaskFn);
    createTaskDs.createResolver('CreateTaskResolver', {
      typeName: 'Mutation',
      fieldName: 'createTask',
    });

    // askAi mutation → Lambda data source
    const askAiDs = api.addLambdaDataSource('AskAiDataSource', askAiFn);
    askAiDs.createResolver('AskAiResolver', {
      typeName: 'Mutation',
      fieldName: 'askAi',
    });

    // generateTaskSteps mutation → Lambda data source
    const generateTaskStepsDs = api.addLambdaDataSource('GenerateTaskStepsDataSource', generateTaskStepsFn);
    generateTaskStepsDs.createResolver('GenerateTaskStepsResolver', {
      typeName: 'Mutation',
      fieldName: 'generateTaskSteps',
    });

    // healthCheck query — returns a static string, no data source needed
    const noneDs = api.addNoneDataSource('NoneDataSource');
    noneDs.createResolver('HealthCheckResolver', {
      typeName: 'Query',
      fieldName: 'healthCheck',
      requestMappingTemplate: appsync.MappingTemplate.fromString('{"version":"2018-05-29","payload":{}}'),
      responseMappingTemplate: appsync.MappingTemplate.fromString('"OK"'),
    });

    this.graphqlUrl = api.graphqlUrl;
    this.apiKey = api.apiKey ?? '';
  }
}
