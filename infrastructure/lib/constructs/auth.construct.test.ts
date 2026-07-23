import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Auth } from './auth.construct';

function synth() {
  const stack = new Stack(new App(), 'TestStack', {
    env: { account: '111111111111', region: 'ca-central-1' },
  });
  new Auth(stack, 'Auth', { envName: 'test', isDestroyable: true });
  return Template.fromStack(stack);
}

describe('Auth construct — Post Confirmation group assignment', () => {
  it('creates a public frontend client with USER_PASSWORD_AUTH and SRP enabled', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      RefreshTokenValidity: 5 * 24 * 60,
      TokenValidityUnits: {
        RefreshToken: 'minutes',
      },
      ExplicitAuthFlows: Match.arrayWith([
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
      ]),
    });
  });

  it('grants only cognito-idp:AdminAddUserToGroup', () => {
    synth().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cognito-idp:AdminAddUserToGroup',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('scopes the policy to a generated ARN, not a GetAtt/Ref of the User Pool (no circular dependency)', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const stmt = Object.values(policies)
      .flatMap(
        (p) =>
          p.Properties.PolicyDocument.Statement as Array<{ Action: string; Resource: unknown }>,
      )
      .find((s) => s.Action === 'cognito-idp:AdminAddUserToGroup');

    expect(stmt).toBeDefined();

    // The generated ARN ends in :userpool/* (account+region scoped wildcard).
    const serialized = JSON.stringify(stmt!.Resource);
    expect(serialized).toContain(':userpool/*');

    // It must NOT point back at the User Pool resource — no Fn::GetAtt (which is how
    // userPoolArn resolves) and no Ref to the pool's logical id. Pseudo-param Refs
    // (AWS::Partition/Region/AccountId) from formatArn are fine and expected.
    const poolLogicalId = Object.keys(template.findResources('AWS::Cognito::UserPool'))[0];
    expect(serialized).not.toContain('Fn::GetAtt');
    expect(serialized).not.toContain(poolLogicalId);
  });

  it('wires the Post Confirmation Lambda trigger into the User Pool', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: {
        PostConfirmation: Match.anyValue(),
      },
    });
  });
});
