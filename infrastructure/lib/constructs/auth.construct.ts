import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface AuthProps {
  /** Environment name (e.g. 'sandbox', 'dev', 'prod') — namespaces the pool. */
  readonly envName: string;
  /** Sandbox tears down cleanly (DESTROY); dev/prod RETAIN to protect users. */
  readonly isSandbox: boolean;
}

/** Role groups seeded in the user pool — authorization rules come in a later milestone. */
const ROLE_GROUPS = ['PrimaryUser', 'SupportPerson', 'OrganizationAdmin', 'SystemAdmin'] as const;

/**
 * Amazon Cognito authentication for CanPlan: a User Pool with email-based
 * sign-in, a public (no-secret) client for the mobile app and web portal, and
 * the initial role groups. The pool is wired into AppSync as the API's primary
 * authorizer in `api.construct.ts`.
 */
export class Auth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    const { envName, isSandbox } = props;

    this.userPool = new cognito.UserPool(this, 'CanPlanUserPool', {
      userPoolName: `CanPlan-${envName}-UserPool`,
      // Sign in with email; let users register themselves.
      signInAliases: { email: true },
      selfSignUpEnabled: true,
      // Verify the email on sign-up and allow password reset by email.
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      // Reasonable for development without being weak: 8+ chars, mixed case + digit.
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // Sandbox: destroy with the stack. dev / prod: retain to protect user accounts.
      removalPolicy: isSandbox ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    // Frontend client (mobile app + web portal). Public clients can't keep a
    // secret, so none is generated; SRP keeps the password off the wire.
    this.userPoolClient = this.userPool.addClient('CanPlanUserPoolClient', {
      userPoolClientName: `CanPlan-${envName}-UserPoolClient`,
      generateSecret: false,
      authFlows: { userSrp: true },
    });

    // Seed the role taxonomy. Group-based resolver authorization is a later issue.
    for (const groupName of ROLE_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `${groupName}Group`, {
        userPoolId: this.userPool.userPoolId,
        groupName,
      });
    }
  }
}
