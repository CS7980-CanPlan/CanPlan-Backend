# CanPlan 2.0 — Supporter Web Portal

A web portal for **support people** and **organization admins** using CanPlan 2.0,
the cloud-based expansion of the CanPlan app. From the portal, supporters can see
the people they support, monitor task progress, and respond to help requests.

> **Initial setup — mocked data.** This portal is currently a scaffold inside the
> CanPlan backend repository. It is intentionally limited to a start page and
> project scaffolding.
> **All data is currently mocked.** The backend CDK app provides AppSync and
> Cognito, but this frontend is not wired to those deploy outputs yet. The fake API
> layer is designed to be swapped for real AppSync GraphQL calls with minimal
> changes to component code.

## Tech stack

- **React** + **TypeScript**
- **Vite** (dev server and build tooling)
- **React Router** for client-side routing
- **CSS Modules** + a small global stylesheet (design tokens)
- A **fake GraphQL API service** (`src/api/fakeGraphqlClient.ts`) backed by in-memory mock data
- Static production build output in `dist/`

## Project structure

```
.
├── index.html               # Vite HTML entry point
├── public/                  # Static assets (favicon, etc.)
├── src/
│   ├── api/                 # Data-access layer (fake GraphQL client for now)
│   │   └── fakeGraphqlClient.ts
│   ├── components/          # Reusable UI components (Header, cards, activity feed)
│   ├── data/                # In-memory mock data (NOT imported by components)
│   │   └── mockData.ts
│   ├── pages/               # Route-level pages (StartPage / dashboard)
│   ├── styles/              # Global styles and design tokens
│   ├── types/               # Shared TypeScript domain types
│   ├── App.tsx              # Route table + layout shell
│   └── main.tsx             # App bootstrap (Router + render)
└── README.md
```

### How data flows

Components **never** import mock data directly. They call async functions from
`src/api/fakeGraphqlClient.ts`, which simulate network latency and return data
shaped like the future AppSync GraphQL responses:

- `getDashboardSummary()` — counts for the dashboard cards
- `getAssignedUsers()` — users assigned to the current supporter
- `getRecentActivity(limit?)` — recent progress/activity events
- `getTasks()` — tasks for assigned users

When the portal is wired to the backend, reimplement these functions using
AppSync GraphQL requests authenticated with the signed-in Cognito user's ID token.
As long as the function signatures and return types stay the same, the UI does
not need to change.

## Local setup

Requires **Node.js 18+** and npm.

```bash
# From the repository root:
cd WebPortal

# 1. Install dependencies
npm install

# 2. Start the local dev server (http://localhost:5173)
npm run dev

# 3. Type-check + build for production (outputs to ./dist)
npm run build

# 4. Preview the production build locally
npm run preview
```

| Script            | Description                                   |
| ----------------- | --------------------------------------------- |
| `npm run dev`     | Start the Vite dev server with hot reload     |
| `npm run build`   | Type-check (`tsc -b`) and build to `dist/`    |
| `npm run preview` | Serve the production build locally            |
| `npm run lint`    | Type-check only (`tsc --noEmit`)              |

## Static deployment

This portal is no longer configured for AWS Amplify Hosting. A production build
is a static Vite artifact:

```bash
npm ci
npm run build
```

Publish the generated `dist/` directory with the static hosting option for the
environment, such as S3 + CloudFront or another static host.

### SPA routing note

Because the portal uses client-side routing (React Router), configure the static
host so deep links resolve to `index.html`:

- **Source address:** `/<*>`
- **Target address:** `/index.html`
- **Type:** `200 (Rewrite)`

## Security notes

- **No real authentication in the portal yet.** The backend already deploys
  Cognito, but the frontend still needs to be wired to it.
- **No AWS credentials or secrets are committed.** Do not hardcode secrets in this repo.
  Environment-specific values should come from the static host's environment
  configuration or generated config files that are safe to expose publicly.
- `.env*` files and generated AWS config files are git-ignored.

## Roadmap (future phases)

- Replace the fake API layer with AWS AppSync GraphQL using the backend deploy
  outputs (`GraphQLApiUrl`, `UserPoolId`, `UserPoolClientId`, `AwsRegion`).
- Add Amazon Cognito authentication and role-based access (supporter vs. admin).
- Add S3 for media/attachments and CloudWatch for monitoring.
- Expand pages: user detail, task management, help-request handling.
