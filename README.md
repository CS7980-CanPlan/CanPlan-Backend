# CanPlan Backend

AWS CDK backend for CanPlan. It deploys an AppSync GraphQL API, Cognito auth,
DynamoDB task storage, S3 buckets, Lambda resolvers, and a Bedrock Knowledge Base
backed by S3 Vectors.

## Current API

The GraphQL schema is in [graphql/schema.graphql](graphql/schema.graphql) and the
frontend-facing reference is [docs/API.md](docs/API.md).

CanPlan uses a **single DynamoDB table** (`CanPlanTasks-<env>`, composite `PK`/`SK`)
for every entity — UserProfile, SupportLink, Organization, OrganizationMember, Category,
Task, TaskStep, TaskAssignment, TaskInstance, TaskInstanceStep, MediaAsset, Report. The
item-key conventions live in [src/shared/keys.ts](src/shared/keys.ts).

| Operation(s) | Type | Backing service |
| --------- | ---- | --------------- |
| `healthCheck` | Query | AppSync none data source |
| `createTask` | Mutation | `canplan-createTask-<env>` Lambda (writes Task + steps atomically) |
| `createUserProfile`, `updateMyUserProfile`, `getUserProfile`, `listMyOrganizationUsers`, `selectPrimaryUser`, `unselectPrimaryUser`, `listMySupportList` | Query/Mutation | `canplan-users-<env>` Lambda + DynamoDB (createUserProfile also creates the user's default category atomically) |
| `createCategory`, `updateCategory`, `deleteCategory`, `listMyCategories` | Query/Mutation | `canplan-categories-<env>` Lambda + DynamoDB (self by default; optional `userId` lets a SupportPerson manage a selected primary user's categories via delegated access; deleteCategory reparents tasks to the target user's default category) |
| `getTask`, `listTaskSteps`, `listTasksByOwner`, `listTasksByCategory`, `updateTask`, `createTaskStep`, `updateTaskStep`, `deleteTaskStep`, `reorderTaskSteps`, `deleteTask` | Query/Mutation | `canplan-tasks-<env>` Lambda + DynamoDB + S3 (media cleanup) |
| `createTaskAssignment`, `startTaskInstance`, `setTaskInstanceStepCompletion`, `updateTaskInstanceStatus`, `cancelTaskInstance`, `endTaskAssignment`, `deleteTaskAssignment`, `listTaskAssignmentsForUser`, `getTaskInstanceViews`, `getTaskInstance`, `listTaskInstances`, `batchGetTaskInstances`, `listTaskInstanceSteps` | Query/Mutation | `canplan-assignments-<env>` Lambda + DynamoDB (TaskAssignment schedule rules; lazily-materialized TaskInstances; calendar feed; self-scoped instance reads) |
| `createMediaUploadUrl`, `createTaskCoverImageUploadUrl`, `createMediaAsset`, `deleteMediaAsset`, `getMediaDownloadUrl`, `listMediaForTask` | Query/Mutation | `canplan-media-<env>` Lambda + DynamoDB + S3 media bucket (presigned upload/download, cover images, cascade delete) |
| `listAllUsers`, `listAllTasks`, `listAllOrganizations`, `adminListOrganizationUsers`, `adminGetUserData` | Query | `canplan-admin-<env>` Lambda + DynamoDB `entityTypeIndex`/GSIs (SystemAdmin only, paginated; no Scan) |
| `inviteSupportPerson`, `inviteOrganizationAdmin`, `setUserBaseRole`, `setSystemAdmin`, `adminDeleteTask`, `adminDeleteUser`, `adminCreateOrganization`, `adminUpdateOrganization`, `adminDeleteOrganization`, `adminSetUserOrganization` | Mutation | `canplan-admin-<env>` Lambda + Cognito + DynamoDB + S3 (SystemAdmin only — manage Cognito roles, organizations & membership, delete any task, full user deletion) |
| `generateTaskSteps` | Mutation | `canplan-generateTaskSteps-<env>` Lambda + Bedrock KB RAG |
| `createAiTask` | Mutation | `canplan-createAiTask-<env>` Lambda + Bedrock KB RAG (generate a title + steps preview; persists nothing) |

Domain Lambdas back several fields each, routing on the resolved GraphQL field
(`event.info.fieldName`). AI usage is through two mutations. `generateTaskSteps`
retrieves relevant corpus passages from the Knowledge Base, then calls Bedrock
Converse to generate cited task steps (it returns the steps; it does not save a
task). `createAiTask` takes a single free-text `query`, generates a clean title
plus ordered steps over the same Knowledge Base, and returns them directly to the
frontend as a `GeneratedAiTask` preview; it persists nothing (no task, steps,
category, or media are written, and no `categoryId` is resolved). The caller saves
the preview later via `createTask` if they keep it. Its behaviour is
**input-controlled, not role-gated**: `groundingMode` (`GROUNDED_ONLY` default, or
`ALLOW_UNGROUNDED_FALLBACK`) decides whether a query with no relevant corpus passage
fails with `NOT_FOUND` (no generation model call) or falls back to ungrounded AI
generation; `source` (`CORPUS` / `UNGROUNDED_AI`) reports which path produced the
result; each step carries `citations` (populated for corpus output, empty for
ungrounded, fetched only if the frontend selects the field); and an optional
`stepCount` (1..20) requests an exact number of steps. It reuses the same KB/Bedrock
generation as `generateTaskSteps` (via `src/shared/stepsService.ts`). A caregiver
review/approval flow over the cited sources is a separate future project, not part
of this mutation.

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
| `listAllUsers`, `listAllTasks`, `listAllOrganizations`, `adminListOrganizationUsers`, `adminGetUserData` | `@aws_cognito_user_pools(cognito_groups: ["SystemAdmin"])` — SystemAdmin group only |
| `inviteSupportPerson`, `inviteOrganizationAdmin`, `setUserBaseRole`, `setSystemAdmin`, `adminDeleteTask`, `adminDeleteUser`, `adminCreateOrganization`, `adminUpdateOrganization`, `adminDeleteOrganization`, `adminSetUserOrganization` | `@aws_cognito_user_pools(cognito_groups: ["SystemAdmin"])` — SystemAdmin group only (re-checked in the Lambda) |
| everything else | default Cognito User Pool (any signed-in user) |

The frontend needs the `UserPoolId` and `UserPoolClientId` deploy outputs to run the
Cognito sign-in flow. **Most user-facing data is self-owned or delegated explicitly.**
Category and task mutations derive the owner from the caller's Cognito `sub`; task and
media writes are owner-only. Task/media reads also allow a user with an active
TaskAssignment referencing the task. Assignment and task-instance operations require the
caller to act on their own schedule, or to be a `SupportPerson` with an ACTIVE selected
primary user in the same organization (see [src/shared/delegation.ts](src/shared/delegation.ts)).
The **self-scoped TaskInstance reads** (`getTaskInstance`, `listTaskInstances`,
`batchGetTaskInstances`) take no `userId`, derive the owner from the caller's `sub`, and reject
an unauthenticated caller. Profile writes are self-only via `createUserProfile` /
`updateMyUserProfile`; `getUserProfile` remains readable by any authenticated caller.

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

### SystemAdmin APIs

SystemAdmin-only operations (in the `canplan-admin-<env>` Lambda) cover read-only listings
(`listAllUsers`, `listAllTasks`, `listAllOrganizations`, `adminListOrganizationUsers`,
`adminGetUserData` — all PK/GSI reads, no Scan) plus the mutations below (Cognito roles,
organizations & membership, and destructive data cleanup). Each is gated to the `SystemAdmin`
group at the AppSync edge **and** re-checks the group inside the Lambda, with Cognito remaining the
authorization source of truth. `adminListOrganizationUsers(organizationId, limit, nextToken)`
returns one org's members by paging its `OrganizationMember` rows and loading each `UserProfile`
(rows with a missing profile are skipped):

| Mutation | Effect |
| -------- | ------ |
| `inviteSupportPerson(input)` | Create/adopt a Cognito user and add **only** the `SupportPerson` group (never `PrimaryUser`). Idempotent if the user already exists. |
| `inviteOrganizationAdmin(input)` | Same, adding **only** the `OrganizationAdmin` group. |
| `setUserBaseRole(input)` | Remove the user from all base groups, then add the one target (`PRIMARY_USER`/`SUPPORT_PERSON`/`ORG_ADMIN`). Mirrors the role onto an existing `UserProfile` (never creates one). `SystemAdmin` is untouched. |
| `setSystemAdmin(input)` | Grant/revoke the elevated `SystemAdmin` group (base roles untouched). **Self-demotion is rejected** — another admin must do it. |
| `adminDeleteTask(taskId)` | Delete **any** task regardless of owner, via the same cascade as the owner `deleteTask` (steps, media rows, S3 binaries, category `taskCount`). Idempotent. |
| `adminDeleteUser(input)` | Fully delete a user: all owned tasks (cascade), every `USER#<id>` partition row, all `SupportLink`s where they are supporter **or** primary user, and finally the Cognito login. Uses PK queries + GSIs (no Scan); the Cognito delete runs **last** so a data-cleanup failure leaves it safely retryable. **Self-deletion is rejected.** |
| `adminCreateOrganization(input)` | Create an `Organization` row (`ORG#<id>`/`#META`) with a generated id and trimmed name. |
| `adminUpdateOrganization(input)` | Rename an organization. `NOT_FOUND` if missing; rejected while it is being deleted. |
| `adminDeleteOrganization(input)` | Mark the org `deleting`, then detach every member found via the **strongly-consistent `OrganizationMember` rows** under the org partition (`ConsistentRead` Query, paginated — no Scan; **not** the eventually-consistent `orgIndex`), each in a transaction that conditionally clears the member's `organizationId` and deletes the membership row, then delete the org row **last**. Idempotent/retryable; returns the org + `removedUsers` count. |
| `adminSetUserOrganization(input)` | Set or clear **another** user's org membership (admin counterpart of the self-only `updateMyUserProfile`). Reads the target profile first (`NOT_FOUND` if none); joining verifies the org exists/isn't deleting, sets `organizationId`, writes the new `MEMBER#` row and deletes the old one on a move; clearing (`organizationId: null`) removes `organizationId` and the old row — all in one transaction. Returns the updated `UserProfile`. |

> **Membership rows & backfill:** every non-null `organizationId` write (`createUserProfile` /
> `updateMyUserProfile`) transactionally maintains an `OrganizationMember` row
> (`ORG#<org>`/`MEMBER#<user>`) so `adminDeleteOrganization` can detach members from a
> strongly-consistent source rather than the eventually-consistent `orgIndex`. **Existing
> environments must run a one-time backfill** writing a membership row for every `UserProfile`
> with a non-null `organizationId` **before** deleting any pre-existing org — see
> [docs/API.md](docs/API.md#admin-organizations--queries--mutations-systemadmin-only).

User ids in these inputs are the app-level `userId` (the Cognito `sub`); the Lambda resolves
the Cognito `Username` via a `ListUsers` `sub = "…"` filter. `inviteSupportPerson`/
`inviteOrganizationAdmin` do **not** create a `UserProfile` — the invitee's profile is created
by `createUserProfile` after they first log in.

**Bootstrap the first admin manually.** There is no API to mint the first SystemAdmin, so add
yourself to the group once in the AWS console (Cognito → your user pool → Users → pick the
user → add to the `SystemAdmin` group) or via the CLI:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId> --username <email-or-username> --group-name SystemAdmin
```

Admin users **log in through the same Cognito app client** as everyone else — there is no
separate admin pool. Because Cognito groups are embedded in the issued JWT, **a user must
refresh their tokens or re-login after any group change** (invite, `setUserBaseRole`,
`setSystemAdmin`) before the new role/permissions take effect.

`createUserProfile` also creates the user's **default category** (`name: "No Category"`,
`color: "#64748B"`, `isDefault: true`) — a real Category row with its own UUID — in the same transaction, and
stores its id on the profile (`defaultCategoryId`). Every Task belongs to a real Category;
one created without an explicit `categoryId` is filed under this default. The default
cannot be renamed or deleted. **Categories are owned by a user's `USER#<ownerId>` partition.**
`createCategory`, `updateCategory`, `deleteCategory`, and `listMyCategories` operate on the
authenticated caller's own categories by default; each also accepts an optional `userId` that
lets a **SupportPerson** manage a selected primary user's categories through delegated access
(an ACTIVE SupportLink to that PRIMARY_USER in the same organization — see `assertCanActForUser`).
Omitting `userId` (or passing your own) is unchanged self-access; a non-self `userId` keys and
reparents rows under the **target user's** partition, never the SupportPerson's. Likewise `createTask` and
`createAiTask` derive the task owner from the identity. Before using a profile's default category, runtime code
strongly reads and verifies the profile pointer, owner, exact `No Category` name,
`isDefault: true`, and that it is not being deleted; an invalid legacy row fails clearly
until the migration is applied.

Standalone `createTaskStep` is append-only and concurrency-safe. Task metadata
(`stepCount`, `stepVersion`, `nextStepOrder`) serializes appends: at most 99 steps are
allowed, concurrent calls from the same state yield exactly one success, and the other
callers receive a retryable validation error after reloading the task steps. Deleting a step
does not reclaim its order; `reorderTaskSteps` normalizes orders atomically.

**Scheduling is a three-layer model** (a `Task` is a reusable template only — it carries no
schedule). A `TaskAssignment` is the schedule rule binding a template to a user, either
`ONE_TIME` (`scheduledFor`) or `RECURRING` (an RRULE `scheduleRule` + `startDate`/`startTime`/
`timezone`, optional `endDate`). Occurrences are **virtual** until a user acts on one:
`getTaskInstanceViews` expands an active assignment's occurrences over a date range
(`rrule` + `luxon`, DST-correct; max 370-day span) and overlays any real rows, while
`startTaskInstance` lazily materializes a `TaskInstance` (status + lifecycle timestamps) and
snapshots the task's current steps into immutable `TaskInstanceStep` rows. `cancelTaskInstance`
writes a `CANCELLED` exception; `endTaskAssignment`/`deleteTaskAssignment` end an assignment
(soft delete). For reading back **materialized** instances there are three **self-scoped** queries
(owner derived from the Cognito identity, no `userId` argument, real rows only — never virtual):
`getTaskInstance(instanceId)`, `listTaskInstances(startDate, endDate)` (date-range page), and
`batchGetTaskInstances(instanceIds)` (≤ 100 ids, results in request order). An active assignment
carries a sparse `activeTaskAssignmentTaskId` marker
(`activeTaskAssignmentTaskIndex` GSI), so `deleteTask` is rejected while any active assignment
still references the template. See [docs/API.md](docs/API.md) for the full contract.

## Region Layout

The app deploys two CDK stacks with `--all`.

| Region | Stack | Main resources |
| ------ | ----- | -------------- |
| `CANPLAN_BACKEND_REGION` default `ca-central-1` | `canplan-backend-<env>` | AppSync, Cognito, single-table DynamoDB `CanPlanTasks-<env>`, media S3 bucket, `createTask` + domain Lambdas (`users`/`categories`/`tasks`/`assignments`/`media`/`admin`) + `generateTaskSteps` + `createAiTask` Lambdas, `postConfirmation` Cognito trigger Lambda, CloudWatch logs |
| `CANPLAN_KNOWLEDGE_BASE_REGION` default `us-east-1` | `canplan-knowledge-base-<env>` | Bedrock Knowledge Base, S3 corpus bucket, Bedrock S3 data source, S3 Vectors vector bucket/index |

`generateTaskSteps` and `createAiTask` run in `ca-central-1` by default, but call
Bedrock Agent Runtime and Bedrock Runtime in the Knowledge Base region. CDK passes the KB id
across regions using `crossRegionReferences: true`, which creates CDK helper
custom resources.

The Lambda console will show different functions depending on the selected
region:

| Region | Lambda functions you should expect |
| ------ | ---------------------------------- |
| Backend region | `canplan-createTask-<env>`, `canplan-users-<env>`, `canplan-categories-<env>`, `canplan-tasks-<env>`, `canplan-assignments-<env>`, `canplan-media-<env>`, `canplan-admin-<env>`, `canplan-generateTaskSteps-<env>`, `canplan-createAiTask-<env>`, CDK cross-region reader, destroyable-env S3 auto-delete helper |
| Knowledge Base region | bucket deployment helper, CDK cross-region writer, destroyable-env S3 auto-delete helper |

## Prerequisites

- Node.js 20+
- AWS CLI v2 authenticated with AWS SSO

No Docker is required: the S3 Vectors store uses first-class CloudFormation
resources (`CfnVectorBucket` / `CfnIndex`), so there is no bundled
custom-resource Lambda. The business Lambdas use local `esbuild` bundling.

## Quick Setup

```bash
npm install
cp .env.example .env
```

Check `.env`:

```env
CANPLAN_BACKEND_REGION=ca-central-1
CANPLAN_KNOWLEDGE_BASE_REGION=us-east-1
CDK_OWNER=michael
AWS_REGION=ca-central-1
```

Load `.env` before CDK/AWS CLI commands that use those variables:

```bash
set -a
. ./.env
set +a
```

## Deploy Personal Environment

Personal environments are for individual testing before promoting changes to
`dev`. They use the owner's name as the CDK environment name, so
`CDK_OWNER=michael` deploys stacks named `canplan-backend-michael` and
`canplan-knowledge-base-michael` with resources such as `CanPlanTasks-michael`.

The personal scripts load `.env`, read `CDK_OWNER`, and pass
`--context env=<owner> --context personal=true --context owner=<owner>` to CDK.
Personal environments are fully destroyable: DynamoDB, S3, Cognito, and Knowledge
Base state all use destroy/removal policies.

If the account has not been bootstrapped yet, run the bootstrap command in
[Deploy Sandbox](#deploy-sandbox) before the first personal deploy.

```bash
export AWS_PROFILE=canplan-sandbox

npx ts-node scripts/build-corpus.ts
npm run cdk:deploy:me
```

Destroy your personal environment when you no longer need it:

```bash
npm run cdk:destroy:me
```

To skip the CDK confirmation prompt:

```bash
npm run cdk:destroy:me -- --force
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
| `npm run cdk:deploy:me` | Deploy both personal stacks using `CDK_OWNER` from `.env` |
| `npm run cdk:destroy:me` | Destroy both personal stacks using `CDK_OWNER` from `.env` |
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

The CDK app reads `--context env=...`. `dev` and `prod` retain stateful
resources. `sandbox` and personal deployments are destroyable. The personal
scripts also pass `--context personal=true --context owner=<CDK_OWNER>`; unknown
environment names without that personal flag are rejected.

| Resource | Sandbox/personal destroy | Dev/prod destroy |
| -------- | ------------------------ | ---------------- |
| DynamoDB table (single-table) | Deleted | Retained |
| Media S3 bucket | Emptied and deleted | Retained |
| Cognito User Pool | Deleted | Retained |
| KB corpus S3 bucket | Emptied and deleted | Retained |
| S3 Vectors bucket + index | Deleted | Retained |
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

Runtime settings on the AI Lambdas (`generateTaskSteps` + `createAiTask`), set by the CDK
Functions construct and overridable per env:

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `BEDROCK_REGION` | KB region | Region for KB Retrieve, Cohere Rerank, and Converse |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-6` | Generation model / inference profile |
| `BEDROCK_MAX_TOKENS` | `1024` | Generation cap |
| `RERANK_COARSE_K` | `25` | Stage-1 vector candidates handed to the reranker |
| `RERANK_MODEL_ID` | `cohere.rerank-v3-5:0` | Cohere reranker (IAM ARN is coupled to this) |
| `RERANK_SCORE_FLOOR` | `0.3` | Absolute relevance floor (0–1); rejects low-quality matches |
| `RERANK_REL_RATIO` | `0.5` | Relative cutoff = topScore × ratio |
| `RERANK_MIN_RESULTS` | `2` | Min passages kept (only among floor-passing) |
| `RERANK_MAX_RESULTS` | `5` | Max passages kept (caps prompt length) |

Retrieval is a two-stage pipeline — coarse KB vector recall (`RERANK_COARSE_K`) then a
Cohere rerank pass (`src/shared/kb.ts` / `src/shared/rerank.ts`); see
[scripts/floor-eval/README.md](scripts/floor-eval/README.md) for calibrating the floor.

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
src/lambdas/admin/handler.ts                   SystemAdmin resolvers (listings + Cognito role mgmt + deletes)
src/lambdas/generateTaskSteps/handler.ts       KB Retrieve -> Converse resolver
src/lambdas/createAiTask/handler.ts            createAiTask resolver (generate titled steps -> preview, no persist)
src/shared/stepsService.ts                     KB Retrieve + Converse orchestration (generate steps / titled steps)
src/shared/task.ts                             persistTask: Task + steps transaction (used by createTask)
src/shared/keys.ts                             Single-table PK/SK + entityType conventions
src/shared/category.ts                         Task↔Category lookup/validation + taskCount deltas
src/shared/taskCascade.ts                      Shared Task cascade delete (owner deleteTask + adminDeleteTask)
src/shared/cognito.ts                          Cognito client, group constants, sub→Username/group helpers
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
