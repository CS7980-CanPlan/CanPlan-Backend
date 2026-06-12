# CanPlan 2.0 — Backend

Cloud backend for CanPlan 2.0, a task management app. This starter repo wires together AWS Lambda, DynamoDB, and AppSync GraphQL using AWS CDK in TypeScript.

---

## Tech Stack

| Layer                  | Service                                  |
| ---------------------- | ---------------------------------------- |
| Infrastructure as Code | AWS CDK (TypeScript)                     |
| API                    | AWS AppSync (GraphQL)                    |
| Compute                | AWS Lambda (Node.js 20)                  |
| Database               | Amazon DynamoDB                          |
| File Storage           | Amazon S3 (provisioned, ready for media) |
| Observability          | Amazon CloudWatch Logs                   |
| CI/CD                  | GitHub Actions                           |
| Testing                | Jest + ts-jest                           |
| Code Quality           | ESLint + Prettier                        |

---

## Directory Structure

```
canplan-backend/
├── .github/
│   └── workflows/
│       └── ci.yml              # Lint, test, build on every PR and push
├── docs/
│   └── API.md                  # Frontend API reference (operations, examples)
├── graphql/
│   └── schema.graphql          # AppSync GraphQL schema
├── infrastructure/
│   ├── bin/
│   │   └── app.ts              # CDK entry point
│   └── lib/
│       ├── canplan-backend-stack.ts   # Composition: wires constructs + outputs
│       └── constructs/
│           ├── database.construct.ts  # DynamoDB table
│           ├── storage.construct.ts   # S3 media bucket
│           ├── auth.construct.ts      # Cognito User Pool, client, role groups
│           ├── functions.construct.ts # Lambda functions + IAM
│           ├── api.construct.ts       # AppSync GraphQL API + resolvers
│           └── ai.construct.ts        # Bedrock model config
├── scripts/
│   └── seed-dev.ts             # Seed sample tasks into DynamoDB
├── src/
│   ├── lambdas/
│   │   ├── createTask/
│   │   │   ├── handler.ts      # Lambda function logic
│   │   │   └── handler.test.ts # Unit tests
│   │   └── askAi/
│   │       ├── handler.ts      # Bedrock (Converse) Lambda logic
│   │       └── handler.test.ts # Unit tests
│   └── shared/
│       ├── dynamodb.ts         # Shared DynamoDB client
│       ├── bedrock.ts          # Shared Bedrock client + model config
│       ├── response.ts         # Shared error types
│       └── types.ts            # Shared TypeScript types
├── .env.example
├── cdk.json
├── jest.config.js
├── package.json
├── tsconfig.json              # Editor/type-check config (includes tests)
├── tsconfig.build.json        # Build config (emits, excludes tests)
└── tsconfig.test.json         # ts-jest config (adds jest types)
```

---

## Local Setup

**Prerequisites**

