# CanPlan Backend

AWS CDK backend for CanPlan. It deploys an AppSync GraphQL API, Cognito auth,
DynamoDB task storage, S3 buckets, Lambda resolvers, and a Bedrock Knowledge Base
backed by OpenSearch Serverless.

## Current API

The GraphQL schema is in [graphql/schema.graphql](graphql/schema.graphql).

| Operation | Type | Backing service |
| --------- | ---- | --------------- |
| `healthCheck` | Query | AppSync none data source |
| `createTask` | Mutation | `canplan-createTask-<env>` Lambda + DynamoDB |
| `generateTaskSteps` | Mutation | `canplan-generateTaskSteps-<env>` Lambda + Bedrock KB RAG |

There is no standalone `askAi` mutation. AI usage is through `generateTaskSteps`:
retrieve relevant corpus passages from the Knowledge Base, then call Bedrock
Converse to generate cited task steps.

AppSync default authorization is Cognito User Pool auth. An API key is configured
as an additional auth mode, but the current schema does not add `@aws_api_key`
directives, so frontend clients should use a signed-in user's JWT.

## Region Layout

The app deploys two CDK stacks with `--all`.

| Region | Stack | Main resources |
| ------ | ----- | -------------- |
| `CANPLAN_BACKEND_REGION` default `ca-central-1` | `canplan-backend-<env>` | AppSync, Cognito, DynamoDB `CanPlanTasks-<env>`, media S3 bucket, `createTask` Lambda, `generateTaskSteps` Lambda, CloudWatch logs |
| `CANPLAN_KNOWLEDGE_BASE_REGION` default `us-east-1` | `canplan-knowledge-base-<env>` | Bedrock Knowledge Base, S3 corpus bucket, Bedrock S3 data source, OpenSearch Serverless vector collection/index |

`generateTaskSteps` runs in `ca-central-1` by default, but calls Bedrock Agent
Runtime and Bedrock Runtime in the Knowledge Base region. CDK passes the KB id
across regions using `crossRegionReferences: true`, which creates CDK helper
custom resources.

The Lambda console will show different functions depending on the selected
region:

| Region | Lambda functions you should expect |
| ------ | ---------------------------------- |
| Backend region | `canplan-createTask-<env>`, `canplan-generateTaskSteps-<env>`, CDK cross-region reader, sandbox S3 auto-delete helper |
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

## Environment Behavior

The CDK app reads `--context env=...`; only `env=sandbox` is treated as sandbox.

| Resource | Sandbox destroy | Dev/prod destroy |
| -------- | --------------- | ---------------- |
| DynamoDB task table | Deleted | Retained |
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
src/lambdas/createTask/handler.ts              createTask resolver
src/lambdas/generateTaskSteps/handler.ts       KB Retrieve -> Converse resolver
src/shared/                                    Shared AWS clients/types/helpers
docs/API.md                                    Frontend API reference
```

## Common Issues

- `Cannot find asset ... data/corpus/dist`: run `npx ts-node scripts/build-corpus.ts`.
- `Cannot connect to the Docker daemon`: start Docker Desktop and retry synth/deploy.
- `createTask` Lambda not visible in Lambda console: switch AWS Console region to
  `CANPLAN_BACKEND_REGION` (`ca-central-1` by default). KB helper Lambdas are in
  `CANPLAN_KNOWLEDGE_BASE_REGION`.
- Expired AWS credentials: run `aws sso login --profile canplan-sandbox` again.
