# CanPlan 2.0 — Frontend API Reference

_Last updated: 2026-06-28. Version: phase 1 (pre-authorization)._

> ## 🚨 Breaking change — categories, default category, Task status, TaskStep keys
>
> See [Breaking changes — categories & tasks rework](#breaking-changes-categories--tasks-rework)
> for full notes. In short:
>
> - **`Task.status` and the `TaskStatus` enum are removed** (output field + `createTask`/
>   `updateTask` inputs). Tasks no longer have a status.
> - **Real default category.** Every profile now owns one real Category named
>   `No Category` (`isDefault: true`), created with the profile; `Task.categoryId` is now
>   non-null and always a real Category.
> - **Categories are private to their owner.** `createCategory` no longer takes `ownerId`;
>   `listCategoriesByOwner` is replaced by **`listMyCategories`**. New: **`updateCategory`**,
>   **`deleteCategory`**. The owner is always the caller's Cognito identity.
> - **`createTask` no longer takes `ownerId`** (derived from the identity), and a supplied
>   `categoryId` must be a real, owned category.
> - **`TaskStep.description`** added; **`reorderTaskSteps`** mutation added.
>
> Scheduling was also reworked — a `Task` is now a template only and scheduling lives on
> `TaskAssignment`/`TaskInstance`. See
> [Breaking changes — scheduling rework](#breaking-changes-scheduling-rework).

The backend exposes a single **AWS AppSync GraphQL** endpoint backed by a single
DynamoDB table. This document covers how to connect, the available operations, and
how errors come back.

The schema lives at [graphql/schema.graphql](../graphql/schema.graphql) — it is the
canonical source of truth for exact types and nullability; this doc is its
human-readable companion.

> ## ⚠️ Authorization: Task & Category operations are owner-scoped; the rest are not yet
>
> **Enforced today:** the `SystemAdmin` admin queries; the **identity-scoped** creators
> (`createUserProfile`, `createTask`) and **all category** operations, which derive the
> owner from the caller's Cognito `sub` and ignore any client-supplied owner id; and
> **every Task / TaskStep operation** — `getTask`, `listTaskSteps`, `listTasksByOwner`,
> `listTasksByCategory`, `updateTask`, `deleteTask`, `createTaskStep`, `updateTaskStep`,
> `deleteTaskStep`, `reorderTaskSteps` — which require the caller's `sub` to equal the
> task's (or requested) `ownerId`, returning `NOT_AUTHORIZED` otherwise. There is no
> delegated-role model yet, so this is strict self-ownership.
>
> **Not enforced yet:** profile reads and the assignment / support-link operations still
> let any authenticated caller act on any `id` (read another user's profile, assign a task
> to any `userId`, link any supporter to any primary user). The schema and keys are
> structured to support per-role rules there, but they are **not implemented in this phase**.
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
  `createTaskAssignment`, `startTaskInstance`, `getTaskInstanceViews`,
  `listTaskInstanceSteps`, …) take a `userId`/`ownerId` **argument**. If you pass
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
| TaskStep | `TASK#<taskId>` | `STEP#<stepId>` (stable id key; `order` is a plain attribute) |
| TaskAssignment | `USER#<userId>` | `TASK_ASSIGNMENT#<assignmentId>` |
| TaskInstance | `USER#<userId>` | `TASK_INSTANCE#<scheduledDate>#<scheduledTime>#<assignmentId>` |
| TaskInstanceStep | `USER#<userId>` | `TASK_INSTANCE_STEP#<instanceId>#STEP#<stepId>` |
| MediaAsset | `TASK#<taskId>` | `MEDIA#<assetId>` |

Seven GSIs serve the cross-cutting lists: `supporterIndex` (users managed by a
supporter), `primaryUserSupportLinkIndex` (`SupportLink`s by primary user — keyed on
`userId`/`supporterId`, the inverse of `supporterIndex`; sparse to `SupportLink`,
used by `adminDeleteUser`), `orgIndex` (users in an organization), `taskOwnerIndex`
(task templates by owner), `taskCategoryIndex` (tasks within one owner's category —
keyed on a denormalized `<ownerId>#<categoryId>`, newest-first), `entityTypeIndex`
(every item of one `entityType`, newest-first — backs the SystemAdmin list-all APIs
without a Scan), and `activeTaskAssignmentTaskIndex` (active `TaskAssignment`s by their
source `taskId` — sparse: only an active assignment carries `activeTaskAssignmentTaskId`,
so `deleteTask` can prove no active assignment still references a template).

**Scheduling model.** A `Task` is a reusable **template only** — it carries no schedule.
A `TaskAssignment` is the schedule rule binding a template to a user (`ONE_TIME` or
`RECURRING` via an RRULE); it holds no status or step completion. A `TaskInstance` is one
concrete occurrence (created lazily by `startTaskInstance`/`cancelTaskInstance`) and holds
status + lifecycle timestamps; `instanceId = <assignmentId>#<scheduledDate>#<scheduledTime>`.
A `TaskInstanceStep` is an immutable per-occurrence step snapshot. `TaskInstance` SKs are
date-sorted, so `getTaskInstanceViews` reads a date window with one `BETWEEN` on the SK; a
`TASK_INSTANCE_STEP#…` SK does not collide with the `TASK_INSTANCE#<date>#…` instance prefix.

`TaskStep`s are keyed by their stable `stepId` (`STEP#<stepId>`), with `order` stored as
a plain attribute — so a step keeps its key when reordered and a whole-task reorder is one
atomic transaction (`reorderTaskSteps`). The `STEP#` rows are not key-sorted by position,
so `listTaskSteps` (and the steps returned by `reorderTaskSteps`) sort by the numeric
`order`. Every `Category` carries `isDefault`; each user has exactly one `isDefault: true`
row (`No Category`) created with their profile, and every `Task.categoryId` references a
real Category row. Categories also keep an internal, transactionally-maintained `taskCount`
(not exposed in GraphQL) that the backend uses to delete a category safely.

---

## Enums

| Enum | Values |
|---|---|
| `UserRole` | `PRIMARY_USER`, `SUPPORT_PERSON`, `ORG_ADMIN` — a server-derived projection of Cognito group membership (`PrimaryUser`/`SupportPerson`/`OrganizationAdmin`); **Cognito groups are the authorization source of truth**. `SystemAdmin` is an elevated group, not a `UserRole`. |
| `TaskAssignmentScheduleType` | `ONE_TIME`, `RECURRING` |
| `TaskInstanceStatus` | `TO_DO`, `IN_PROGRESS`, `OVERDUE`, `COMPLETED`, `SKIPPED`, `CANCELLED` — `OVERDUE` is **derived** at read time (a non-terminal occurrence whose `scheduledFor` is in the past) and cannot be set by a mutation; `CANCELLED` is set via `cancelTaskInstance` |
| `MediaType` | `IMAGE`, `AUDIO`, `VIDEO` |
| `SupportLinkStatus` | `PENDING`, `ACTIVE`, `REVOKED` |

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

Creates a **reusable task template** owned by the authenticated caller, plus one
`TaskStep` item per nested step (each stored as its own row). A `Task` carries **no
schedule** — scheduling a task for a user is a separate operation, see `createTaskAssignment`.

**Input — `CreateTaskInput`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | `String!` | ✅ | Non-empty after trimming |
| `categoryId` | `ID` | — | Optional; omitted/null ⇒ the owner's default category. A **blank string is rejected**. A supplied id must be a real, owned, non-deleting Category (see below) |
| `description` | `String` | — | Optional |
| `steps` | `[CreateTaskStepNestedInput!]` | — | Ordered; each becomes a `STEP#<stepId>` item; max **97**, or max **96** when `coverImageS3Key` is supplied |
| `coverImageS3Key` | `String` | — | Optional cover image (pending key from `createTaskCoverImageUploadUrl`) |

> **No `ownerId`.** The owner is the caller's Cognito `sub`; a client-supplied `ownerId`
> is ignored. The owner must already have a profile (and therefore a default category) —
> call `createUserProfile` first, or `createTask` fails clearly.

`CreateTaskStepNestedInput`: `text: String!` plus optional `description: String` (trimmed;
empty/whitespace dropped). Step media is attached afterward via the upload flow, since step
ids don't exist until `createTask` returns.

**Category behavior.** Every task belongs to a **real** Category. If you omit `categoryId`
(or send `null`), the task is filed under the owner's **default category** (`No Category`,
`isDefault: true`). A **blank string** is rejected — omit the field instead. A supplied id
is validated: it must exist, belong to you, and not be mid-deletion (otherwise `NOT_FOUND`
/ `VALIDATION`). The write atomically increments the category's task count (conditioned on
the category existing and not deleting), so a concurrent `deleteCategory` can't slip a task
onto a category being removed. The returned `Task.categoryId` is always a real category id
(never `null`). Before using the default, the server strongly reads and verifies the profile
pointer and referenced Category: correct owner, exact `No Category` name, `isDefault: true`,
and no deletion in progress. A bad legacy row fails with a migration-required validation error.