- Node.js 20+
- AWS CLI v2, authenticated via SSO (see [Deploying to an AWS Sandbox](#deploying-to-an-aws-sandbox))
- No global CDK install needed — `aws-cdk` is a dev dependency, so the `npm run cdk:*` scripts use the local version

```bash
# 1. Clone the repo
git clone <repo-url>
cd canplan-backend

# 2. Install dependencies
npm install

# 3. Copy environment variables
cp .env.example .env
# Edit .env — set the region and (after deploy) the API URL/key.
# Do NOT put AWS credentials here; this project authenticates via AWS SSO.
```

---

## Commands

```bash
# Run linter
npm run lint

# Run unit tests
npm test

# Build TypeScript (output → dist/)
npm run build

# Format all source files
npm run format

# Preview the CloudFormation template (no AWS calls)
npm run cdk:synth

# Deploy the dev stack to AWS
npm run cdk:deploy:dev

# Tear down the dev stack
npm run cdk:destroy:dev

# Deploy / tear down the sandbox stack (clean teardown — see below)
npm run cdk:deploy:sandbox
npm run cdk:destroy:sandbox
```

---

## Deploying to AWS (First Time)

This project authenticates via **AWS SSO** — no long-lived IAM user keys.

1. **Log in to the account** (profile name comes from your AWS SSO config):

   ```bash
   aws sso login --profile canplan-sandbox
   export AWS_PROFILE=canplan-sandbox
   ```

   > 💡 **Set `AWS_PROFILE` once instead of passing `--profile` every time.**
   > CDK and the AWS CLI don't remember a profile between commands, so without
   > this they fall back to the `default` profile and you'd have to append
   > `--profile canplan-sandbox` to every `cdk` / `aws` call. The `export` above
   > sets it for the **whole terminal session**, so subsequent commands need no
   > flag. It only lasts for that terminal — to make it permanent, add
   > `export AWS_PROFILE=canplan-sandbox` to your `~/.zshrc`, or use
   > [direnv](https://direnv.net/) with a project-local `.envrc` so it activates
   > automatically in this repo.

2. **Verify you're authenticated against the right account:**

   ```bash
   aws sts get-caller-identity
   ```

3. **Bootstrap CDK** — one-time per account + region:

   ```bash
   npx cdk bootstrap
   ```

4. **Deploy** — see [Deploying to an AWS Sandbox](#deploying-to-an-aws-sandbox) below
   for the full env breakdown:

   ```bash
   npm run cdk:deploy:sandbox
   ```

   CDK will print the AppSync API URL, API key, and the Cognito values after a
   successful deploy — see [Authentication setup](#authentication-setup).

---

## Deploying to an AWS Sandbox

This project targets a **shared org/company AWS sandbox account** — a real account
with cost and cleanup guardrails. The stack is configured so a sandbox deploy
tears down completely, leaving nothing behind to incur cost or block the next
deploy on a name collision.

### How sandbox mode works

The CDK entry point ([infrastructure/bin/app.ts](infrastructure/bin/app.ts))
reads the `env` context value and treats **only `env=sandbox`** as a sandbox.
Sandbox mode is passed into the stack as `isSandbox`, which controls the removal
policies in
[infrastructure/lib/canplan-backend-stack.ts](infrastructure/lib/canplan-backend-stack.ts):

| Resource                            | Sandbox (`env=sandbox`)            | dev / prod                     |
| ----------------------------------- | ---------------------------------- | ------------------------------ |
| DynamoDB `CanPlanTasks-<env>` table | `DESTROY` — deleted with the stack | `RETAIN` — survives teardown   |
| S3 media bucket                     | `DESTROY` + auto-empty on teardown | `RETAIN`                       |
| Cognito `CanPlan-<env>-UserPool`    | `DESTROY` — deleted with the stack | `RETAIN` — keeps user accounts |
| Lambda / AppSync / log groups       | Deleted with the stack             | Deleted with the stack         |

> ⚠️ Only `env=sandbox` tears down its data. **`dev` and `prod` both RETAIN** the
> DynamoDB table, S3 bucket, and Cognito User Pool — a `cdk destroy` there leaves
> those resources behind (and they'll block a redeploy on the same name until
> removed manually).

### Deploy

```bash
# 1. Authenticate to the sandbox account via SSO
aws sso login --profile canplan-sandbox
export AWS_PROFILE=canplan-sandbox

# 2. Region is ca-central-1 (set in .env / .env.example)

# 3. Bootstrap once per account + region
npx cdk bootstrap

# 4. Deploy the sandbox stack
npm run cdk:deploy:sandbox
```

### Tear down (do this when you're done to avoid lingering resources)

```bash
npm run cdk:destroy:sandbox
```

Because sandbox resources use `DESTROY` removal policies, this leaves a clean
account — you can immediately redeploy without name conflicts.

### Notes

- **Lambda bundling needs no Docker.** `esbuild` is a dev dependency, so
  `NodejsFunction` bundles locally. (Without it, CDK falls back to Docker, which
  fails if the daemon isn't running.)
- **Sandbox credentials often rotate.** If a deploy fails with an expired-token
  error, refresh your SSO session (`aws sso login --profile canplan-sandbox`) and
  retry.
- **Multiple environments coexist.** Every resource is namespaced by `env`
  (`CanPlanTasks-<env>`, `canplan-createTask-<env>`, `canplan-api-<env>`,
  `canplan-media-<env>-…`, `CanPlan-<env>-UserPool`), so `sandbox`, `dev`, and
  `prod` can all be deployed into the same account at once without name collisions.

---

## Authentication setup

The API is authorized by an **Amazon Cognito User Pool** (the API key is kept only
as a secondary mode for the unauthenticated `healthCheck` query). Frontend clients
authenticate a user against the pool, then send the user's JWT in the
`Authorization` header on every GraphQL request.

After a deploy, CDK prints the values the mobile app and web portal need to
configure their Cognito/AppSync client:

| CDK output         | What it is                       | Frontend uses it for                                            |
| ------------------ | -------------------------------- | --------------------------------------------------------------- |
| `UserPoolId`       | Cognito User Pool ID             | Initializing the auth client (sign-up, sign-in, password reset) |
| `UserPoolClientId` | App client ID (no client secret) | The public client the app authenticates through                 |
| `AwsRegion`        | Region the pool lives in         | Required to construct the Cognito endpoint                      |
| `GraphQLApiUrl`    | AppSync GraphQL endpoint         | Where queries/mutations are sent                                |

```bash
# Re-print the outputs for an already-deployed stack:
aws cloudformation describe-stacks \
  --stack-name canplan-backend-sandbox \
  --query 'Stacks[0].Outputs' --output table
```

The pool is configured for **email-based sign-in** with **self sign-up**, **email
verification**, and **password reset by email**. Four role groups are seeded —
`PrimaryUser`, `SupportPerson`, `OrganizationAdmin`, and `SystemAdmin` — for
future group-based authorization (not yet enforced on resolvers).

---

## GitHub Actions Setup

One workflow is included:

| Workflow | Trigger             | Purpose             |
| -------- | ------------------- | ------------------- |
| `ci.yml` | Push / PR to `main` | Lint → Test → Build |

CI runs lint, tests, and a TypeScript build check — it does **not** touch AWS, so
no repository secrets are required.

### Deploys

There is no automated deploy workflow. Because this project authenticates via
**AWS SSO** (no long-lived keys for GitHub Actions to use), deploys are run from
your machine — see [Deploying to an AWS Sandbox](#deploying-to-an-aws-sandbox).

> Want CI/CD deploys? Add a workflow using GitHub OIDC (`role-to-assume`)
> federation rather than static access keys.

---

## What Is Included

- DynamoDB table `CanPlanTasks-<env>` with pay-per-request billing
- S3 bucket for future media storage
- `createTask` Lambda with input validation
- `askAi` Lambda calling Claude Sonnet 4.6 on Amazon Bedrock via the Converse API — inference runs in `us-east-1` (the US inference profile `us.anthropic.claude-sonnet-4-6`) while the rest of the stack stays in `ca-central-1`; region/model are configurable via `BEDROCK_REGION` / `BEDROCK_MODEL_ID`
- AppSync GraphQL API with `createTask` + `askAi` mutations and a `healthCheck` query
- Amazon Cognito User Pool (email sign-in, self sign-up, email verification, password reset) authorizing the API, with `PrimaryUser` / `SupportPerson` / `OrganizationAdmin` / `SystemAdmin` role groups — see [Authentication setup](#authentication-setup)
- CloudWatch log retention (7 days)
- Jest unit tests with DynamoDB mocked
- ESLint + Prettier configuration
- GitHub Actions CI workflow (lint, test, build)
- Dev seed script (`scripts/seed-dev.ts`)

## What Is Not Included Yet

- **Group-based authorization** — Cognito User Pool auth and role groups exist, but resolvers do not yet enforce per-group permissions or detailed `@auth` rules.
- **Read queries** — `getTask` and `listTasks` resolvers are not built yet.
- **Offline sync** — planned for a future milestone.
- **PDF reports** — planned for a future milestone.
- **Frontend** — this repo is backend only.
