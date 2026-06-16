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
> (`UserPoolId`, `UserPoolClientId`); see the README "Authentication" section.

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

Four GSIs serve the cross-cutting lists: `supporterIndex` (users managed by a
supporter), `orgIndex` (users in an organization), `taskOwnerIndex` (task templates
by owner), and `entityTypeIndex` (every item of one `entityType`, newest-first —
backs the SystemAdmin list-all APIs without a Scan).

---

## Enums

| Enum | Values |
|---|---|
| `UserRole` | `PRIMARY_USER`, `SUPPORT_PERSON`, `ORG_ADMIN` |
| `TaskStatus` | `DRAFT`, `ACTIVE`, `ARCHIVED` |
| `AssignmentStatus` | `ACTIVE`, `COMPLETED`, `PAUSED`, `CANCELLED` |
| `ProgressEventType` | `STARTED`, `PAUSED`, `RESUMED`, `SKIPPED`, `COMPLETED`, `SYNCED` |
| `MediaType` | `IMAGE`, `AUDIO`, `VIDEO` |
| `SupportLinkStatus` | `PENDING`, `ACTIVE`, `REVOKED` |

Free-form object fields (`accessibilitySettings`, `permissions`, `metadata`) are the
AppSync `AWSJSON` scalar — send/receive them as JSON objects.

---

## Operations

### `healthCheck` — query

Liveness probe. Returns the static string `"OK"`. It's the one field annotated with
both `@aws_api_key` and `@aws_cognito_user_pools`, so it accepts **either** the API
key (`x-api-key`) **or** a Cognito JWT — letting monitors/CI verify connectivity
without a signed-in user. (Every other field requires a Cognito JWT.)

```graphql
query { healthCheck }
```

```bash
# With the API key (no login required):
curl -s "$GRAPHQL_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query":"query { healthCheck }"}'
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

The created steps are returned in `order` (`1`, `2`, `3`, …) — clients work with the
`order` field, not the internal `STEP#NNN` sort key.

---

### Other operations

These follow the same request/response conventions. `create…`/`update…` are
mutations; `get…`/`list…` are queries. In the **Input** columns below, required
fields are marked `!` and everything else is optional; see
[schema.graphql](../graphql/schema.graphql) for full nullability of the returned types.

> **All `list*` queries are paginated.** Each accepts optional `limit` (page size)
> and `nextToken`, and returns a `{ items, nextToken }` **connection** (e.g.
> `listTaskSteps` → `TaskStepConnection`, `listAssignmentsForUser` →
> `AssignmentConnection`). `nextToken` is an opaque, base64-encoded cursor — pass it
> back to fetch the next page; it's `null` on the last page. (See the
> `listAllUsers` example below for the paging loop — every list query works the same way.)

**Users & support**

| Operation | Input | Returns |
|---|---|---|
| `createUserProfile` | `input: { userId!, role!, displayName, email, organizationId, accessibilitySettings }` | `UserProfile` |
| `getUserProfile` | `userId!` | `UserProfile` · `null` if not found |
| `listUsersByOrganization` | `organizationId!, limit, nextToken` | `UserProfileConnection!` — **roster only**: just `userId`, `displayName`, `role` are populated (orgIndex projection); other fields are `null` |
| `createSupportLink` | `input: { supporterId!, primaryUserId!, status, permissions }` | `SupportLink` · `status` defaults to `PENDING` |
| `listPrimaryUsersBySupporter` | `supporterId!, limit, nextToken` | `SupportLinkConnection!` |

**Tasks & steps**

| Operation | Input | Returns |
|---|---|---|
| `getTask` | `taskId!` | `Task` · `null` if not found · `steps` is `null` here (use `listTaskSteps`) |
| `listTaskSteps` | `taskId!, limit, nextToken` | `TaskStepConnection!` — steps in ascending `order` |
| `listTasksByOwner` | `ownerId!, limit, nextToken` | `TaskConnection!` |
| `createTaskStep` | `input: { taskId!, order!, text!, mediaRefs, expectedDuration }` | `TaskStep` |

**Assignments**

| Operation | Input | Returns |
|---|---|---|
| `createAssignment` | `input: { taskId!, userId!, assignedBy, dueDate, recurrence, scheduleRule, active, status }` | `Assignment` · `active` defaults `true`, `status` defaults `ACTIVE` |
| `updateAssignmentStatus` | `input: { userId!, assignmentId!, status!, active }` | `Assignment` · **needs both `userId` and `assignmentId`** (they form the item key); errors if the assignment doesn't exist |
| `listAssignmentsForUser` | `userId!, limit, nextToken` | `AssignmentConnection!` |

