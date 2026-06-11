import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiProps {
  readonly envName: string;
  readonly createTaskFn: lambda.IFunction;
  readonly askAiFn: lambda.IFunction;
}

/** AppSync GraphQL API and its resolvers. */
export class Api extends Construct {
  public readonly graphqlUrl: string;
  public readonly apiKey: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { envName, createTaskFn, askAiFn } = props;

    const api = new appsync.GraphqlApi(this, 'CanPlanApi', {
      name: `canplan-api-${envName}`,
      schema: appsync.SchemaFile.fromAsset(path.join(__dirname, '../../../graphql/schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          // Using API key for the proof-of-concept.
          // TODO: Replace with Cognito user pool auth before launch.
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            expires: cdk.Expiration.after(cdk.Duration.days(365)),
          },
        },
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
