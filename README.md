# CanPlan Backend

AWS CDK backend for CanPlan. It deploys an AppSync GraphQL API, Cognito auth,
DynamoDB task storage, S3 buckets, Lambda resolvers, and a Bedrock Knowledge Base
backed by OpenSearch Serverless.

## Current API

The GraphQL schema is in [graphql/schema.graphql](graphql/schema.graphql) and the
frontend-facing reference is [docs/API.md](docs/API.md).

CanPlan uses a **single DynamoDB table** (`CanPlanTasks-<env>`, composite `PK`/`SK`)
for every entity — UserProfile, SupportLink, Category, Task, TaskStep, Assignment,
AssignmentStep, MediaAsset, Report. The item-key conventions live in
[src/shared/keys.ts](src/shared/keys.ts).

| Operation(s) | Type | Backing service |
| --------- | ---- | --------------- |
| `healthCheck` | Query | AppSync none data source |
| `createTask` | Mutation | `canplan-createTask-<env>` Lambda (writes Task + steps atomically) |
| `createUserProfile`, `updateMyUserProfile`, `createSupportLink`, `getUserProfile`, `listUsersByOrganization`, `listPrimaryUsersBySupporter` | Query/Mutation | `canplan-users-<env>` Lambda + DynamoDB (createUserProfile also creates the user's default category atomically) |
| `createCategory`, `updateCategory`, `deleteCategory`, `listMyCategories` | Query/Mutation | `canplan-categories-<env>` Lambda + DynamoDB (owner derived from the Cognito identity; deleteCategory reparents tasks to the default category) |
| `getTask`, `listTaskSteps`, `listTasksByOwner`, `listTasksByCategory`, `updateTask`, `createTaskStep`, `updateTaskStep`, `deleteTaskStep`, `reorderTaskSteps`, `deleteTask` | Query/Mutation | `canplan-tasks-<env>` Lambda + DynamoDB + S3 (media cleanup) |
| `createAssignment`, `updateAssignmentStatus`, `setAssignmentStepCompletion`, `deleteAssignment`, `listAssignmentsForUser`, `listAssignmentSteps` | Query/Mutation | `canplan-assignments-<env>` Lambda + DynamoDB |
| `createMediaUploadUrl`, `createTaskCoverImageUploadUrl`, `createMediaAsset`, `deleteMediaAsset`, `getMediaDownloadUrl`, `listMediaForTask` | Query/Mutation | `canplan-media-<env>` Lambda + DynamoDB + S3 media bucket (presigned upload/download, cover images, cascade delete) |
| `listAllUsers`, `listAllTasks` | Query | `canplan-admin-<env>` Lambda + DynamoDB `entityTypeIndex` (SystemAdmin only, paginated) |
| `generateTaskSteps` | Mutation | `canplan-generateTaskSteps-<env>` Lambda + Bedrock KB RAG |

Domain Lambdas back several fields each, routing on the resolved GraphQL field
(`event.info.fieldName`). AI usage is through `generateTaskSteps`: retrieve relevant
corpus passages from the Knowledge Base, then call Bedrock Converse to generate
cited task steps.

Default authorization is Cognito User Pool — frontend clients send a signed-in
user's JWT. A few fields carry auth directives; see [Authentication](#authentication).

## Authentication

AppSync uses **Cognito User Pool** auth as the default for every field — clients send
a signed-in user's **ID token (JWT)** in the `Authorization` header. An API key is
configured as a secondary mode, but it only works on fields that explicitly opt in.

The only fields with auth directives:

| Field | Auth |
| ----- | ---- |
| `healthCheck` | `@aws_api_key @aws_cognito_user_pools` — the API key **or** any signed-in user |
| `listAllUsers`, `listAllTasks` | `@aws_cognito_user_pools(cognito_groups: ["SystemAdmin"])` — SystemAdmin group only |
| everything else | default Cognito User Pool (any signed-in user) |

The frontend needs the `UserPoolId` and `UserPoolClientId` deploy outputs to run the
Cognito sign-in flow. **Task and Category operations are owner-scoped** — every
`getTask`/`list*`/`updateTask`/`deleteTask`/`*TaskStep`/`reorderTaskSteps` and all category
operations require the caller's Cognito `sub` to equal the resource's `ownerId` (strict
self-ownership via [src/shared/authz.ts](src/shared/authz.ts); a foreign owner is rejected).
Per-role/delegated authorization (e.g. a support person acting for a primary user) and
owner checks on the remaining profile/assignment/support-link operations are **not enforced
yet**.

Self-registered users who verify their email and confirm sign-up are automatically
added to the `PrimaryUser` group — a Cognito Post Confirmation trigger
(`canplan-postConfirmation-<env>` Lambda) assigns the group on the
`PostConfirmation_ConfirmSignUp` event.

**Cognito group membership is the authorization source of truth.** `UserProfile.role`
is a server-derived projection of it: the base groups `PrimaryUser` / `SupportPerson` /
`OrganizationAdmin` map to `PRIMARY_USER` / `SUPPORT_PERSON` / `ORG_ADMIN`, and the
mapping is mutually exclusive (zero or multiple base groups is rejected). `SystemAdmin`
is an independent elevated group, not a `UserRole`. Accordingly, `createUserProfile`
creates only the **caller's own** profile: `userId` (Cognito `sub`), `email`, and `role`
are taken from the authenticated session — clients send only `displayName`,
`organizationId`, and `accessibilitySettings` (`CreateMyUserProfileInput`); `displayName`
is required.

`createUserProfile` also creates the user's **default category** (`name: "No Category"`,
`isDefault: true`) — a real Category row with its own UUID — in the same transaction, and
stores its id on the profile (`defaultCategoryId`). Every Task belongs to a real Category;
one created without an explicit `categoryId` is filed under this default. The default
cannot be renamed or deleted. **Categories are private to their owner:** `createCategory`,
`updateCategory`, `deleteCategory`, and `listMyCategories` all derive the owner from the
Cognito identity and never accept a client-supplied owner id. Likewise `createTask` derives
the task owner from the identity. Before using a profile's default category, runtime code
strongly reads and verifies the profile pointer, owner, exact `No Category` name,
`isDefault: true`, and that it is not being deleted; an invalid legacy row fails clearly
until the migration is applied.

