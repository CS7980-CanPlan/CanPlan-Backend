# CanPlan 2.0 — Frontend API Reference

_Last updated: 2026-06-20. Version: phase 1 (pre-authorization)._

> ## 🚨 Breaking change — progress model replaced
>
> The `ProgressEvent` model has been **removed** and the assignment model reworked.
> See [Breaking changes](#breaking-changes-progress--assignment-rework) below for the
> full migration notes. In short:
>
> - `ProgressEvent` is gone — `createProgressEvent` and `listProgressEventsForUser`,
>   the `ProgressEvent`/`ProgressEventType` types, and the `progress` Lambda no longer
>   exist. (Existing `ProgressEvent` rows are left in DynamoDB but are no longer served.)
> - `AssignmentStatus` is now `TO_DO` / `OVERDUE` / `COMPLETED` / `SKIPPED`. `OVERDUE`
>   is **derived**, never persisted. The old `ACTIVE`/`PAUSED`/`CANCELLED` values and
>   the `active` field are gone.
> - Progress is now tracked as per-assignment **`AssignmentStep`** snapshots, toggled
>   with `setAssignmentStepCompletion` and read with `listAssignmentSteps`.

The backend exposes a single **AWS AppSync GraphQL** endpoint backed by a single
DynamoDB table. This document covers how to connect, the available operations, and
how errors come back.

The schema lives at [graphql/schema.graphql](../graphql/schema.graphql) — it is the
canonical source of truth for exact types and nullability; this doc is its
human-readable companion.

> ## ⚠️ No authorization is enforced yet (read this first)
>
> Outside the `SystemAdmin` admin queries and the self-scoped `createUserProfile`,
> **no domain operation verifies the caller.** Any authenticated caller can act on
> **any `id`** — read another user's profile, create a task under any `ownerId`,
> assign a task to any `userId`, link any supporter to any primary user.
> The schema and single-table keys are structured to support per-role/owner rules,
> but they are **not implemented in this phase**.
>
> **Do not bake "the server lets me, so it's allowed" into the client.** When
> enforcement ships, calls that succeed today will start returning a `NOT_AUTHORIZED`
> error (see [Error handling](#error-handling)). Write the client so an authorization
> denial is a normal, handleable outcome — not an exception. In particular, always
> pass the caller's own id for self-scoped operations (see below); don't rely on the
> server tolerating someone else's id.

---

## Identity & the `userId` field

**Invariant: for any self-scoped operation, the `id` you pass MUST equal your own
Cognito `sub`.** This is not currently enforced — it is load-bearing anyway, because
of how data is keyed and read back:

- A user's profile is stored at the key derived from their Cognito `sub`
  (`USER#<sub>`), and `getUserProfile(userId)` looks it up by **exactly that
  `userId`**. There is no secondary lookup.
- `createUserProfile` does the right thing automatically — it ignores any
  client-supplied id and uses your `sub` from the session (see below). So your
  profile always lands at `USER#<sub>`.
- But the **read** and every other self-scoped write (`getUserProfile`,
  `createAssignment`, `setAssignmentStepCompletion`, `listAssignmentsForUser`,
  `listAssignmentSteps`, …) take a `userId`/`ownerId` **argument**. If you pass
  anything other than your own `sub` there, you will write rows you can never read
  back through your own profile, or read an empty result — silently, with no error.

**Rule of thumb:** decode the `sub` claim from your Cognito ID token once at sign-in
and use it as the `userId`/`ownerId` for everything that is "about me." Treat ids
that come from a list response (e.g. a supporter acting on a primary user) as the
only legitimate source of *someone else's* id.

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
| Category | `USER#<ownerId>` | `CATEGORY#<categoryId>` |
| Task (template) | `TASK#<taskId>` | `#META` |
| TaskStep | `TASK#<taskId>` | `STEP#<order>` (zero-padded, e.g. `STEP#001`) |
| Assignment | `USER#<userId>` | `ASSIGN#<assignmentId>` |
| AssignmentStep | `USER#<userId>` | `ASSIGN_STEP#<assignmentId>#STEP#<stepId>` |
| MediaAsset | `TASK#<taskId>` | `MEDIA#<assetId>` |

Five GSIs serve the cross-cutting lists: `supporterIndex` (users managed by a
supporter), `orgIndex` (users in an organization), `taskOwnerIndex` (task templates
by owner), `taskCategoryIndex` (tasks within one owner's category — keyed on a
denormalized `<ownerId>#<categoryId>`, newest-first), and `entityTypeIndex` (every
item of one `entityType`, newest-first — backs the SystemAdmin list-all APIs without
a Scan).

`Assignment` and its `AssignmentStep` snapshots share the `USER#<userId>` partition.
`ASSIGN_STEP#…` deliberately does **not** begin with `ASSIGN#` (its 7th character is
`_`, not `#`), so `listAssignmentsForUser`'s `begins_with(SK, 'ASSIGN#')` query never
returns step rows; `listAssignmentSteps` scopes to one assignment's steps and sorts
them by `order`.

---

## Enums

| Enum | Values |
|---|---|
| `UserRole` | `PRIMARY_USER`, `SUPPORT_PERSON`, `ORG_ADMIN` — a server-derived projection of Cognito group membership (`PrimaryUser`/`SupportPerson`/`OrganizationAdmin`); **Cognito groups are the authorization source of truth**. `SystemAdmin` is an elevated group, not a `UserRole`. |
| `TaskStatus` | `DRAFT`, `ACTIVE`, `ARCHIVED` |
| `AssignmentStatus` | `TO_DO`, `OVERDUE`, `COMPLETED`, `SKIPPED` — only `TO_DO`/`COMPLETED`/`SKIPPED` are persisted; `OVERDUE` is **derived** at read time (a `TO_DO` assignment whose `dueDate` is in the past) and cannot be set by a mutation |
| `MediaType` | `IMAGE`, `AUDIO`, `VIDEO` |
| `SupportLinkStatus` | `PENDING`, `ACTIVE`, `REVOKED` |
| `RepeatUnit` | `MINUTE`, `HOUR`, `DAY`, `WEEK`, `MONTH` |

### `AWSJSON` fields — encoding (foot-gun)

Free-form object fields (`accessibilitySettings`, `permissions`, `metadata`) are the
AppSync `AWSJSON` scalar. **`AWSJSON` is transported as a JSON-encoded _string_, not
a nested object.** In your `variables`, the value must be a string whose contents are
valid JSON — AppSync parses that string before the resolver sees it. Passing a nested
object instead is the most common mistake here and is rejected at the AppSync edge.

```jsonc
// ✅ correct — the value is a string containing JSON
{
  "input": {
    "displayName": "Sam",
    "accessibilitySettings": "{\"fontScale\":1.5,\"highContrast\":true}"
  }
}

// ❌ wrong — nested object; AppSync rejects this for an AWSJSON field
{
  "input": {
    "displayName": "Sam",
    "accessibilitySettings": { "fontScale": 1.5, "highContrast": true }
  }
}
```

In practice: `accessibilitySettings: JSON.stringify(settings)` on the way in. The same
applies to `permissions` (`createSupportLink`).
**Responses are symmetric** — these fields come back as JSON strings, so
`JSON.parse(profile.accessibilitySettings)` on the way out.

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
| `categoryId` | `ID` | — | Optional; blank/omitted falls back to the reserved `NO_CATEGORY` bucket (see below) |
| `description` | `String` | — | Optional |
| `scheduleRule` | `String` | — | Optional (e.g. an RRULE) |
| `status` | `TaskStatus` | — | Defaults to `DRAFT` |
| `steps` | `[CreateTaskStepNestedInput!]` | — | Ordered; each becomes a `STEP#NNN` item |
| `schedule` | `TaskScheduleInput` | — | Optional recurring schedule (stored only — see below) |
| `notificationEnabled` | `Boolean` | — | Defaults to `true` when `schedule` is set; otherwise left unset unless you pass it |

`CreateTaskStepNestedInput`: `text: String!`, `mediaRefs: [ID!]`.

**Category behavior.** Every task is filed under a category so it stays queryable by
`listTasksByCategory`. If you omit `categoryId` (or send a blank string), the task is
stored under the reserved id **`NO_CATEGORY`** — the implicit "uncategorized" bucket.
`NO_CATEGORY` is never a real `Category` row; it's just the default key. The returned
`Task.categoryId` reflects the stored value (so it's `"NO_CATEGORY"`, not `null`, when
you didn't supply one).

**Schedule behavior.** Pass `schedule` to attach recurring-reminder metadata. It is
**stored only** in this phase — no reminders are delivered yet (see _Not available
yet_). `TaskScheduleInput` fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `repeatEvery` | `Int!` | ✅ | Must be a positive integer (e.g. `2` for "every 2 …") |
| `repeatUnit` | `RepeatUnit!` | ✅ | `MINUTE` · `HOUR` · `DAY` · `WEEK` · `MONTH` |
| `firstOccurrenceAt` | `String!` | ✅ | Non-empty ISO-8601 timestamp of the first occurrence |
| `timezone` | `String!` | ✅ | Non-empty IANA tz (e.g. `America/Toronto`) |
| `enabled` | `Boolean` | — | Defaults to `true` when stored |

When a schedule is supplied, the task is stored with `schedule` (its `enabled`
defaulted to `true`), `nextOccurrenceAt` set equal to `schedule.firstOccurrenceAt`,
and `notificationEnabled` defaulted to `true` (unless you pass `false`). Invalid
schedules are rejected before any write (e.g. `repeatEvery: 0`, or a missing
`firstOccurrenceAt`/`timezone`).

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
>
> **Index-backed lists return a partial projection.** As a general rule, any list that
> reads from a GSI returns only the fields that index projects, not the full entity —
> non-projected fields come back `null`. `listUsersByOrganization` is the canonical
> example (it populates only `userId`, `displayName`, `role`). Use these lists for
> rosters/pickers, then `get*` the full entity by id when you need the rest; don't
> assume a list item is fully hydrated.

**Users & support**

| Operation | Input | Returns |
|---|---|---|
| `createUserProfile` | `input: { displayName!, organizationId, accessibilitySettings }` (`CreateMyUserProfileInput`) | `UserProfile` — creates the **caller's own** profile; `displayName` is required, while `userId` (Cognito `sub`), `email`, and `role` are derived server-side and cannot be supplied by the client |
| `getUserProfile` | `userId!` | `UserProfile` · `null` if not found |
| `listUsersByOrganization` | `organizationId!, limit, nextToken` | `UserProfileConnection!` — **roster only**: just `userId`, `displayName`, `role` are populated (orgIndex projection); other fields are `null` |
| `createSupportLink` | `input: { supporterId!, primaryUserId!, status, permissions }` | `SupportLink` · `status` defaults to `PENDING` |
| `listPrimaryUsersBySupporter` | `supporterId!, limit, nextToken` | `SupportLinkConnection!` |

> **Profile bootstrap — the client must create the profile on first run.** There is
> **no automatic profile creation.** The Cognito Post Confirmation trigger does one
> thing: it adds a newly-confirmed self-registered user to the `PrimaryUser` group. It
> does **not** write a `UserProfile` row. So after a user's first sign-in, the app must
> call **`createUserProfile`** itself (a "first-run, create my profile" step) before
> `getUserProfile(mySub)` will return anything. A typical flow:
>
> 1. Sign in → obtain the ID token; decode its `sub`.
> 2. `getUserProfile(sub)` → if `null`, the profile doesn't exist yet.
> 3. `createUserProfile({ displayName, … })` → creates it at `USER#<sub>` using the
>    session identity (no id is passed; see [Identity](#identity--the-userid-field)).
>
> **`createUserProfile` semantics.** The write is an unconditional put keyed on your
> `sub` — it is **last-write-wins, not create-only**. Calling it again **overwrites**
> the existing profile (and resets `createdAt`/`updatedAt` to "now"); it does **not**
> error on a pre-existing profile and does **not** merge. So guard it behind the
> `getUserProfile` null-check above, or treat a second call as a deliberate full
> replace. It is **not** idempotent in the value sense (timestamps change), though
> repeating it is harmless to the keying.
>
> **`createSupportLink` semantics.** Same shape: an unconditional put keyed on
> `(supporterId, primaryUserId)`. Re-creating the same pair **overwrites** the prior
> link — including resetting `status` back to its default `PENDING` if you omit
> `status` — rather than erroring on a duplicate. Pass `status` explicitly if you
> re-issue a link you don't want demoted.

**Categories**

| Operation | Input | Returns |
|---|---|---|
| `createCategory` | `input: { ownerId!, name!, color, sortOrder }` | `Category` · `ownerId`/`name`/`color` are trimmed; `categoryId` is server-generated |
| `listCategoriesByOwner` | `ownerId!, limit, nextToken` | `CategoryConnection!` — the owner's categories (`USER#<ownerId>` partition, `CATEGORY#` prefix) |

> Categories are folder-like groupings owned by one user. A task's `categoryId`
> points at one of these; tasks created without one fall into the reserved
> `NO_CATEGORY` bucket (which is **not** returned by `listCategoriesByOwner` — it has
> no `Category` row).

**Tasks & steps**

| Operation | Input | Returns |
|---|---|---|
| `getTask` | `taskId!` | `Task` · `null` if not found · `steps` is `null` here (use `listTaskSteps`) |
| `listTaskSteps` | `taskId!, limit, nextToken` | `TaskStepConnection!` — steps in ascending `order` |
| `listTasksByOwner` | `ownerId!, limit, nextToken` | `TaskConnection!` |
| `listTasksByCategory` | `ownerId!, categoryId, limit, nextToken` | `TaskConnection!` — tasks in one category; omit/blank `categoryId` for the `NO_CATEGORY` bucket |
| `updateTask` | `input: { taskId!, title, categoryId, description, scheduleRule, status, schedule, notificationEnabled }` | `Task` — **partial edit**; see below |
| `createTaskStep` | `input: { taskId!, order!, text!, mediaRefs }` | `TaskStep` |

> **`updateTask` is a partial edit.** Only the fields you include change; omitted
> fields keep their current value. `ownerId` is immutable and **steps are not edited
> here** (use `createTaskStep`; per-step editing isn't exposed yet). A missing
> `taskId` returns a not-found error rather than creating a row. Two coupled fields are
> kept consistent for you: changing `categoryId` recomputes the internal category key
> (so the task moves buckets in `listTasksByCategory`), and supplying a new `schedule`
> re-derives `nextOccurrenceAt`. A blank/omitted `categoryId` collapses to
> `NO_CATEGORY`, exactly as in `createTask`; `title`, if supplied, must be non-empty;
> and `notificationEnabled` only changes when you pass it explicitly. The `schedule`
> fields and validation are the same as [`createTask`](#createtask--mutation).
>
> ```graphql
> mutation UpdateTask($input: UpdateTaskInput!) {
>   updateTask(input: $input) { taskId title status categoryId updatedAt }
> }
> ```
> ```json
> { "input": { "taskId": "task-123", "title": "Wash hands well", "status": "ACTIVE", "categoryId": "cat-hygiene" } }
> ```

**Assignments & progress tracking**

| Operation | Input | Returns |
|---|---|---|
| `createAssignment` | `input: { taskId!, userId!, assignedBy, dueDate, recurrence, scheduleRule }` | `Assignment` · always created with persisted status `TO_DO`. Validates the `Task` exists, then snapshots its `TaskStep`s into one `AssignmentStep` per step (all `completed: false`), atomically. Errors if the task is missing or has > 99 steps (DynamoDB's 100-item transaction limit). |
| `updateAssignmentStatus` | `input: { userId!, assignmentId!, status! }` | `Assignment` · `status` accepts only `TO_DO`/`COMPLETED`/`SKIPPED` (`OVERDUE` is rejected). **Needs both `userId` and `assignmentId`** (they form the item key); errors if the assignment doesn't exist. Setting `COMPLETED` is rejected while any `AssignmentStep` is still incomplete (a zero-step assignment may be completed). Marking all steps complete does **not** auto-complete the assignment — the client sets `COMPLETED` explicitly. |
| `setAssignmentStepCompletion` | `input: { userId!, assignmentId!, stepId!, completed! }` | `AssignmentStep` · toggles one step. Sets `completedAt` to now when `completed: true`, clears it when `false`. Rejected if the assignment is `COMPLETED` or `SKIPPED`; 404s if the assignment or step doesn't exist for the user. |
| `listAssignmentsForUser` | `userId!, limit, nextToken` | `AssignmentConnection!` · `status` is returned with `OVERDUE` derived and legacy values mapped (see [breaking changes](#breaking-changes-progress--assignment-rework)). |
| `listAssignmentSteps` | `userId!, assignmentId!, limit, nextToken` | `AssignmentStepConnection!` · one assignment's step snapshots, sorted by `order`. |

**Media**

| Operation | Input | Returns |
|---|---|---|
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

Each entry in `errors` carries a `message` (prose, human-readable) and an `errorType`
(a code). **Branch on `errorType`, not on `message`** — message strings are not a
stable contract and may be reworded at any time.

### `errorType` codes

| `errorType` | HTTP | Meaning | Client should |
|---|---|---|---|
| `UnauthorizedException` | 401 | Missing/invalid/expired token at the AppSync edge — never reached a resolver | Re-authenticate (refresh the Cognito session) |
| `NOT_AUTHORIZED` | 200 | Authenticated, but not allowed to act on this id/resource | Handle as a normal denial — **see caveat below** |
| `VALIDATION` | 200 | Bad input (missing/empty required field, invalid schedule, etc.) | Fix the input; surface to the user |
| `NOT_FOUND` | 200 | The referenced id doesn't exist (e.g. `updateTask` on an unknown `taskId`, signing a download URL for an unregistered asset) | Treat as "gone"; distinct from a successful `null` on `get*` |
| `INTERNAL` | 200 | Resolver failure (Bedrock/KB error, downstream AWS error, unexpected bug) | Retry/backoff; report if persistent |
| (parse/validation) | 200/400 | Malformed query or unknown field — a client bug, not runtime data | Fix the query |

> ⚠️ **Stability caveat — current vs. intended.** The codes above are the **intended,
> stable contract**; build your client to branch on them. But in **this phase**, only
> the edge-level `UnauthorizedException` is emitted as shown. Resolver-level failures
> (validation, not-found, internal) are currently surfaced by AppSync as
> **`errorType: "Lambda:Unhandled"`**, with the specific cause only in `message`. The
> server already distinguishes these cases internally (`ValidationError` /
> `NotFoundError` / `UnauthorizedError`); wiring them through to the codes above is
> tracked under [Not available yet](#not-available-yet). Until then, if you must
> branch today, do so defensively (e.g. fall back to matching `message`) and migrate
> to `errorType` once the codes land. `NOT_AUTHORIZED` in particular does **not** fire
> yet — see the authorization warning at the top.

---

## Not available yet

Planned but not implemented — don't build against them:

- **Push notifications / reminder delivery** — `createTask` and `updateTask` accept
  and persist `schedule` metadata (and derive `nextOccurrenceAt` /
  `notificationEnabled`), but **nothing fires reminders yet**. There is no scheduling
  engine (EventBridge), no device-token registration, and no push-notification Lambda
  in this phase — only the query-ready fields are stored.
- **Per-role/owner authorization on domain operations** — the `SystemAdmin` admin
  queries are group-gated (enforced), and `createUserProfile` is self-scoped (it
  derives `userId`/`email`/`role` from the caller's Cognito session). The other
  create/get/list resolvers don't yet verify the caller (e.g. that a primary user
  only reads their own data, or that a supporter owns the task). The schema and
  single-table keys are structured to support these rules. **See the authorization
  warning at the top of this doc** — when these land, currently-succeeding calls on
  someone else's id will start returning a `NOT_AUTHORIZED` error.
- **Stable resolver `errorType` codes** — `VALIDATION` / `NOT_FOUND` / `NOT_AUTHORIZED`
  / `INTERNAL` (see [Error handling](#error-handling)) are the intended contract, but
  resolver errors currently surface as `Lambda:Unhandled` with the cause only in
  `message`. Branch defensively until the codes are wired through.
- **Delete** for any entity, and **update** for entities other than tasks
  (`updateTask`) and assignment status (`updateAssignmentStatus`) — including
  per-step editing (steps can only be created, via `createTaskStep`).
- **Report generation** — the `Report` type exists in the schema, but no query or
  mutation is exposed for it yet.
- **Streaming AI responses** — `generateTaskSteps` is request/response only.

---

## Breaking changes: progress & assignment rework

The `ProgressEvent`-based progress model was replaced by assignment-level status plus
per-assignment step completion. **This is a breaking API change.**

**Removed**

- `ProgressEvent` type, `ProgressEventType` enum, `ProgressEventConnection`,
  `CreateProgressEventInput`, the `createProgressEvent` mutation, and the
  `listProgressEventsForUser` query. The `canplan-progress-<env>` Lambda and its
  resolver wiring are gone.
- `Assignment.active` and the `active` input on `createAssignment` /
  `updateAssignmentStatus`.
- The `status` input on `createAssignment` — assignments are always created `TO_DO`.

**Changed — `AssignmentStatus`**

- New values: `TO_DO`, `OVERDUE`, `COMPLETED`, `SKIPPED`.
- Only `TO_DO`, `COMPLETED`, and `SKIPPED` are ever persisted. `OVERDUE` is **derived**
  at read time — an assignment is `OVERDUE` when its persisted status is `TO_DO`, it has
  a `dueDate`, and that `dueDate` is in the past. An assignment without a `dueDate` is
  never `OVERDUE`. Mutations reject an attempt to set `OVERDUE`.

**Added — per-assignment steps**

- `AssignmentStep` is an immutable snapshot of one `TaskStep` captured into one
  `Assignment` at creation (`assignmentId`, `taskId`, `stepId`, `order`, `text`,
  `mediaRefs`, `completed`, `completedAt`, `createdAt`, `updatedAt`).
  Editing the `Task` template later does **not** change historical assignments.
- `listAssignmentSteps(userId, assignmentId, …)` and
  `setAssignmentStepCompletion(input)` (see the operations table above).

**Data compatibility**

- Existing `Assignment` rows with legacy statuses are mapped on read so the new enum
  never surfaces an invalid value: `ACTIVE` → `TO_DO`, `PAUSED` → `TO_DO`,
  `CANCELLED` → `SKIPPED`, `COMPLETED` → `COMPLETED`. A legacy `active` attribute is
  dropped from responses.
- Legacy assignments created before this change have **no** `AssignmentStep` rows, so
  `listAssignmentSteps` returns empty for them. Only assignments created via the new
  `createAssignment` carry step snapshots.
- This is an API/code refactor only: existing `ProgressEvent` rows are **left in
  DynamoDB** (not deleted) — they are simply no longer served by any API.