**Step limit & the 100-item transaction.** A create is one DynamoDB transaction carrying
the Task, one row per step, a category condition-check, the owner's profile-counter update
(see _Ordering_ below), and (optionally) the cover-image row — capped at 100 items. So a
task may have at most **97** steps (96 with a cover image).

**Ordering & the per-owner task cap.** Every task gets a per-owner display **`order`**
(`Task.order`, an `Int`), assigned automatically on create from a monotonic counter on the
owner's profile (`nextTaskOrder`) — you do **not** pass `order` to `createTask`. The same
transaction increments the owner's `taskCount`, which **caps an owner at 50 tasks**: a 51st
`createTask` is rejected with `VALIDATION` (`an owner may have at most 50 tasks`). Orders are
per-owner and may have **gaps** — `deleteTask` decrements `taskCount` but never reclaims or
renumbers orders, and gaps are harmless. Reorder the whole set with
[`updateTaskOrder`](#tasks--steps); `listTasksByOwner` returns tasks sorted by ascending
`order` (un-ordered legacy rows last). `Task.order` is `null` only on un-migrated legacy rows.

**No schedule on a Task.** A `Task` is a reusable template only and stores no scheduling
fields (`scheduleRule`, `schedule`, `nextOccurrenceAt`, `notificationEnabled` were all
removed). To schedule a task for a user, create a `TaskAssignment` — see the
**Scheduling — task assignments & instances** operations under [Operations](#operations).

**Returns — `Task`** (with the `steps` it just created)

```graphql
mutation CreateTask($input: CreateTaskInput!) {
  createTask(input: $input) {
    taskId
    ownerId
    title
    categoryId
    order
    createdAt
    steps { stepId order text description }
  }
}
```

```json
{
  "input": {
    "title": "Wash your hands",
    "categoryId": "cat-hygiene",
    "steps": [
      { "text": "Wet your hands with warm water" },
      { "text": "Add soap and scrub for 20 seconds", "description": "Sing happy birthday twice" },
      { "text": "Rinse and dry" }
    ]
  }
}
```

The created steps are returned in `order` (`1`, `2`, `3`, …) — clients work with the
`order` field, not the internal `STEP#<stepId>` sort key.

---

### Other operations

These follow the same request/response conventions. `create…`/`update…` are
mutations; `get…`/`list…` are queries. In the **Input** columns below, required
fields are marked `!` and everything else is optional; see
[schema.graphql](../graphql/schema.graphql) for full nullability of the returned types.

> **All `list*` queries are paginated.** Each accepts optional `limit` (page size)
> and `nextToken`, and returns a `{ items, nextToken }` **connection** (e.g.
> `listTaskSteps` → `TaskStepConnection`, `listTaskAssignmentsForUser` →
> `TaskAssignmentConnection`). `nextToken` is an opaque, base64-encoded cursor — pass it
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
| `createUserProfile` | `input: { displayName!, organizationId, accessibilitySettings }` (`CreateMyUserProfileInput`) | `UserProfile` — creates the **caller's own** profile **and its default category** atomically; `displayName` is required, while `userId` (Cognito `sub`), `email`, `role`, and `defaultCategoryId` are derived server-side and cannot be supplied by the client |
| `updateMyUserProfile` | `input: { displayName, accessibilitySettings }` (`UpdateMyUserProfileInput`) | `UserProfile!` — **partial** update of the **caller's own** profile; see below |
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
>    session identity (no id is passed; see [Identity](#identity--the-userid-field)),
>    together with the user's default `No Category` (see [Categories](#categories)).
>
> **`createUserProfile` semantics.** On the **first** call it writes the profile and its
> default category in one transaction; the profile records the generated
> `defaultCategoryId`. The profile write is **last-write-wins, not create-only** — calling
> it again **overwrites** the editable profile fields (and resets `createdAt`/`updatedAt`
> to "now"); it does **not** error on a pre-existing profile and does **not** merge. A
> re-call **preserves** the existing `defaultCategoryId` and never creates a second default
> category. So guard it behind the `getUserProfile` null-check above, or treat a second
> call as a deliberate full replace of the editable fields.
>
> **`updateMyUserProfile` semantics.** A **partial update** of the **caller's own** profile
> only — the owner is the Cognito `sub`, never a client-supplied `userId`, so a caller can
> only edit their own row. Unlike `createUserProfile`, it **never creates** a profile or a
> default category: if no profile exists it returns **NotFound** (the write is conditioned on
> the row existing). Only **`displayName`** and **`accessibilitySettings`** are editable — every
> other field (`userId`, `email`, `role`, **`organizationId`**, `defaultCategoryId`,
> `createdAt`) is left untouched and **cannot be changed through this mutation**. Supply at
> least one of the two editable fields (an empty input is rejected). Per-field rules:
>
> - **`displayName`** — omitted ⇒ unchanged; otherwise it is **trimmed**, and `null`, empty,
>   or whitespace-only values are rejected.
> - **`accessibilitySettings`** — omitted ⇒ unchanged; explicit **`null`** ⇒ the field is
>   **cleared**; a non-null value ⇒ a **full replacement** of the stored settings — it is
>   **not** deep-merged with the previous value. As elsewhere, this is an `AWSJSON` field:
>   send `JSON.stringify(settings)` and `JSON.parse` it back off the returned profile (see
>   [AWSJSON fields](#awsjson-fields--encoding-foot-gun)).
>
> The server also stamps a fresh `updatedAt`. Use this for ordinary profile edits; use
> `createUserProfile` only for first-run creation (or a deliberate full replace).
>
> **`createSupportLink` semantics.** Same shape: an unconditional put keyed on
> `(supporterId, primaryUserId)`. Re-creating the same pair **overwrites** the prior
> link — including resetting `status` back to its default `PENDING` if you omit
> `status` — rather than erroring on a duplicate. Pass `status` explicitly if you
> re-issue a link you don't want demoted.

**Categories** (all **private to the caller** — the owner is the Cognito identity, never a
client-supplied id)

| Operation | Input | Returns |
|---|---|---|
| `createCategory` | `input: { name!, color, sortOrder }` | `Category` · `name`/`color` trimmed; `categoryId` server-generated; `isDefault: false`. The reserved name `No Category` is rejected |
| `listMyCategories` | `limit, nextToken` | `CategoryConnection!` — the caller's categories (incl. their `isDefault` default) |
| `updateCategory` | `input: { categoryId!, name, color, sortOrder }` | `Category!` — partial edit; see below |
| `deleteCategory` | `input: { categoryId! }` | `Category!` — the deleted (non-default) category; reparents its tasks first; see below |

> **The default category.** Every user has exactly one default Category named
> `No Category` with `color: "#64748B"` and `isDefault: true`, created atomically with their profile
> (`createUserProfile`). Use `Category.isDefault` to identify it. A task created without an
> explicit `categoryId` is filed under it. It **cannot be renamed or deleted**; its `color`
> and `sortOrder` **can** be changed. You also cannot create or rename another category to
> `No Category`. The runtime strongly validates the profile pointer and exact canonical
> default row before using it; malformed legacy data must be repaired by the migration.
>
> **`updateCategory` is a partial edit** — supply at least one of `name`, `color`,
> `sortOrder` (a request with none is rejected). Located by `categoryId` under your own
> partition (`NOT_FOUND` if it isn't yours / doesn't exist). For a normal category, `name`
> is trimmed, must be non-empty, and may not be the reserved `No Category`. For the
> **default** category, supplying `name` at all is rejected (even if unchanged) — only
> `color`/`sortOrder` are allowed. `color`/`sortOrder` may be **cleared** with an explicit
> `null` (a `null` `name` is rejected). It is a **targeted update** that preserves internal
> state, and it **cannot** run on a category that is mid-deletion (returns a clear error).
>
> **`deleteCategory` reparents, then deletes.** The **default category cannot be deleted**.
> For a normal category, the server (1) flags it `deleting` so new tasks can't attach to (or
> move into) it, (2) moves **every** task in it to your default category — each move adjusts
> both categories' internal task counts in the same transaction — then (3) removes the
> category row **only once a strongly-consistent read proves its task count is zero**.
> Returns the deleted category.
>
> _Consistency note:_ a category may hold arbitrarily many tasks (more than one DynamoDB
> transaction can carry), so deletion runs **across multiple batches** internally and is
> **safe to retry**. Because the category index is eventually consistent, the backend does
> **not** trust an empty index query as proof there are no tasks — it tracks a durable,
> transactionally-maintained task count and deletes only when that count reaches zero. A
> failed/interrupted run (or a task the index hasn't surfaced yet) leaves the category in
> the `deleting` state and returns a **retryable** error; re-running converges and never
> leaves a task pointing at a deleted category.
>
> ```graphql
> mutation DeleteCategory($input: DeleteCategoryInput!) {
>   deleteCategory(input: $input) { categoryId name isDefault }
> }
> ```

**Tasks & steps**

| Operation | Input | Returns |
|---|---|---|
| `getTask` | `taskId!` | `Task` · `null` if not found · `steps` is `null` here (use `listTaskSteps`) · owner-only |
| `listTaskSteps` | `taskId!, limit, nextToken` | `TaskStepConnection!` — steps sorted by ascending `order`, order preserved across pages; owner-only; see below |
| `listTasksByOwner` | `ownerId!, limit, nextToken` | `TaskConnection!` — tasks sorted by ascending per-owner `order` (un-ordered legacy rows last), order preserved across pages; `ownerId` must be the caller |
| `listTasksByCategory` | `ownerId!, categoryId!, limit, nextToken` | `TaskConnection!` — tasks in one real category; **`categoryId` is required** and is validated (owned + exists + not deleting → `NOT_FOUND`/`VALIDATION`, never a silent empty result); `ownerId` must be the caller |
| `updateTask` | `input: { taskId!, title, categoryId, description, coverImageS3Key }` | `Task` — **partial edit**; owner-only; see below |
| `createTaskStep` | `input: { taskId!, order!, text!, description, media }` | `TaskStep` — **appends** one step at the end, optionally with initial type-specific media (owner-only); see below |
| `updateTaskStep` | `input: { taskId!, stepId!, text, description, media }` | `TaskStep` — **partial edit** of one step and its type-specific media slots; see below |
| `deleteTaskStep` | `input: { taskId!, stepId! }` | `TaskStep` — the deleted step; also deletes all its media assets; see below |
| `reorderTaskSteps` | `input: { taskId!, steps: [{ stepId!, order! }] }` | `[TaskStep!]!` — atomically renumbers all steps; see below |
| `updateTaskOrder` | `input: { tasks: [{ taskId!, order! }] }` | `[Task!]!` — atomically reorders **all of the caller's tasks** in one transaction; see below |
| `deleteTask` | `taskId!` | `Task` — the deleted template (minus internal fields); cascades to all its steps + media; see below |

> **`updateTask` is a partial edit.** Only the fields you include change; omitted
> fields keep their current value. `ownerId` is immutable and **steps are not edited
> here** (use `createTaskStep`/`reorderTaskSteps`; per-step content editing is
> `updateTaskStep`). A missing `taskId` returns a not-found error rather than creating a
> row. Changing `categoryId` recomputes the internal category key (so the task moves buckets
> in `listTasksByCategory`). A supplied `categoryId` must be a real category **you own** and
> not mid-deletion; moving the task decrements the old category's internal task count and
> increments the new one's **in the same transaction** (so a concurrent `deleteCategory`
> can't attach the task to a category being removed). A **blank string is rejected** (omit it
> to leave the category unchanged). `title`, if supplied, must be non-empty. A `Task` has no
> schedule fields to edit — scheduling lives on `TaskAssignment`.
>
> ```graphql
> mutation UpdateTask($input: UpdateTaskInput!) {
>   updateTask(input: $input) { taskId title categoryId updatedAt }
> }
> ```
> ```json
> { "input": { "taskId": "task-123", "title": "Wash hands well", "categoryId": "cat-hygiene" } }
> ```

> **`updateTaskStep` is a partial edit of one step.** Identify the step by `taskId` +
> `stepId`. **Supply at least one of `text`, `description`, or a non-empty `media` list** —
> a request with none is rejected. A supplied `text` is trimmed and may **not** be empty.
> **`description` semantics:** omitted ⇒ unchanged; explicit `null` ⇒ clears the stored
> description; a whitespace-only string is rejected; otherwise it's trimmed and stored.
> `stepId`, `taskId`, and `createdAt` are immutable, and `order` changes only via
> `reorderTaskSteps`; `updatedAt` is bumped. A missing step returns a not-found error. To
> remove the whole step, use `deleteTaskStep` (below).

> **`reorderTaskSteps` atomically renumbers a task's steps.** Supply the **complete current
> set** of the task's steps as `[{ stepId, order }]` (not a partial patch). The server
> validates that every `stepId` exists under the task, each appears exactly once, and the
> `order`s are **unique positive integers contiguous from 1..N** (max 99 steps). All steps'
> `order` attributes are updated in **one DynamoDB transaction** (all-or-nothing); step ids,
> attached media, task contents, and existing `TaskInstanceStep` snapshots are **never** touched.
> Returns the resulting steps sorted by ascending `order`.
>
> ```graphql
> mutation Reorder($input: ReorderTaskStepsInput!) {
>   reorderTaskSteps(input: $input) { stepId order text }
> }
> ```
> ```json
> { "input": { "taskId": "task-123", "steps": [
>   { "stepId": "step-c", "order": 1 },
>   { "stepId": "step-a", "order": 2 },
>   { "stepId": "step-b", "order": 3 }
> ] } }
> ```

> **`updateTaskOrder` atomically reorders all of the caller's tasks.** This sets the
> per-owner `Task.order` across the owner's whole task list (the task-level analogue of
> `reorderTaskSteps`, which orders steps *within* one task). The owner is taken from the
> Cognito identity — there is **no `ownerId` in the input**. Supply the **complete current
> set** of your tasks as `[{ taskId, order }]` (not a partial patch):
>
> - Every `order` must be a **positive integer** and **unique** across the list; values
>   **need not be contiguous `1..N`** — gaps are allowed (the client decides the spacing).
> - The list must match your tasks **exactly**: each owned `taskId` appears **once**, with no
>   missing or extra task. A wrong count is a `VALIDATION` error; an unknown/foreign `taskId`
>   is `NOT_FOUND`. The cap is the same 50 tasks per owner.
>
> All tasks' `order` attributes are updated in **one DynamoDB transaction** (all-or-nothing);
> task ids, steps, media, categories, and task assignments/instances are **never** touched. If the
> owner's task set changed concurrently (a task was added/removed between your read and this
> call), the transaction is canceled and you get a retryable `VALIDATION` error — reload your
> tasks and retry. Returns the tasks sorted by ascending `order`.
>
> ```graphql
> mutation UpdateTaskOrder($input: UpdateTaskOrderInput!) {
>   updateTaskOrder(input: $input) { taskId title order updatedAt }
> }
> ```
> ```json
> { "input": { "tasks": [
>   { "taskId": "task-c", "order": 1 },
>   { "taskId": "task-a", "order": 2 },
>   { "taskId": "task-b", "order": 3 }
> ] } }
> ```

> **`createTaskStep` appends one step at the end.** The task must exist and be yours, and a
> task may hold **at most 99 steps**. The new step is created at the server-maintained next
> append position (monotonic between reorders; 1 for a new task); the `order` you pass **must
> equal** that position — any other value (including one that duplicates an existing step) is
> rejected. To insert in the middle or reorder, create at the end and then call
> **`reorderTaskSteps`**. A missing/foreign task returns `NOT_FOUND`/`NOT_AUTHORIZED` (no
> orphan steps are ever created).
>
> A standalone create may include `media: [{ type, assetId }]` to attach existing uploaded
> assets in the same transaction as the new step. Each type is allowed once and every entry
> requires a non-null `assetId` of that exact type. The nested `createTask.steps` input does
> not accept media because its task/step IDs do not exist until the create completes; upload
> and attach those assets afterward with `updateTaskStep`.
>
> _Concurrency note:_ appends are optimistic-concurrency controlled by internal Task step
> metadata. From the same prior state, exactly one simultaneous `createTaskStep` succeeds;
> every loser receives a retryable validation/conflict error and must reload then retry. No
> duplicate `order` values are created. `deleteTaskStep` may leave a gap in `order` — that's
> fine; ordering is numeric, and `reorderTaskSteps` renumbers it.

> **`listTaskSteps` pagination is order-stable.** A task has at most 99 (small) steps, so the
> backend reads them all, sorts by numeric `order` (with `stepId` as a stable tiebreaker),
> then paginates **in application code**. `nextToken` is an **opaque, base64-encoded offset**
> into that sorted list — **not** a DynamoDB key — and is `null` on the last page. Ascending
> `order` is therefore preserved across pages (unlike a raw key-order scan). The same numeric
> ordering is returned by `reorderTaskSteps`.

> **A step holds up to three media assets:** at most one `IMAGE`, one `AUDIO`, and one
> `VIDEO`. `TaskStep.mediaAssets` returns the attached `MediaAsset` objects in that order;
> use each `assetId` with `getMediaDownloadUrl` to obtain a viewable URL.
>
> Set media through `media: [{ type, assetId }]`. Each type may appear **once** in a
> request; omitted types are unchanged.
>
> - A non-null `assetId` attaches a currently-unattached asset of exactly that `type`. It
>   must belong to the same task and cannot be the Task cover. If the step already has an
>   asset of that type, the new one is committed first and the old metadata row + S3 binary
>   are then deleted. Assets of the other two types are preserved.
> - `assetId: null` removes and deletes only the current asset of that type.
> - Concurrent media edits are versioned: conflicting callers receive a retryable validation
>   error and must reload the step. This prevents two assets of the same type on one step.
>
> ```graphql
> mutation UpdateTaskStep($input: UpdateTaskStepInput!) {
>   updateTaskStep(input: $input) {
>     stepId taskId order text description
>     mediaAssets { assetId type mimeType stepId }
>     updatedAt
>   }
> }
> ```
> ```json
> { "input": { "taskId": "task-123", "stepId": "step-9", "media": [
>   { "type": "IMAGE", "assetId": "image-asset-7" },
>   { "type": "AUDIO", "assetId": "audio-asset-3" },
>   { "type": "VIDEO", "assetId": "video-asset-5" }
> ] } }
> ```

> **`deleteTaskStep` removes one step and every attached media asset.** Identify the step by
> `taskId` + `stepId` (located directly by its stable `STEP#<stepId>` key). Returns the
> deleted `TaskStep` (internal fields stripped); a missing step returns a not-found error.
>
> **Media cleanup.** Every asset whose `stepId` is the deleted step has its metadata row +
> S3 binary deleted. Each media asset belongs to exactly one step (or the cover), so there
> is nothing shared to preserve.
>
> **Not touched:** the `Task` itself, any other `TaskStep`, and — importantly — **any
> `TaskAssignment`, `TaskInstance`, or `TaskInstanceStep`**. Existing per-occurrence step
> snapshots are immutable; removing a template step never alters them, and a future
> `startTaskInstance` simply snapshots the task's remaining steps.
>
> _Consistency note:_ uses the same media-cleanup policy as `deleteMediaAsset` (delete row →
> delete S3 binary, DB-first, structured-logged; cover references are cleared when relevant).
> It is safe to retry; if an S3 delete fails it does **not** silently claim success — the
> metadata is already gone and the operation returns a retryable error with the failure
> logged for cleanup.
>
> ```graphql
> mutation DeleteTaskStep($input: DeleteTaskStepInput!) {
>   deleteTaskStep(input: $input) { stepId taskId order text }
> }
> ```

> **`deleteTask` removes a template and all its steps.** Deletes the `Task` `#META` item
> **and every `TaskStep`** under it, then returns the deleted `Task` (with internal
> storage fields such as `PK`/`SK`/`entityType` stripped). A missing `taskId` returns a
> not-found error.
>
> **`deleteTask` cascades to all task-owned media.** It deletes the `Task` `#META` item,
> **every `TaskStep`**, **every `MediaAsset` row** under the task (cover image, step media,
> and any task-level media without a `stepId`), and **each of those `MediaAsset`s' S3
> binaries**. Nothing task-owned — DynamoDB rows, S3 objects, or cover/step references —
> is left behind.
>
> **Rejected while an active `TaskAssignment` references the task.** `deleteTask` first
> queries `activeTaskAssignmentTaskIndex`; if any **active** assignment still schedules this
> template, the delete is rejected with a `VALIDATION` error — end or delete those
> assignments first (`endTaskAssignment` / `deleteTaskAssignment`). Existing `TaskInstance`
> and `TaskInstanceStep` rows (under `USER#` partitions) are never touched and **remain
> readable** after the template is deleted.
>
> _Consistency note:_ a task with **>99 children** exceeds DynamoDB's 100-item transaction
> limit, so deletion is **not** a single atomic transaction. Before any `MediaAsset` row
> is removed, the backend writes durable cleanup-journal rows containing its S3 key.
> `TaskStep` and `MediaAsset` rows are then bulk-deleted in batches (children first). The
> journal drives S3 deletion and is removed only after every binary is deleted; only then
> is `#META` removed. If a batch or S3 delete fails, the Task and journal remain so a retry
> can finish cleanup without losing an S3 key.
>
> ```graphql
> mutation DeleteTask($taskId: ID!) {
>   deleteTask(taskId: $taskId) { taskId title categoryId }
> }
> ```

**Scheduling — task assignments & instances**

A `Task` is a reusable template. To put it on a user's calendar, create a
`TaskAssignment` (the schedule rule). Occurrences are **virtual** until a user acts on one:
`getTaskInstanceViews` expands an active assignment's occurrences over a date range and
overlays any real `TaskInstance` rows; `startTaskInstance` materializes one occurrence and
snapshots the task's current steps into `TaskInstanceStep` rows.

| Operation | Input | Returns |
|---|---|---|
| `createTaskAssignment` | `input: { taskId!, userId!, assignedBy, scheduleType!, scheduledFor, scheduleRule, startDate, endDate, startTime, timezone! }` | `TaskAssignment!` · validates the `Task` exists and the schedule, then writes **one** row — **no** `TaskInstance`s. `ONE_TIME` requires `scheduledFor` + `timezone`; `RECURRING` requires `scheduleRule` (an RRULE) + `startDate` + `startTime` + `timezone` (`endDate` optional). The RRULE must carry a `FREQ` of `DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY` — incomplete rules and `HOURLY`/`MINUTELY`/`SECONDLY` are rejected. An active assignment carries the sparse `activeTaskAssignmentTaskId` marker. |
| `startTaskInstance` | `input: { userId!, assignmentId!, scheduledDate!, scheduledTime! }` | `TaskInstance!` · verifies the occurrence is valid for the assignment; if no instance exists, creates it (`IN_PROGRESS`, `startedAt` set) and snapshots the current `TaskStep`s into `TaskInstanceStep` rows **atomically**. **Idempotent** — an existing instance is returned untouched (steps are never re-snapshotted). |
| `setTaskInstanceStepCompletion` | `input: { userId!, instanceId!, stepId!, completed! }` | `TaskInstanceStep!` · toggles one step. Sets/clears `completedAt`. Rejected on a **terminal** (`COMPLETED`/`SKIPPED`/`CANCELLED`) instance; 404s if the instance or step doesn't exist. |
| `updateTaskInstanceStatus` | `input: { userId!, instanceId!, status! }` | `TaskInstance!` · `status` accepts `IN_PROGRESS`/`COMPLETED`/`SKIPPED` (`OVERDUE` is rejected — derived; `CANCELLED` uses `cancelTaskInstance`). `COMPLETED` is rejected while any step is incomplete (a zero-step instance may be completed). |
| `cancelTaskInstance` | `input: { userId!, assignmentId!, scheduledDate!, scheduledTime! }` | `TaskInstance!` · creates or updates a real `TaskInstance` with status `CANCELLED` and `isException: true`, so the occurrence stops surfacing as an open virtual slot. Rejected on a **terminal** (`COMPLETED`/`SKIPPED`/`CANCELLED`) instance — a finished occurrence can't be cancelled. |
| `endTaskAssignment` | `input: { userId!, assignmentId!, effectiveDate! }` | `TaskAssignment!` · for a `RECURRING` assignment with days remaining, caps `endDate` to the day before `effectiveDate` — taking the **earlier** of that and any existing `endDate`, so it only ever shortens the window (stays active); otherwise fully ends it (`active: false`, `endedAt` set, marker removed). |
| `deleteTaskAssignment` | `input: { userId!, assignmentId! }` | `TaskAssignment!` · **soft delete** — `active: false`, `endedAt` set, `activeTaskAssignmentTaskId` removed (unblocking `deleteTask`). 404s if missing. |
| `listTaskAssignmentsForUser` | `userId!, limit, nextToken` | `TaskAssignmentConnection!` · a user's schedule rules (active + ended). |
| `getTaskInstanceViews` | `userId!, startDate!, endDate!` | `TaskInstanceViewConnection!` · the calendar feed (both dates `YYYY-MM-DD`, **max 370-day** span). See below. |
| `listTaskInstanceSteps` | `userId!, instanceId!, limit, nextToken` | `TaskInstanceStepConnection!` · one instance's step snapshots, sorted by `order`. |

> **`getTaskInstanceViews` is the calendar feed.** For `[startDate, endDate]` it (1) queries
> the user's `TaskAssignment`s, (2) expands **active** assignments' virtual occurrences within
> the window using a real recurrence library (`rrule` + `luxon`, so a `09:00` local rule keeps
> firing at `09:00` across DST), (3) queries the real `TaskInstance` rows in the window
> (date-sorted SK `BETWEEN`), (4) **overlays** real instances onto their virtual slots, and
> (5) returns a virtual view (`isVirtual: true`, `instanceId: null`) for each scheduled
> occurrence with no real instance yet. A real instance with no matching virtual slot (e.g. a
> `CANCELLED` exception, or one from a since-ended assignment) is still surfaced. `status` is
> returned with `OVERDUE` **derived** (a non-terminal occurrence whose `scheduledFor` is past).
>
> ```graphql
> query Calendar($userId: ID!, $startDate: String!, $endDate: String!) {
>   getTaskInstanceViews(userId: $userId, startDate: $startDate, endDate: $endDate) {
>     items { instanceId assignmentId taskId title scheduledDate scheduledTime status isVirtual isException }
>   }
> }
> ```

**Media**

| Operation | Input | Returns |
|---|---|---|
| `createMediaUploadUrl` | `input: { taskId!, contentType!, fileName }` | `MediaUploadTarget` — see flow below |
| `createTaskCoverImageUploadUrl` | `input: { contentType!, fileName }` | `MediaUploadTarget!` — temporary cover-image upload; see [cover images](#task-cover-images) |
| `createMediaAsset` | `input: { taskId!, s3Key!, type!, mimeType!, ownerId!, size }` | `MediaAsset` — initially unattached; see flow below |
| `deleteMediaAsset` | `input: { taskId!, assetId! }` | `MediaAsset` — deletes the binary + row + dangling refs; see below |
| `getMediaDownloadUrl` | `taskId!, assetId!` | `MediaDownloadTarget` — see flow below |
| `listMediaForTask` | `taskId!, limit, nextToken` | `MediaAssetConnection!` |

> **Media is upload-first.** Binaries live in the S3 media bucket; DynamoDB stores
> only the `s3Key` and metadata (`type`, `mimeType`, `ownerId`, `size`). Newly created
> media is initially unattached. Clients never need AWS credentials — they upload through
> a presigned URL:
>
> 1. **`createMediaUploadUrl({ taskId, contentType, fileName? })`** → returns
>    `{ uploadUrl, s3Key, expiresIn }`. `uploadUrl` is a short-lived (default 15 min)
>    presigned **PUT**; `s3Key` is server-chosen (`media/<taskId>/<uuid>.<ext>`).
> 2. **`PUT` the raw file bytes to `uploadUrl`** with the same `Content-Type` you
>    passed as `contentType` (direct browser/mobile upload to S3 — the bucket allows
>    CORS PUT). No GraphQL, no credentials.
> 3. **`createMediaAsset({ taskId, s3Key, type, mimeType, ownerId, size? })`**
>    → registers the now-uploaded object's metadata. Attach it in a standalone
>    `createTaskStep({ media: [{ type, assetId }] })` or later with
>    `updateTaskStep({ media: [{ type, assetId }] })`.
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

> **`deleteMediaAsset({ taskId, assetId })`** permanently removes one media asset: its
> **S3 binary** and its **DynamoDB row**, after first clearing every API-visible
> reference to it — if it was the task's cover image, `Task.coverImageAssetId` is
> cleared; if it belongs to a step, it no longer appears in that step's derived
> `mediaAssets` list. The `Task` and its `TaskSteps` are **not** deleted. Returns the deleted asset (internal storage
> fields stripped); a missing asset returns a not-found error.
>
> _Consistency & sharing:_ DynamoDB and S3 aren't transactional, so references and the
> metadata row are deleted **first**, then the S3 object — the API never points at a
> file that's gone. The call is **idempotent/retryable** (a re-run returns not-found;
> S3 delete is a no-op for an already-absent object). If the S3 delete fails after the
> row is gone, the failure is **logged with `taskId`/`assetId`/`s3Key`** for a
> retry/cleanup job (never silently ignored) and leaves only an orphaned binary, not a
> dangling reference. **Each media asset belongs to exactly one `Task`** (it lives under
> `TASK#<taskId>`) and is deleted with it — assets are not shared across tasks.

---

### Task cover images

A `Task` may have **one optional cover image** (`Task.coverImageAssetId`, nullable). The
file is an ordinary private-S3 object recorded as a `MediaAsset` (`type: IMAGE`, no
`stepId`). Binary bytes never travel through GraphQL — the existing presigned-PUT flow is
used, with a temporary key so it also works at **create** time (before a `taskId` exists).

**Sequence (create or update):**

1. **`createTaskCoverImageUploadUrl({ contentType, fileName? })`** → `{ uploadUrl, s3Key,
   expiresIn }`. `contentType` must be `image/jpeg`, `image/png`, or `image/webp` (others
   are rejected). `s3Key` is a server-owned **pending** key
   (`media/pending/task-cover/<uuid>.<ext>`).
2. **`PUT` the image bytes to `uploadUrl`** with that same `Content-Type` (direct to S3).
3. Pass the pending `s3Key` as **`coverImageS3Key`** to **`createTask`** or
   **`updateTask`**. The server then, server-side:
   - rejects any key not under the pending prefix (no arbitrary keys);
   - **`HeadObject`** verifies the *real* object — it must exist, be an allowed image
     type, and be `0 < size ≤ 10 MB` (client-declared MIME/size are never trusted);
   - copies it to a task-owned key (`media/<taskId>/<assetId>.<ext>`), deletes the temp
     object, registers the `MediaAsset`, and sets `Task.coverImageAssetId`.
4. **To display it:** call **`getMediaDownloadUrl(taskId, coverImageAssetId)`** — there is
   no cover URL exposed directly on `Task`.

```graphql
mutation CoverUrl($input: CreateTaskCoverImageUploadUrlInput!) {
  createTaskCoverImageUploadUrl(input: $input) { uploadUrl s3Key expiresIn }
}
# then: PUT bytes to uploadUrl, then createTask/updateTask with coverImageS3Key: <s3Key>
```

- **On `createTask`:** the cover `MediaAsset` row is written **in the same transaction**
  as the `Task` + `TaskStep`s. If that write fails after the S3 copy, the copied object is
  best-effort deleted and the original error is preserved.
- **On `updateTask`:** supplying `coverImageS3Key` **replaces** the cover. The new asset
  is verified, copied, and persisted (Task + new `MediaAsset`) atomically **first**; only
  then is the **old** cover's row + S3 object removed (best-effort). Omitting
  `coverImageS3Key` leaves the current cover unchanged. A new cover is never rolled back if
  old-cover cleanup fails — that failure is logged (`taskId`, old `assetId`, `s3Key`) for
  retry.
- Abandoned pending uploads (`media/pending/task-cover/`) are expired by an **S3 lifecycle
  rule after 24h**.

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
| `adminGetUserData(userId!)` | `AdminUserData!` — full read-only snapshot of one user; see below |

`listAllUsers`/`listAllTasks` take an optional `limit` (page size) and `nextToken`, and
return `{ items, nextToken }`. `nextToken` is an **opaque, base64-encoded** cursor — pass
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

> **`adminGetUserData(userId)` is a one-shot, unpaginated snapshot** of everything one
> user owns — built for the admin user-detail view. It returns a single `AdminUserData`,
> **not** a connection: there is no `limit`/`nextToken`, and the backend internally pages
> through each list to completion. All reads are **PK queries + GSIs (no Scan)**, fired in
> parallel:
>
> | Field | Type | Source |
> |---|---|---|
> | `userId` | `ID!` | echoes the (trimmed) input id |
> | `profile` | `UserProfile` | the user's `#PROFILE` row · `null` if none exists |
> | `tasks` | `[Task!]!` | the user's owned task templates via `taskOwnerIndex` — Task `#META` items only, **no nested `steps`** (same projection as `listAllTasks`) |
> | `categories` | `[Category!]!` | every `CATEGORY#…` row in the user's partition (incl. their default) |
> | `taskAssignments` | `[TaskAssignment!]!` | every `TASK_ASSIGNMENT#…` row in the user's partition (active + ended schedule rules) |
> | `supportLinks` | `[SupportLink!]!` | links in **both** directions — where the user is the supporter and where they are the primary user — deduped by the `(supporterId, primaryUserId)` pair |
>
> `userId` is the app-level id (= Cognito `sub`); a blank id is a `VALIDATION` error. Lists
> come back **empty (`[]`), not `null`**, when the user owns nothing in that bucket. Like
> the other admin APIs it is gated to the `SystemAdmin` group at both the AppSync edge and
> in the resolver.
>
> ```graphql
> query AdminGetUserData($userId: ID!) {
>   adminGetUserData(userId: $userId) {
>     userId
>     profile { userId displayName email role }
>     tasks { taskId title categoryId order createdAt }
>     categories { categoryId name isDefault }
>     taskAssignments { assignmentId taskId scheduleType scheduledFor active }
>     supportLinks { supporterId primaryUserId status }
>   }
> }
> ```

---

### Admin mutations (SystemAdmin only)

Cognito role management + destructive data cleanup, in the same `canplan-admin-<env>`
Lambda. Every mutation is **restricted to the `SystemAdmin` group** — both at the AppSync
edge (`@aws_cognito_user_pools(cognito_groups: ["SystemAdmin"])`) and re-checked in the
resolver. **Cognito group membership remains the authorization source of truth**; these
APIs manage that membership and the data behind it.

The `userId` in every input is the **app-level id = the Cognito `sub`**. The resolver maps
it to the Cognito `Username` with a `ListUsers` `sub = "…"` filter (Cognito's Admin\* APIs
need the `Username`, which is not the `sub` for an email-alias pool).

> **Bootstrap:** there is no API to mint the first SystemAdmin — add the first admin to the
> `SystemAdmin` Cognito group manually (console, or `aws cognito-idp admin-add-user-to-group`).
> Admins log in through the **same** Cognito app client as everyone else.
>
> **Group changes propagate via new JWTs:** Cognito groups are embedded in the issued token,
> so a user must **refresh their tokens or re-login** after an invite / `setUserBaseRole` /
> `setSystemAdmin` before the change takes effect.

| Operation | Returns | Effect |
|---|---|---|
| `inviteSupportPerson(input: InviteUserInput!)` | `AdminUserResult!` | `AdminCreateUser` (or adopt an existing user on `UsernameExistsException`) + add **only** `SupportPerson`. Never adds `PrimaryUser`. No `UserProfile` is created. |
| `inviteOrganizationAdmin(input: InviteUserInput!)` | `AdminUserResult!` | Same, adding **only** `OrganizationAdmin`. |
| `setUserBaseRole(input: SetUserBaseRoleInput!)` | `AdminUserResult!` | Remove all base groups, add the one target (`PRIMARY_USER`/`SUPPORT_PERSON`/`ORG_ADMIN`). Mirror onto an existing `UserProfile.role` (never creates one). `SystemAdmin` untouched. |
| `setSystemAdmin(input: SetSystemAdminInput!)` | `AdminUserResult!` | `enabled:true` grants / `false` revokes the `SystemAdmin` group (base roles untouched). **Self-demotion rejected.** |
| `adminDeleteTask(taskId: ID!)` | `Task` | Delete **any** task regardless of owner — same cascade as the owner `deleteTask` (steps, media rows + S3 binaries, category `taskCount`). Returns the deleted task, or `null` if already gone. |
| `adminDeleteUser(input: AdminDeleteUserInput!)` | `AdminDeleteUserResult!` | Full user deletion (see below). **Self-deletion rejected.** |

**Inputs**

- `InviteUserInput`: `email: AWSEmail!`, `displayName: String`, `organizationId: ID`
  (reserved; not persisted yet).
- `SetUserBaseRoleInput`: `userId: ID!`, `role: AdminBaseRole!` (`PRIMARY_USER` /
  `SUPPORT_PERSON` / `ORG_ADMIN`).
- `SetSystemAdminInput`: `userId: ID!`, `enabled: Boolean!`.
- `AdminDeleteUserInput`: `userId: ID!`, `deleteCognitoUser: Boolean = true`,
  `disableFirst: Boolean = true`.

`AdminUserResult` is `{ userId, email, groups: [String!]!, profile: UserProfile }` — the
user's `sub`, email, **current** Cognito groups, and their profile if one exists (`null`
otherwise — invites don't create a profile).

**`adminDeleteUser` order (retryable; no Scan):**

1. If `deleteCognitoUser` and `disableFirst`, `AdminDisableUser` first (so an in-flight
   session can't race the cleanup).
2. Delete every **owned task** via `taskOwnerIndex` → the shared cascade each.
3. Delete every row in the **`USER#<userId>` partition** (profile, categories, task
   assignments, task instances, task-instance steps, …) with one PK query + batch delete.
4. Delete every `SupportLink` where the user is the **supporter** (`SUPPORTER#<userId>`
   partition) **and** where they are the **primary user** (`primaryUserSupportLinkIndex`).
5. **Last**, if `deleteCognitoUser`, `AdminDeleteUser`. Any DynamoDB/S3 failure above throws
   before this step, so the login is never removed while data remains; an already-missing
   user counts as success once data cleanup completes.

Returns `AdminDeleteUserResult { userId, deletedTasks, deletedUserItems, deletedSupportLinks,
deletedCognitoUser }`.

```graphql
mutation InviteSupport($input: InviteUserInput!) {
  inviteSupportPerson(input: $input) { userId email groups profile { displayName role } }
}

mutation PromoteToAdmin($input: SetSystemAdminInput!) {
  setSystemAdmin(input: $input) { userId groups }   # userId = the target user's Cognito sub
}

mutation DeleteUser($input: AdminDeleteUserInput!) {
  adminDeleteUser(input: $input) {
    userId deletedTasks deletedUserItems deletedSupportLinks deletedCognitoUser
  }
}
```

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

### `createAiTask` — mutation

Generates a clean **title + ordered steps** for one free-text request over the same
Bedrock Knowledge Base + RAG, and returns them directly as a **preview**. It **persists
nothing** — no `Task`, `TaskStep`, category count, or `MediaAsset` is written, and no
`categoryId` is resolved. The caller decides whether to keep the result and saves it
later via [`createTask`](#createtask--mutation). Owner is derived from the Cognito identity.

**Input — `CreateAiTaskInput`**:
- `query: String!` — the free-text request; empty/whitespace is rejected with `VALIDATION`.
- `groundingMode: AiTaskGroundingMode = GROUNDED_ONLY` — controls the fallback policy (below);
  chosen **per request**, not by the caller's role.
- `stepCount: Int` — optional requested number of steps. If supplied it must be an integer
  **1..20** inclusive (`0`, negatives, `> 20`, and non-integers are rejected with `VALIDATION`);
  omitted ⇒ the AI chooses the count (capped at 20).

**Returns — `GeneratedAiTask!`**: `title: String!`, `steps: [GeneratedAiTaskStep!]!`
(each `{ text, citations }`), `grounded: Boolean!`, `source: AiTaskGenerationSource!`, plus
`inputTokens`, `outputTokens`. No database-created fields (`taskId`, `ownerId`, `categoryId`,
`createdAt`, `updatedAt`) are returned.

- `grounded` — `true` = steps built from retrieved corpus sources; `false` = an **ungrounded
  fallback** generated from the model's general knowledge. Render an "AI-generated, not from
  our guidance" notice when `false`.
- `source` — a clearer companion to `grounded`: `CORPUS` (grounded) or `UNGROUNDED_AI`
  (fallback). Use it to drive frontend display.
- `citations` on each step carry the resolved corpus sources for corpus-generated output, and
  are `[]` for ungrounded fallback output. The frontend controls whether the field is fetched
  via GraphQL selection — steps are **not** forced to include it.

> **No-guidance behaviour (input-controlled).** When the query retrieves nothing that clears the
> rerank relevance floor, `groundingMode` decides what happens — the caller's Cognito role is
> **not** consulted:
> - **`GROUNDED_ONLY`** (default) → a **`NotFoundError`** (`message: "no relevant guidance found
>   for this task"`); `data.createAiTask` is null and the Bedrock Converse generation model is
>   **never called**. See [Error handling](#error-handling).
> - **`ALLOW_UNGROUNDED_FALLBACK`** → the ungrounded fallback runs: steps are returned with
>   `grounded: false`, `source: UNGROUNDED_AI`, and empty `citations`.
>
> When guidance **is** found, the steps are built from the corpus with `grounded: true` and
> `source: CORPUS` — regardless of `groundingMode`. Because it persists nothing, the result is a
> throwaway preview: re-running the same `query` may yield different wording.

```graphql
mutation CreateAiTask($input: CreateAiTaskInput!) {
  createAiTask(input: $input) {
    title
    steps {
      text
      citations { chunkId title url snippet }
    }
    grounded
    source
    inputTokens
    outputTokens
  }
}
```

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

- **Push notifications / reminder delivery** — `TaskAssignment`s define schedules and
  `getTaskInstanceViews` expands occurrences on read, but **nothing fires reminders yet**.
  There is no delivery engine (EventBridge), no device-token registration, and no
  push-notification Lambda in this phase.
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
- **Delete** exists for categories (`deleteCategory`, non-default only), tasks
  (`deleteTask`), task steps (`deleteTaskStep`), task assignments (`deleteTaskAssignment`,
  soft delete), and media assets (`deleteMediaAsset`). **Update** exists for categories
  (`updateCategory`), tasks (`updateTask`), task steps (`updateTaskStep`), task-step ordering
  (`reorderTaskSteps`), whole-owner task ordering (`updateTaskOrder`), and task-instance
  status (`updateTaskInstanceStatus`); other entities have no update yet.
- **Report generation** — the `Report` type exists in the schema, but no query or
  mutation is exposed for it yet.
- **Streaming AI responses** — `generateTaskSteps` is request/response only.

---

## Breaking changes: categories & tasks rework

Categories became first-class and private; Task status was removed; TaskStep storage and
ordering changed. **This is a breaking API change.**

**Removed**

- `TaskStatus` enum and `Task.status` (output), plus `status` on `CreateTaskInput` /
  `UpdateTaskInput`. Tasks have no status.
- `ownerId` on `CreateTaskInput` and `CreateCategoryInput` — both are derived from the
  caller's Cognito identity.
- `listCategoriesByOwner(ownerId, …)` — replaced by `listMyCategories(…)`.

**Changed**

- `listTasksByCategory` now **requires** a real `categoryId` (no implicit "uncategorized"
  bucket).
- `TaskStep` storage moved from order-based sort keys (`STEP#001`) to stable
  `STEP#<stepId>` keys; `order` is a plain attribute. List/read paths sort by `order`.
- **Task & TaskStep operations are now owner-scoped** (caller `sub` must equal the task's
  `ownerId`); `createTaskStep` is **append-only** (next position; max 99 steps).

**Added**

- A real **default category** per user (`No Category`, `isDefault: true`) created
  atomically with the profile; `UserProfile.defaultCategoryId` and `Category.isDefault`.
- Category management: `createCategory` (no `ownerId`), `listMyCategories`,
  `updateCategory`, `deleteCategory` (default-category immutability + reparent-on-delete).
- An **internal `Category.taskCount`** (not exposed in GraphQL) — a durable, transactionally
  maintained count of the tasks in each category, so `deleteCategory` is safe despite the
  eventually-consistent category index.
- `TaskStep.description` (optional), persisted by create/update; `TaskInstanceStep`
  snapshots carry text/completion only (no `description`).
- `reorderTaskSteps` — atomic whole-task reordering.

**Data compatibility / migration**

- A documented, **idempotent, dry-run-by-default** migration
  (`scripts/migrate-default-categories.ts`) that: ensures **exactly one valid default
  category** per profile (creating one when missing, **repairing** a missing/invalid
  `defaultCategoryId` pointer, deterministically keeping the lowest canonical default id,
  and demoting duplicate/legacy default flags to `Recovered Category <short-id>`); reparents
  legacy `NO_CATEGORY`/dangling tasks to the owner's default;
  strips legacy Task `status`; **backfills `Category.taskCount`** to the true number of tasks
  in each category; backfills Task step append metadata (`stepCount`, `stepVersion`,
  `nextStepOrder`); and rekeys legacy order-based `TaskStep` rows to `STEP#<stepId>`. Old
  `STEP#` rows stay readable during the rollout (the prefix is unchanged; reads sort by
  `order`), so it runs as a maintenance migration after deploy. **Run it before relying on
  `deleteCategory` against legacy data** (which needs `taskCount`). See the README "Data
  Migration" section for the runbook.

---

## Breaking changes: scheduling rework

Scheduling was redesigned so that a `Task` is a **reusable template only**. The flat
`Assignment` model (with `dueDate`/`status`/`AssignmentStep`) was replaced by a three-layer
model: `TaskAssignment` (schedule rule), `TaskInstance` (one occurrence with status), and
`TaskInstanceStep` (per-occurrence step snapshot). **This is a breaking API change**, and
**no data migration / backward compatibility is provided.**

**Removed**

- All scheduling fields on `Task`: `scheduleRule`, `schedule`, `nextOccurrenceAt`,
  `notificationEnabled` — and the `TaskSchedule` type, `TaskScheduleInput`, and `RepeatUnit`
  enum. Those fields are also gone from `CreateTaskInput` / `UpdateTaskInput`.
- The `Assignment` and `AssignmentStep` types, the `AssignmentStatus` enum, and every old
  operation: `createAssignment`, `updateAssignmentStatus`, `setAssignmentStepCompletion`,
  `deleteAssignment`, `listAssignmentsForUser`, `listAssignmentSteps`.

**Added — `TaskAssignment`**

- The schedule rule binding a template to a user (`scheduleType` `ONE_TIME`/`RECURRING`,
  `scheduledFor` or `scheduleRule`/`startDate`/`endDate`/`startTime`, `timezone`, `active`).
- Operations: `createTaskAssignment`, `endTaskAssignment`, `deleteTaskAssignment` (soft
  delete), `listTaskAssignmentsForUser`. An active assignment carries a sparse
  `activeTaskAssignmentTaskId` (new `activeTaskAssignmentTaskIndex` GSI) so `deleteTask` is
  rejected while any active assignment references the template.

**Added — `TaskInstance` & `TaskInstanceStep`**

- A `TaskInstance` is one concrete occurrence (`TaskInstanceStatus`:
  `TO_DO`/`IN_PROGRESS`/`OVERDUE`/`COMPLETED`/`SKIPPED`/`CANCELLED`; `OVERDUE` is derived).
  Occurrences are **virtual** until `startTaskInstance` (or `cancelTaskInstance`)
  materializes one; `startTaskInstance` snapshots the task's current steps into
  `TaskInstanceStep` rows exactly once (idempotent).
- Operations: `startTaskInstance`, `updateTaskInstanceStatus`, `cancelTaskInstance`,
  `setTaskInstanceStepCompletion`, `getTaskInstanceViews` (the calendar feed),
  `listTaskInstanceSteps`.

**Recurrence**

- `RECURRING` assignments use an RRULE (`scheduleRule`) expanded with `rrule` + `luxon`
  (timezone-correct across DST). The RRULE must carry a `FREQ` of `DAILY`/`WEEKLY`/`MONTHLY`/
  `YEARLY` (`HOURLY`/`MINUTELY`/`SECONDLY` and a missing `FREQ` are rejected).
  `getTaskInstanceViews` caps its date range at **370 days**.