Standalone `createTaskStep` is append-only and concurrency-safe. Task metadata
(`stepCount`, `stepVersion`, `nextStepOrder`) serializes appends: at most 99 steps are
allowed, concurrent calls from the same state yield exactly one success, and the other
callers receive a retryable validation error after reloading the task steps. Deleting a step
does not reclaim its order; `reorderTaskSteps` normalizes orders atomically.

## Region Layout

The app deploys two CDK stacks with `--all`.

| Region | Stack | Main resources |
| ------ | ----- | -------------- |
| `CANPLAN_BACKEND_REGION` default `ca-central-1` | `canplan-backend-<env>` | AppSync, Cognito, single-table DynamoDB `CanPlanTasks-<env>`, media S3 bucket, `createTask` + domain Lambdas (`users`/`categories`/`tasks`/`assignments`/`media`/`admin`) + `generateTaskSteps` Lambda, `postConfirmation` Cognito trigger Lambda, CloudWatch logs |
| `CANPLAN_KNOWLEDGE_BASE_REGION` default `us-east-1` | `canplan-knowledge-base-<env>` | Bedrock Knowledge Base, S3 corpus bucket, Bedrock S3 data source, OpenSearch Serverless vector collection/index |

`generateTaskSteps` runs in `ca-central-1` by default, but calls Bedrock Agent
Runtime and Bedrock Runtime in the Knowledge Base region. CDK passes the KB id
across regions using `crossRegionReferences: true`, which creates CDK helper
custom resources.

The Lambda console will show different functions depending on the selected
region:

| Region | Lambda functions you should expect |
| ------ | ---------------------------------- |
| Backend region | `canplan-createTask-<env>`, `canplan-users-<env>`, `canplan-categories-<env>`, `canplan-tasks-<env>`, `canplan-assignments-<env>`, `canplan-media-<env>`, `canplan-admin-<env>`, `canplan-generateTaskSteps-<env>`, CDK cross-region reader, sandbox S3 auto-delete helper |
| Knowledge Base region | OpenSearch index custom-resource provider, bucket deployment helper, CDK cross-region writer, sandbox S3 auto-delete helper |

## Prerequisites

- Node.js 20+
- AWS CLI v2 authenticated with AWS SSO
- Docker Desktop running for `cdk synth` / `cdk deploy`

Docker is required because `@cdklabs/generative-ai-cdk-constructs` bundles the
OpenSearch Serverless index custom-resource Lambda with Docker. The business
Lambdas use local `esbuild` bundling.