**Progress (append-only) & media**

| Operation | Input | Returns |
|---|---|---|
| `createProgressEvent` | `input: { userId!, eventType!, assignmentId, taskId, timestamp, source, metadata }` | `ProgressEvent` · append-only; `timestamp` defaults to now |
| `listProgressEventsForUser` | `userId!, assignmentId, limit, nextToken` | `ProgressEventConnection!` — optional `assignmentId` filter |
| `createMediaUploadUrl` | `input: { taskId!, contentType!, fileName }` | `MediaUploadTarget` — see flow below |
| `createMediaAsset` | `input: { taskId!, s3Key!, type!, mimeType!, ownerId!, size, stepId }` | `MediaAsset` — see flow below |
| `getMediaDownloadUrl` | `taskId!, assetId!` | `MediaDownloadTarget` — see flow below |
| `listMediaForTask` | `taskId!, limit, nextToken` | `MediaAssetConnection!` |

> **Media is upload-first.** Binaries live in the S3 media bucket; DynamoDB stores
> only the `s3Key` and metadata (`type`, `mimeType`, `ownerId`, `size`, optional
> `stepId`). Clients never need AWS credentials — they upload through a presigned URL:
>
> 1. **`createMediaUploadUrl({ taskId, contentType, fileName? })`** → returns
>    `{ uploadUrl, s3Key, expiresIn }`. `uploadUrl` is a short-lived (default 15 min)
>    presigned **PUT**; `s3Key` is server-chosen (`media/<taskId>/<uuid>.<ext>`).
> 2. **`PUT` the raw file bytes to `uploadUrl`** with the same `Content-Type` you
>    passed as `contentType` (direct browser/mobile upload to S3 — the bucket allows
>    CORS PUT). No GraphQL, no credentials.
> 3. **`createMediaAsset({ taskId, s3Key, type, mimeType, ownerId, size?, stepId? })`**
>    → registers the now-uploaded object's metadata so it shows up in `listMediaForTask`.
>
> ```bash
> # 2) upload the bytes to the presigned URL from step 1
> curl -X PUT "$UPLOAD_URL" -H "Content-Type: image/png" --data-binary @photo.png
> ```
>
> **Viewing/downloading is symmetric.** The bucket is private, so to render media
> call **`getMediaDownloadUrl(taskId, assetId)`** → `{ downloadUrl, s3Key, expiresIn }`
> and `GET` the (short-lived) `downloadUrl`. It only signs assets that are actually
> registered — unknown ids return a not-found error rather than signing an arbitrary key.

---

### Admin listings — queries (SystemAdmin only)

`list-all-by-entity-type` endpoints for admin/debug tooling. They query the
`entityTypeIndex` (never a Scan), return newest-first, and are **restricted to the
`SystemAdmin` Cognito group** — both at the AppSync edge (`@aws_cognito_user_pools`)
and re-checked in the resolver. A non-SystemAdmin caller gets an authorization error.

| Operation | Returns |
|---|---|
| `listAllUsers(limit, nextToken)` | `UserProfileConnection` |
| `listAllTasks(limit, nextToken)` | `TaskConnection` |

Both take an optional `limit` (page size) and `nextToken`, and return
`{ items, nextToken }`. `nextToken` is an **opaque, base64-encoded** cursor — pass
the value you got back to fetch the next page; it's `null` on the last page.

```graphql
query ListUsers($limit: Int, $nextToken: String) {
  listAllUsers(limit: $limit, nextToken: $nextToken) {
    items { userId role displayName organizationId createdAt }
    nextToken
  }
}
```

```ts
// Page through every user (requires a SystemAdmin JWT in Authorization):
let nextToken: string | undefined;
do {
  const page = await graphql(LIST_USERS, { limit: 50, nextToken }, systemAdminToken);
  process(page.listAllUsers.items);
  nextToken = page.listAllUsers.nextToken ?? undefined;
} while (nextToken);
```

`listAllTasks` returns Task `#META` items only (TaskStep items have
`entityType = "TaskStep"`, so they don't appear here).

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

- **Per-role/owner authorization on domain operations** — the `SystemAdmin` admin
  queries are group-gated (enforced), but the regular create/get/list resolvers
  don't yet verify the caller (e.g. that a primary user only reads their own data,
  or that a supporter owns the task). The schema and single-table keys are
  structured to support these rules.
- **Update/delete** for entities other than `updateAssignmentStatus`.
- **Report generation** — the `Report` type exists in the schema, but no query or
  mutation is exposed for it yet.
- **Streaming AI responses** — `generateTaskSteps` is request/response only.
