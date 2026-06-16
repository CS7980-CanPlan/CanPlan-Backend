# CanPlan 2.0 — Frontend API Reference

The backend exposes a single **AWS AppSync GraphQL** endpoint backed by a single
DynamoDB table. This document covers how to connect, the available operations, and
how errors come back.

The schema lives at [graphql/schema.graphql](../graphql/schema.graphql) — it is the
canonical source of truth for exact types and nullability; this doc is its
human-readable companion.

---

## Connecting

All requests are a single `POST` to the GraphQL URL with a JSON body of
`{ query, variables }`. There is one URL for the whole API — you select the
operation in the query, not the path.

| | |
|---|---|
| **Endpoint** | The `GraphQLApiUrl` printed by `cdk deploy` (e.g. `https://xxxx.appsync-api.<region>.amazonaws.com/graphql`) |
| **Method** | `POST` |
| **Auth (primary)** | Cognito User Pool JWT in the `Authorization` header |
| **Auth (secondary)** | API key in the `x-api-key` header — for `healthCheck` and tooling only |
| **Content-Type** | `application/json` |

> **Which auth do I use?** Frontend clients (mobile app + web portal) authenticate
> users against the Cognito User Pool and send the user's **ID token** (JWT) in the
> `Authorization` header. The API key is an additional mode kept for the
> unauthenticated `healthCheck` probe and proof-of-concept tooling — don't ship it
> as the app's auth. The User Pool id and client id are CloudFormation outputs
> (`UserPoolId`, `UserPoolClientId`); see the README "Authentication setup".

### Required headers

```
Content-Type: application/json
Authorization: <Cognito ID token (JWT)>
```

---

## Quick start

A minimal `fetch` wrapper the frontend can build on:

```ts
const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL;

async function graphql<T>(query: string, variables: Record<string, unknown>, idToken: string): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: idToken, // Cognito ID token (JWT)
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json();
  // GraphQL returns HTTP 200 even for field errors — check the errors array.
  if (body.errors?.length) {
    throw new Error(body.errors[0].message);
  }
  return body.data;
}
```

---

## Data model (single table)

Every entity lives in one DynamoDB table keyed by a composite `PK`/`SK`, with an
`entityType` discriminator. The frontend never sees `PK`/`SK` — it works with the
GraphQL types below. The key layout (for reference):

| Entity | PK | SK |
|---|---|---|
| UserProfile | `USER#<userId>` | `#PROFILE` |
| SupportLink | `SUPPORTER#<supporterId>` | `USER#<primaryUserId>` |
| Task (template) | `TASK#<taskId>` | `#META` |
| TaskStep | `TASK#<taskId>` | `STEP#<order>` (zero-padded, e.g. `STEP#001`) |
| Assignment | `USER#<userId>` | `ASSIGN#<assignmentId>` |
| ProgressEvent | `USER#<userId>` | `PROGRESS#<timestamp>#<eventId>` |
| MediaAsset | `TASK#<taskId>` | `MEDIA#<assetId>` |

Three GSIs serve the cross-cutting lists: `supporterIndex` (users managed by a
supporter), `orgIndex` (users in an organization), `taskOwnerIndex` (task templates
by owner).

---

## Operations

### `healthCheck` — query

Liveness probe. Returns the static string `"OK"`. Works with the API key, so it's
useful for verifying connectivity before wiring up Cognito.

```graphql
query { healthCheck }
```

---

### `createTask` — mutation

Creates a **reusable task template** owned by a SupportPerson or OrgAdmin, plus one
`TaskStep` item per nested step (each stored as its own row). Assigning a task to a
user is a separate operation — see `createAssignment`.

**Input — `CreateTaskInput`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `ownerId` | `ID!` | ✅ | The support person / org admin who owns the template |
| `title` | `String!` | ✅ | Non-empty after trimming |
| `categoryId` | `ID` | — | Optional category |
| `description` | `String` | — | Optional |
| `scheduleRule` | `String` | — | Optional (e.g. an RRULE) |
| `status` | `TaskStatus` | — | Defaults to `DRAFT` |
| `steps` | `[CreateTaskStepNestedInput!]` | — | Ordered; each becomes a `STEP#NNN` item |

`CreateTaskStepNestedInput`: `text: String!`, `mediaRefs: [ID!]`, `expectedDuration: Int`.

**Returns — `Task`** (with the `steps` it just created)

```graphql
mutation CreateTask($input: CreateTaskInput!) {
  createTask(input: $input) {
    taskId
    ownerId
    title
    status
    createdAt
    steps { stepId order text }
  }
}
```