## Quick Setup

```bash
npm install
cp .env.example .env
```

Check `.env`:

```env
CANPLAN_BACKEND_REGION=ca-central-1
CANPLAN_KNOWLEDGE_BASE_REGION=us-east-1
AWS_REGION=ca-central-1
```

Load `.env` before CDK/AWS CLI commands that use those variables:

```bash
set -a
. ./.env
set +a
```

## Deploy Sandbox

First deploy in an account:

```bash
aws sso login --profile canplan-sandbox
export AWS_PROFILE=canplan-sandbox

set -a
. ./.env
set +a

aws sts get-caller-identity

npx ts-node scripts/build-corpus.ts

npx cdk bootstrap \
  aws://<account-id>/$CANPLAN_BACKEND_REGION \
  aws://<account-id>/$CANPLAN_KNOWLEDGE_BASE_REGION

npm run cdk:deploy:sandbox
```

Normal redeploy after bootstrap:

```bash
export AWS_PROFILE=canplan-sandbox
set -a
. ./.env
set +a
npx ts-node scripts/build-corpus.ts
npm run cdk:deploy:sandbox
```

The deploy prints the AppSync URL, API key, Cognito values, task table name,
Bedrock model, Bedrock region, and Knowledge Base id.

To re-print backend outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name canplan-backend-sandbox \
  --region "$CANPLAN_BACKEND_REGION" \
  --query 'Stacks[0].Outputs' \
  --output table
