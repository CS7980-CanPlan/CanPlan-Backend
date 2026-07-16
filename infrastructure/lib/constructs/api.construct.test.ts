import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Api } from './api.construct';

/** Synth the Api construct against stub Lambdas (the schema file is the real one). */
function synth(): Template {
  const stack = new Stack(new App(), 'TestStack');
  const userPool = new cognito.UserPool(stack, 'Pool');
  const stub = (id: string): lambda.IFunction =>
    new lambda.Function(stack, id, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
    });
  new Api(stack, 'Api', {
    envName: 'test',
    userPool,
    createTaskFn: stub('CreateTaskFn'),
    generateTaskStepsFn: stub('GenerateTaskStepsFn'),
    usersFn: stub('UsersFn'),
    categoriesFn: stub('CategoriesFn'),
    tasksFn: stub('TasksFn'),
    assignmentsFn: stub('AssignmentsFn'),
    mediaFn: stub('MediaFn'),
    adminFn: stub('AdminFn'),
    createAiTaskFn: stub('CreateAiTaskFn'),
    reportsFn: stub('ReportsFn'),
  });
  return Template.fromStack(stack);
}

/** Every (typeName, fieldName) pair that has an AppSync resolver in the template. */
function resolverFields(template: Template): Array<{ typeName: string; fieldName: string }> {
  return Object.values(template.findResources('AWS::AppSync::Resolver')).map((r) => ({
    typeName: r.Properties.TypeName as string,
    fieldName: r.Properties.FieldName as string,
  }));
}

/** The inlined GraphQL schema definition the API deploys. */
function schemaDefinition(template: Template): string {
  const schema = Object.values(template.findResources('AWS::AppSync::GraphQLSchema'))[0];
  return schema.Properties.Definition as string;
}

describe('Api construct — resolver bindings', () => {
  it('wires the organization-directory and support-link queries on the users data source', () => {
    const fields = resolverFields(synth());
    for (const fieldName of [
      'listAvailableOrganizations',
      'getOrganization',
      'listMySupportList',
      'listMySupportLinkHistory',
      'listMyOrganizationUsers',
      'selectPrimaryUser',
      'unselectPrimaryUser',
      'createUserProfile',
      'updateMyUserProfile',
    ]) {
      expect(fields).toContainEqual({
        typeName:
          fieldName.startsWith('list') || fieldName.startsWith('get') ? 'Query' : 'Mutation',
        fieldName,
      });
    }
  });

  it('keeps the SystemAdmin organization APIs on the admin data source', () => {
    const fields = resolverFields(synth());
    for (const fieldName of ['listAllOrganizations', 'adminListOrganizationUsers']) {
      expect(fields).toContainEqual({ typeName: 'Query', fieldName });
    }
    for (const fieldName of [
      'adminCreateOrganization',
      'adminUpdateOrganization',
      'adminDeleteOrganization',
      'adminSetUserOrganization',
    ]) {
      expect(fields).toContainEqual({ typeName: 'Mutation', fieldName });
    }
  });
});

describe('Api construct — schema authorization directives', () => {
  it('gates the organization directory to the PrimaryUser + SupportPerson Cognito groups', () => {
    const definition = schemaDefinition(synth());
    // Both directory fields carry the two-group directive (and never an API-key directive).
    const directoryDirective =
      /listAvailableOrganizations\(limit: Int, nextToken: String\): OrganizationConnection!\s*\n\s*@aws_cognito_user_pools\(cognito_groups: \["PrimaryUser", "SupportPerson"\]\)/;
    const getDirective =
      /getOrganization\(organizationId: ID!\): Organization\s*\n\s*@aws_cognito_user_pools\(cognito_groups: \["PrimaryUser", "SupportPerson"\]\)/;
    expect(definition).toMatch(directoryDirective);
    expect(definition).toMatch(getDirective);
    // The directive immediately follows each field (asserted above), so API-key access is not
    // among the field's auth modes — only healthCheck carries @aws_api_key.
    expect(definition.match(/@aws_api_key/g)).toHaveLength(1);
  });

  it('gates current support relationships and support history to SupportPerson', () => {
    const definition = schemaDefinition(synth());
    for (const field of ['listMySupportList', 'listMySupportLinkHistory']) {
      const gated = new RegExp(
        `${field}\\(limit: Int, nextToken: String\\): SupportLinkConnection!\\s*\\n` +
          '\\s*@aws_cognito_user_pools\\(cognito_groups: \\["SupportPerson"\\]\\)',
      );
      expect(definition).toMatch(gated);
    }
  });

  it('leaves the SystemAdmin-only organization fields gated to SystemAdmin, unchanged', () => {
    const definition = schemaDefinition(synth());
    expect(definition).toMatch(
      /listAllOrganizations\(limit: Int, nextToken: String\): OrganizationConnection!\s*\n\s*@aws_cognito_user_pools\(cognito_groups: \["SystemAdmin"\]\)/,
    );
    for (const field of [
      'adminCreateOrganization',
      'adminUpdateOrganization',
      'adminDeleteOrganization',
      'adminSetUserOrganization',
      'adminListOrganizationUsers',
    ]) {
      const gated = new RegExp(
        `${field}\\([\\s\\S]*?\\):[^\\n]*?(?:\\n\\s*)?` +
          '@aws_cognito_user_pools\\(cognito_groups: \\["SystemAdmin"\\]\\)',
      );
      expect(definition).toMatch(gated);
    }
  });

  it('exposes only safe Organization fields (no internal storage/operational attributes)', () => {
    const definition = schemaDefinition(synth());
    const organizationType = definition.match(/type Organization \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(organizationType).toContain('organizationId: ID!');
    expect(organizationType).toContain('name: String!');
    expect(organizationType).toContain('createdAt: String!');
    expect(organizationType).toContain('updatedAt: String!');
    for (const internal of ['PK', 'SK', 'entityType', 'deleting']) {
      expect(organizationType).not.toMatch(new RegExp(`^\\s*${internal}\\s*:`, 'm'));
    }
  });

  it('never exposes the internal organizationMembershipId or SupportLink snapshot fields in GraphQL', () => {
    const definition = schemaDefinition(synth());
    expect(definition).not.toContain('organizationMembershipId');
    expect(definition).not.toContain('supporterOrganizationMembershipId');
    expect(definition).not.toContain('primaryUserOrganizationMembershipId');
    expect(definition).not.toContain('revokedReason');
  });
});