```json
{
  "input": {
    "ownerId": "support-123",
    "title": "Wash your hands",
    "status": "ACTIVE",
    "steps": [
      { "text": "Wet your hands with warm water" },
      { "text": "Add soap and scrub for 20 seconds" },
      { "text": "Rinse and dry" }
    ]
  }
}
```

Steps come back keyed `STEP#001`, `STEP#002`, `STEP#003` and are returned in order.

---

### Other operations

These follow the same request/response conventions. See
[schema.graphql](../graphql/schema.graphql) for exact field types and nullability.

**Users & support**

| Operation | Kind | Purpose / access pattern |
|---|---|---|
| `createUserProfile(input)` | mutation | Create a `UserProfile` (`USER#<id>` / `#PROFILE`) |
| `getUserProfile(userId)` | query | GetItem the profile |
| `listUsersByOrganization(organizationId)` | query | Query `orgIndex` — lightweight roster (`userId`, `displayName`, `role`) |
| `createSupportLink(input)` | mutation | Link a supporter to a primary user |
| `listPrimaryUsersBySupporter(supporterId)` | query | Query `supporterIndex` — users a supporter manages |

**Tasks & steps**

| Operation | Kind | Purpose / access pattern |
|---|---|---|
| `getTask(taskId)` | query | GetItem the task `#META` |
| `listTaskSteps(taskId)` | query | Query `STEP#` rows under the task, in order |
| `listTasksByOwner(ownerId)` | query | Query `taskOwnerIndex` |
| `createTaskStep(input)` | mutation | Add a single step (`taskId`, `order`, `text`) to a task |

**Assignments**

| Operation | Kind | Purpose / access pattern |
|---|---|---|
| `createAssignment(input)` | mutation | Assign a task to a user (`USER#<userId>` / `ASSIGN#<assignmentId>`) |
| `updateAssignmentStatus(input)` | mutation | Update an assignment's `status` / `active` |
| `listAssignmentsForUser(userId)` | query | Query `ASSIGN#` rows under the user |

**Progress (append-only) & media**

| Operation | Kind | Purpose / access pattern |
|---|---|---|
| `createProgressEvent(input)` | mutation | Append a progress event (offline-sync friendly) |
| `listProgressEventsForUser(userId, assignmentId?)` | query | Query `PROGRESS#` rows; optionally filter by assignment |
| `createMediaAsset(input)` | mutation | Record S3 metadata for an `IMAGE` / `AUDIO` / `VIDEO` asset |
| `listMediaForTask(taskId)` | query | Query `MEDIA#` rows under the task |

> **Media:** binaries live in the S3 media bucket; DynamoDB stores only the `s3Key`
> and descriptive metadata (`type`, `mimeType`, `ownerId`, `size`, optional `stepId`).

---

### `generateTaskSteps` — mutation

Breaks a daily-living task into ordered, **source-cited** steps via the Bedrock
Knowledge Base + RAG. Unchanged from before.

**Input — `GenerateTaskStepsInput`**: `userId: String!`, `query: String!`,
`context: { role, organizationId }`.

**Returns — `TaskStepsResponse`**: `steps: [GeneratedStep!]!` (each
`{ text, citations { chunkId, title, url, snippet } }`), plus `model`, `inputTokens`,
`outputTokens`.

> Note: the AI-generated `GeneratedStep` (carries citations) is distinct from the
> persisted `TaskStep` entity (carries storage metadata). They are different types.

---

## Error handling

GraphQL does **not** use HTTP status codes for field-level problems. A request that
reached a resolver returns **HTTP 200** with the failure in an `errors` array;
`data` for the failed field is `null`. Always check `errors` before reading `data`.

| Situation | How it surfaces |
|---|---|
| Validation failure (missing required input) | HTTP 200, `errors: [{ message }]` from the resolver |
| Bedrock or KB failure (`generateTaskSteps`) | HTTP 200, `errors: [{ message }]` from the resolver |
| Missing/invalid/expired credentials | HTTP 401, `{ "errors": [{ "errorType": "UnauthorizedException" }] }` |
| Malformed query / unknown field | HTTP 200 (or 400), `errors` with a parse/validation message |

---

## Not available yet

Planned but not implemented — don't build against them:

- **Group/owner authorization enforcement** — Cognito is the authorizer, but
  per-role resolver rules (primary users read their own data, supporters manage
  linked users, org admins list their org) are not enforced yet. The schema and
  single-table keys are structured to support them.
- **Update/delete** for entities other than `updateAssignmentStatus`.
- **Report generation** — the `Report` type exists in the schema, but no query or
  mutation is exposed for it yet.
- **Streaming AI responses** — `generateTaskSteps` is request/response only.