```

## Ingest The Knowledge Base

`scripts/build-corpus.ts` converts `data/corpus/seed.jsonl` into
`data/corpus/dist/*.txt` and `*.metadata.json`. CDK uploads `data/corpus/dist` to
the corpus bucket, but Bedrock retrieval will not work until the data source is
ingested.

Run this after deploy, and again whenever the corpus changes:

```bash
KB_ID=$(aws cloudformation describe-stacks \
  --stack-name canplan-knowledge-base-sandbox \
  --region "$CANPLAN_KNOWLEDGE_BASE_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='KnowledgeBaseId'].OutputValue" \
  --output text)

DS_ID=$(aws bedrock-agent list-data-sources \
  --knowledge-base-id "$KB_ID" \
  --region "$CANPLAN_KNOWLEDGE_BASE_REGION" \
  --query 'dataSourceSummaries[0].dataSourceId' \
  --output text)

aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --region "$CANPLAN_KNOWLEDGE_BASE_REGION"
```

## Commands

| Command | Purpose |
| ------- | ------- |
| `npm run build` | TypeScript build |
| `npm test` | Jest tests |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |
| `npm run cdk:synth` | CDK synth; requires `data/corpus/dist` and Docker |
| `npm run cdk:deploy:sandbox` | Deploy both sandbox stacks |
| `npm run cdk:destroy:sandbox` | Destroy both sandbox stacks |
| `npm run cdk:deploy:dev` | Deploy both dev stacks |
| `npm run cdk:destroy:dev` | Destroy dev stacks, retaining protected data resources |
| `npm run cdk:deploy:prod` | Deploy both prod stacks |

There is intentionally no `cdk:destroy:prod` script.

## Data Migration (default categories + taskCount + stable TaskStep keys)

[scripts/migrate-default-categories.ts](scripts/migrate-default-categories.ts) brings legacy
data onto the current model. It is **idempotent**, defaults to **dry-run**, and requires
`--apply` to write. It:

1. ensures **exactly one valid default category** per profile — creates the real
   `No Category` row + `defaultCategoryId` when missing, **repairs** a missing/invalid
   `defaultCategoryId` pointer to the surviving default, and deterministically repairs
   duplicate/legacy default flags by retaining the lowest canonical category id and
   demoting every other flagged row to `Recovered Category <short-id>`;
2. reparents legacy `categoryId: "NO_CATEGORY"` (and dangling) tasks to the owner's default;
3. strips the removed Task `status` attribute;
4. **backfills `Category.taskCount`** to the true number of tasks in each category (the
   durable count `deleteCategory` relies on); and
5. backfills TaskStep append metadata (`stepCount`, `stepVersion`, `nextStepOrder`); and
6. rewrites order-based `TaskStep` sort keys (`STEP#001`) to stable `STEP#<stepId>` keys.

Run it **before relying on `deleteCategory`** against legacy data. Runbook (maintenance
migration — the new code reads legacy rows by the unchanged `STEP#` prefix and sorts by
`order`, so old rows stay readable throughout):

```bash
# 1) deploy the new code, then dry-run to review counts/failures
DYNAMODB_TABLE_NAME=CanPlanTasks-dev npx ts-node scripts/migrate-default-categories.ts
# 2) apply
DYNAMODB_TABLE_NAME=CanPlanTasks-dev npx ts-node scripts/migrate-default-categories.ts --apply
# 3) re-run dry-run to confirm zero pending changes (idempotency check)
DYNAMODB_TABLE_NAME=CanPlanTasks-dev npx ts-node scripts/migrate-default-categories.ts
```

## Environment Behavior

The CDK app reads `--context env=...`; only `env=sandbox` is treated as sandbox.

| Resource | Sandbox destroy | Dev/prod destroy |
| -------- | --------------- | ---------------- |
| DynamoDB table (single-table) | Deleted | Retained |
| Media S3 bucket | Emptied and deleted | Retained |
| Cognito User Pool | Deleted | Retained |
| KB corpus S3 bucket | Emptied and deleted | Retained |
| OpenSearch Serverless collection | Deleted | Retained |
| AppSync, Lambdas, IAM, log groups | Deleted | Deleted |

Dev/prod `cdk destroy` still destroys the stacks and non-retained infrastructure.
The KB corpus bucket is retained, so the vector index can be rebuilt by deploying
and re-running ingestion if needed.

## Configuration

Region resolution in [infrastructure/bin/app.ts](infrastructure/bin/app.ts):

| Setting | Resolution order | Default |
| ------- | ---------------- | ------- |
| Backend stack region | `--context backendRegion=...`, `CANPLAN_BACKEND_REGION` | `ca-central-1` |
| Knowledge Base / Bedrock region | `--context knowledgeBaseRegion=...`, legacy `--context bedrockRegion=...`, `CANPLAN_KNOWLEDGE_BASE_REGION`, legacy `BEDROCK_REGION` | `us-east-1` |

Runtime settings on `generateTaskSteps`:

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `BEDROCK_REGION` | KB region | Region for KB Retrieve and Converse |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-6` | Generation model / inference profile |
| `BEDROCK_MAX_TOKENS` | `1024` | Generation cap |
| `RETRIEVAL_TOP_K` | `4` | KB passages retrieved per query |

## Project Map

```text
graphql/schema.graphql                         AppSync schema
infrastructure/bin/app.ts                      CDK app and stack wiring
infrastructure/lib/canplan-backend-stack.ts    Backend stack
infrastructure/lib/knowledge-base-stack.ts     Knowledge Base stack
infrastructure/lib/constructs/                 CDK constructs
scripts/build-corpus.ts                        seed.jsonl -> data/corpus/dist
scripts/migrate-default-categories.ts          idempotent default-category + TaskStep-key migration
src/lambdas/createTask/handler.ts              createTask resolver (Task + steps)
src/lambdas/{users,categories,tasks,assignments,media}/handler.ts   Domain resolvers (routed by fieldName)
src/lambdas/admin/handler.ts                   SystemAdmin list-all-by-entityType resolvers
src/lambdas/generateTaskSteps/handler.ts       KB Retrieve -> Converse resolver
src/shared/keys.ts                             Single-table PK/SK + entityType conventions
src/shared/category.ts                         Task↔Category lookup/validation + taskCount deltas
src/shared/authz.ts                            Owner-scoped authorization helpers
src/shared/{auth,pagination}.ts                Cognito group checks + nextToken cursors
src/shared/{dynamodb,s3,bedrock,kb}.ts         Shared AWS clients (s3 = media presign)
src/shared/                                    Shared types/helpers
docs/API.md                                    Frontend API reference
```

## Common Issues

- `Cannot find asset ... data/corpus/dist`: run `npx ts-node scripts/build-corpus.ts`.
- `Cannot connect to the Docker daemon`: start Docker Desktop and retry synth/deploy.
- `createTask` Lambda not visible in Lambda console: switch AWS Console region to
  `CANPLAN_BACKEND_REGION` (`ca-central-1` by default). KB helper Lambdas are in
  `CANPLAN_KNOWLEDGE_BASE_REGION`.
- Expired AWS credentials: run `aws sso login --profile canplan-sandbox` again.
