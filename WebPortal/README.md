# CanPlan 2.0 — Admin Web Portal

A **SystemAdmin-only** web portal for operating the CanPlan 2.0 backend. Administrators
sign in with Cognito and manage users (invite support people / org admins, change base
roles, grant or revoke SystemAdmin), organizations and membership, and destructive data
actions (delete any task, fully delete a user) against the deployed AppSync GraphQL API.

This portal is wired to the **real** backend — there is no mock-data mode. Every admin
request carries the signed-in user's Cognito **ID token** in the `Authorization` header, and
the AppSync API gates the admin operations to the `SystemAdmin` Cognito group.

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

Tokens are managed by Amplify's session store and read via `fetchAuthSession()` — they are
**never** persisted to `localStorage` by this app. The GraphQL client fetches a fresh ID
token per request so a silently-refreshed token is always used.

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
  api/            GraphQL client, documents, raw admin API, React Query hooks, types
  config/         Typed env config (fails fast on missing vars)
  features/
    landing/      Public portal landing (links to each sign-in)
    login/        Shared login card, admin sign-in, forced-new-password form
    support/      Support-person sign-in + support home placeholder
    forbidden/    Forbidden screen (authenticated users lacking the area's group)
    admin/        Admin shell, overview, users, tasks, organizations, dangerous actions
  components/ui/  Reusable primitives (Button, TextField, Select, Badge, Alert, …)
  styles/         Global styles + design tokens
```

### Layering

- **GraphQL documents** are centralized in `src/api/graphqlDocuments.ts`.
- **Raw API calls** (no React) live in `src/api/adminApi.ts`.
- **React Query hooks** wrap those in `src/api/adminHooks.ts`; components use only the hooks.
- Inputs/results are strictly typed in `src/api/apiTypes.ts` to mirror the backend schema.

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
