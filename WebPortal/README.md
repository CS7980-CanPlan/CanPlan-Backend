# CanPlan 2.0 — Web Portal

A web portal for operating the CanPlan 2.0 backend, with two role-scoped areas behind a
common landing page:

- **Admin portal** (`/admin`, `SystemAdmin`): manage users (invite support people / org
  admins, change base roles, grant or revoke SystemAdmin), organizations and membership, and
  destructive data actions (delete any task, fully delete a user).
- **Support portal** (`/support`, `SupportPerson`), tabbed into: **People I support** (open a
  supported user to review their tasks, categories, assignments, and month calendar via
  delegated access; the calendar distinguishes virtual schedule occurrences from materialized
  task instances);
  **Manage people** (add/remove primary users from your own organization —
  `selectPrimaryUser` / `unselectPrimaryUser`; users in other orgs are never visible);
  **Tasks** (create and manage your OWN task templates and assign them to supported users —
  see [Support tasks module](#support-tasks-module)); and
  **My profile** (edit your display name and organization via `updateMyUserProfile`). The
  organization field is a search-by-ID input — a non-admin can't browse all orgs
  (`listAllOrganizations` is SystemAdmin-only), so paste an org id and the backend validates it.

This portal is wired to the **real** backend — there is no mock-data mode. Every request
carries the signed-in user's Cognito **ID token** in the `Authorization` header; the backend
authorizes admin operations against the `SystemAdmin` group and support operations against the
caller's `SupportPerson` role plus an ACTIVE `SupportLink` to the target primary user.

## Tech stack

- **React** + **TypeScript** + **Vite**
- **react-router-dom** — routing (public landing at `/`, admin sign-in at `/admin` + guarded `/admin/*`, support sign-in at `/support` + guarded `/support/home`)
- **@tanstack/react-query** — query/mutation state, caching, invalidation
- **graphql-request** — typed GraphQL calls to AppSync
- **aws-amplify** — Cognito authentication (incl. forced-new-password flow)
- **lucide-react** — action icons
- **CSS Modules** + a small global stylesheet (design tokens)

## Authentication & access flow

1. The landing page at `/` is a **public entry page** with links to each sign-in:
   **`/admin`** (administrators) and **`/support`** (support persons).
2. Both sign-ins authenticate with Cognito (`VITE_USER_POOL_ID` / `VITE_USER_POOL_CLIENT_ID`)
   using the same shared login card.
3. Invited users created with a temporary password hit the Cognito
   `FORCE_CHANGE_PASSWORD` challenge; the login card shows a **set-new-password** step.
4. After sign-in the portal inspects the ID token's `cognito:groups` claim:
   - Signing in at `/admin` as **`SystemAdmin`** → the admin console (`/admin/home`).
   - Signing in at `/support` as **`SupportPerson`** → the support home (`/support/home`).
   - Authenticated but lacking the group for the area → a **forbidden** screen with links
     back to the portal home and a sign-out action.
5. Guarded screens never render before the session check completes.

Tokens are managed by Amplify's browser session store and read via `fetchAuthSession()` —
the app never handles or stores them manually. The GraphQL client fetches a fresh ID token
per request so a silently-refreshed token is always used. ID and access tokens use their
one-hour Cognito default lifetime and can refresh silently for up to **five days**; after
that, the user must sign in again.

> **Bootstrap the first admin:** there is no self-service way to become SystemAdmin. Add the
> first admin to the `SystemAdmin` Cognito group manually (AWS console, or
> `aws cognito-idp admin-add-user-to-group …`). After any group change a user must
> re-login (or refresh tokens) for the new group to appear in their JWT.

## Required environment variables

Copy [`.env.example`](.env.example) to `.env.local` and fill in the backend deploy outputs.
**All four are required** — the app fails fast on startup if any is missing.

| Variable | Backend CDK output | Example |
| -------- | ------------------ | ------- |
| `VITE_AWS_REGION` | `AwsRegion` | `ca-central-1` |
| `VITE_USER_POOL_ID` | `UserPoolId` | `ca-central-1_abc123` |
| `VITE_USER_POOL_CLIENT_ID` | `UserPoolClientId` | `1a2b3c…` |
| `VITE_GRAPHQL_API_URL` | `GraphQLApiUrl` | `https://….appsync-api.ca-central-1.amazonaws.com/graphql` |

## Local startup

Requires **Node.js 18+** and npm.

```bash
# From the repository root:
cd WebPortal

# 1. Install dependencies
npm install

# 2. Configure env (one-time): copy the template and fill in deploy outputs
cp .env.example .env.local
#   then edit .env.local

# 3. Start the dev server (http://localhost:5173)
npm run dev

# 4. Type-check + production build (outputs to ./dist)
npm run build
```

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Start the Vite dev server with hot reload |
| `npm run build` | Type-check (`tsc -b`) and build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | Type-check only (`tsc --noEmit`) |

## Project structure

```
src/
  app/            App shell — providers (React Query, Auth, Router) + route table
  auth/           Amplify config, AuthProvider/useAuth, RequireSystemAdmin/RequireSupportPerson guards
  api/            GraphQL client + docs, raw admin & support APIs, React Query hooks, types
  config/         Typed env config (fails fast on missing vars)
  features/
    landing/      Public portal landing (links to each sign-in)
    login/        Shared login card, admin sign-in, forced-new-password form
    support/      Support-person portal: sign-in, shell/layout, home, manage, profile, user detail
      calendar/   Delegated month calendar: virtual schedules + real TaskInstance overlays
      tasks/      Tasks module: template list/create/detail, step editor, assignment panel
    forbidden/    Forbidden screen (authenticated users lacking the area's group)
    admin/        Admin shell, overview, users, tasks, organizations, dangerous actions
  components/ui/  Reusable primitives (Button, TextField, Select, Badge, Alert, …)
  styles/         Global styles + design tokens
```

### Layering

- **GraphQL documents** are centralized in `src/api/graphqlDocuments.ts` (admin) and
  `src/api/supportDocuments.ts` (support portal, including the tasks module).
- **Raw API calls** (no React) live in `src/api/adminApi.ts` / `src/api/supportApi.ts`.
- **React Query hooks** wrap those in `src/api/adminHooks.ts` / `src/api/supportHooks.ts`
  (centralized query keys + post-mutation invalidation); components use only the hooks.
- Inputs/results are strictly typed in `src/api/apiTypes.ts` to mirror the backend schema.

## Support tasks module

The **Tasks** tab (`/support/tasks`) is where a SupportPerson manages the reusable task
templates **they own** and schedules them for supported users.

### Routes

| Route | Purpose |
| ----- | ------- |
| `/support/tasks` | "My task templates" — the caller's own templates (`listTasksByOwner` on the caller's Cognito `sub`), with create / open / assign / delete actions and cursor-based "Load more" pagination |
| `/support/tasks/new` | Create a template manually or generate a reviewable AI preview, then edit its title, category, description, and ordered text steps before saving |
| `/support/tasks/:taskId` | Template detail: metadata editing, step editing/reordering/appending, creating a new assignment, and deletion |

All three live inside the existing `RequireSupportPerson` / `SupportLayout` guard.

The supported-user detail route (`/support/users/:userId`) also contains a six-week calendar
powered by `getTaskInstanceViews`. It groups the returned `scheduledDate`/`scheduledTime` in
each assignment's schedule timezone, labels virtual occurrences as **Scheduled**, and labels
materialized rows as **Task instance**. Its **Assign a task** action carries
`?assignTo=<userId>` into the task-template flow, where the assignment panel verifies that the
user is still actively supported before preselecting them. A user-centric **Existing
assignments** panel directly below the calendar drains every assignment page and provides
schedule replacement, future cutoff, and immediate soft-stop actions. It defaults to active
schedules and can switch to ended/stopped history or all schedules; the backend does not expose
whether an inactive row was ended versus soft-stopped, so those states are grouped together.

### AI-assisted task drafts

The create-template page calls `createAiTask` with every input the backend exposes: required
`query`, `groundingMode` (`GROUNDED_ONLY` by default or
`ALLOW_UNGROUNDED_FALLBACK`), and an optional exact `stepCount` from 1 through 20. The mutation
persists nothing. It returns a title, ordered steps, grounding/source status, citations, and token
usage for review. The supporter must explicitly apply the preview to the ordinary editable form
and then save with `createTask`; citations are review-only because `TaskStep` has no citation field.

### Owned templates vs. a supported user's own tasks

A **Task is a reusable template with no scheduling fields**. This module only manages
templates **owned by the signed-in SupportPerson**: `createTask` is always called **without
`input.userId`** (so the returned `ownerId` is the caller's `sub`), and the list page queries
`listTasksByOwner(ownerId: <caller sub>)`. Tasks owned by supported primary users are a
different thing entirely — they remain visible read-only on each person's detail page under
"People I support" and are never listed or edited in the Tasks tab. The detail page
additionally refuses to manage a task whose `ownerId` is not the caller (delegated/assigned
reads can load foreign tasks, so the UI double-checks).

### Assignment workflow

Assigning never copies the template — a `TaskAssignment` **references** the SupportPerson's
template, and an active assignment is what grants the assigned primary user read access to
the task and its steps.

- Targets come from `listMySupportList` filtered to **`status === "ACTIVE"`** (REVOKED links
  are never assignable); display names resolve through the `listMyOrganizationUsers` roster.
  The backend additionally requires the caller to own the referenced task and to share an
  organization with the target.
- `assignedBy` is never sent — the backend derives it from the authenticated caller.
- **ONE_TIME** sends `scheduledFor` (a local datetime) + `timezone` (IANA name, defaulting to
  the browser's `Intl` timezone).
- **RECURRING** sends `scheduleRule` (an RRULE such as `FREQ=DAILY;INTERVAL=2`; only
  DAILY/WEEKLY/MONTHLY/YEARLY frequencies), `startDate` (`YYYY-MM-DD`), `startTime`
  (`HH:mm`), optional `endDate` (not before `startDate`), and `timezone`. Fields of the
  other schedule type are never mixed in.
- Assignments are stored **per target user** (`listTaskAssignmentsForUser`) and managed from
  that user's detail page after draining **every** `nextToken` page. The support list and org
  roster reads drain all pages for the same reason (a truncated page must not hide assignable
  people). Active, historically capped, stopped, and ended rows are shown with task and
  assignment provenance.
- There is **no update-assignment mutation**. **Edit schedule** creates a replacement first,
  then calls `endTaskAssignment` with the replacement's local start date so the old recurring
  rule retains earlier occurrences but cannot overlap the replacement. These two backend calls
  are not atomic; if ending fails after creation, the UI keeps both rows visible and retries
  only the ending step. `deleteTaskAssignment` remains the immediate soft-stop action. Existing
  materialized TaskInstances are never deleted by either operation, and assignment/calendar
  caches are invalidated after every successful mutation.

### Task deletion

`deleteTask` is **rejected while any ACTIVE assignment still references the task** — the
portal surfaces the backend's message and the fix is to stop/end those assignments first
(never `adminDeleteTask`). Deletion requires typing `delete` to confirm. Editing or deleting
template steps never rewrites `TaskInstanceStep` snapshots of occurrences a user already
started.

### Appending steps (`createTaskStep` contract)

`createTaskStep.order` must equal the task's server-maintained next append position, which
is not exposed via GraphQL. The portal derives it deterministically: with **N > 0** steps it
first normalizes with `reorderTaskSteps` (which resets the append position to `N + 1`) and
then appends with `order = N + 1`; with **zero** steps it appends at `order = 1` — the
backend always accepts 1 on an empty task and resets its internal counter, so a task whose
last step was deleted takes new steps again (this was previously a documented limitation and
is now fixed server-side). Limits: 50 tasks per owner, 99 steps per task, and at most 97
nested steps on `createTask` itself.

## Admin operations

Queries: `listAllUsers`, `listAllTasks`, `listAllOrganizations`,
`adminListOrganizationUsers`, and `adminGetUserData` (paginated tables/detail reads,
cursor `nextToken` where applicable).

Mutations: `inviteSupportPerson`, `inviteOrganizationAdmin`, `setUserBaseRole`,
`setSystemAdmin`, `adminCreateOrganization`, `adminUpdateOrganization`,
`adminDeleteOrganization`, `adminSetUserOrganization`, `adminDeleteTask`, and
`adminDeleteUser`. Each surfaces loading / success / validation / error states, shows the
returned payload in a result panel, and invalidates the relevant React Query caches on
success. Destructive deletes require typed confirmation before enabling the submit button.

## Static deployment

A production build is a static Vite artifact:

```bash
npm ci
npm run build
```

Publish `dist/` to any static host (e.g. S3 + CloudFront). Because the portal uses
client-side routing, configure the host to rewrite deep links to `index.html`:

- **Source:** `/<*>` → **Target:** `/index.html` → **Type:** `200 (Rewrite)`

The four `VITE_*` variables must be present at **build time** for the environment you deploy.

## Security notes

- Admin operations are authorized by Cognito group membership (`SystemAdmin`), enforced at
  the AppSync edge and re-checked in the backend Lambda. The portal also guards routes and
  hides admin UI from non-admins, but the server is the source of truth.
- No AWS credentials or secrets are committed. `.env*` files (except `.env.example`) are
  git-ignored; the `VITE_*` values are non-secret client configuration.
