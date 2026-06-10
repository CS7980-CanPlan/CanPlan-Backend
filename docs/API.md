# CanPlan 2.0 — Frontend API Reference

The backend exposes a single **AWS AppSync GraphQL** endpoint. This document covers
everything the frontend needs: how to connect, the available operations, request/
response shapes, and how errors come back.

The schema lives at [graphql/schema.graphql](../graphql/schema.graphql) — this doc
is the human-readable companion to it.

---

## Connecting

All requests are a single `POST` to the GraphQL URL with a JSON body of
`{ query, variables }`. There is one URL for the whole API — you select the
operation in the query, not the path.

| | |
|---|---|
| **Endpoint** | The `GraphQLApiUrl` printed by `cdk deploy` (e.g. `https://xxxx.appsync-api.<region>.amazonaws.com/graphql`) |
| **Method** | `POST` |
| **Auth** | API key in the `x-api-key` header |
| **Content-Type** | `application/json` |

> **Where do the URL and key come from?** Both are CloudFormation outputs after a
> deploy: `GraphQLApiUrl` and `GraphQLApiKey`. Surface them to the frontend via its
> own env/config (e.g. `VITE_GRAPHQL_URL` / `VITE_GRAPHQL_API_KEY`). The API key is
> a publishable client key, **not** an AWS secret — but it does expire (365 days),
> so plan to rotate it.

### Required headers

```
Content-Type: application/json
x-api-key: <GraphQLApiKey>
```

---

## Quick start

A minimal `fetch` wrapper the frontend can build on:

```ts
const GRAPHQL_URL = import.meta.env.VITE_GRAPHQL_URL;
const API_KEY = import.meta.env.VITE_GRAPHQL_API_KEY;

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
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

## Operations

### `healthCheck` — query

Liveness probe. Returns the static string `"OK"`. No input, no auth-sensitive data —
useful for verifying connectivity and that your API key/URL are wired correctly.

**Query**

```graphql
query HealthCheck {
  healthCheck
}
```

**Response**

```json
{ "data": { "healthCheck": "OK" } }
```

**curl**

```bash
curl -s "$GRAPHQL_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query":"query { healthCheck }"}'
```

---

### `createTask` — mutation

Creates a task in DynamoDB and returns the created record (including the
server-generated `taskId` and `createdAt`).

**Input — `CreateTaskInput`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | `String` | ✅ | Non-empty after trimming whitespace, or the request errors |
| `description` | `String` | — | Optional; trimmed if provided |

**Returns — `Task`**

| Field | Type | Notes |
|---|---|---|
| `taskId` | `ID!` | Server-generated UUID |
| `title` | `String!` | Trimmed |
| `description` | `String` | `null` if not provided |
| `createdAt` | `String!` | ISO-8601 timestamp (UTC) |

**Mutation**

```graphql
mutation CreateTask($input: CreateTaskInput!) {
  createTask(input: $input) {
    taskId
    title
    description
    createdAt
  }
}
```

**Variables**

```json
{ "input": { "title": "Buy groceries", "description": "Milk and eggs" } }
```

**Response**

```json
{
  "data": {
    "createTask": {
      "taskId": "f3b9c2a1-7e44-4d2e-9a1b-1c2d3e4f5a6b",
      "title": "Buy groceries",
      "description": "Milk and eggs",
      "createdAt": "2026-06-10T14:03:22.115Z"
    }
  }
}
```

**Errors** — omitting/blanking `title` returns a GraphQL error:

```json
{ "data": null, "errors": [{ "message": "title is required and cannot be empty" }] }
```

---

### `askAi` — mutation

Sends user text to a **Claude model on Amazon Bedrock** and returns the model's
reply as a single string, plus token usage. The model is configurable
(`BEDROCK_MODEL_ID`); it's currently **Claude 3 Haiku** because the AWS org policy
on this account only permits that model — see the note below. This is a
synchronous, non-streaming call — the whole response comes back in one shot.

> **Latency:** model calls typically take a few seconds. The backend caps the wait
> at ~29s (AppSync's resolver ceiling). Show a loading state on the frontend and
> keep prompts reasonably scoped. Streaming token-by-token is not supported in this
> setup.

**Input — `AskAiInput`**

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | `String` | ✅ | The user's text. Non-empty after trimming, or the request errors |

**Returns — `AiResponse`**

| Field | Type | Notes |
|---|---|---|
| `text` | `String!` | The model's reply |
| `model` | `String!` | Bedrock model/inference-profile id used (e.g. `anthropic.claude-3-haiku-20240307-v1:0`) |
| `inputTokens` | `Int` | Prompt tokens consumed (may be `null`) |
| `outputTokens` | `Int` | Generated tokens (may be `null`) |

**Mutation**

```graphql
mutation AskAi($input: AskAiInput!) {
  askAi(input: $input) {
    text
    model
    inputTokens
    outputTokens
  }
}
```

**Variables**

```json
{ "input": { "prompt": "Summarize CanPlan in one sentence." } }
```

**Response**

```json
{
  "data": {
    "askAi": {
      "text": "CanPlan is a cloud-based task management app that helps you capture, organize, and track your to-dos.",
      "model": "anthropic.claude-3-haiku-20240307-v1:0",
      "inputTokens": 14,
      "outputTokens": 27
    }
  }
}
```

> **Model note:** the deployed account's AWS organization SCP currently permits
> only Claude 3 Haiku for Bedrock; newer models (Sonnet 4.6 etc.) are denied at
> the org level. The backend defaults to Haiku so the endpoint works today.
> Switching to a stronger model is a one-line config change (`BEDROCK_MODEL_ID`)
> once the org policy is widened — no API contract change.

**Errors** — a blank prompt returns:

```json
{ "data": null, "errors": [{ "message": "prompt is required and cannot be empty" }] }
```

---

## Error handling

GraphQL does **not** use HTTP status codes for field-level problems. A request that
reached a resolver returns **HTTP 200** with the failure described in an `errors`
array; `data` for the failed field is `null`. Always check `errors` before reading
`data` (the `graphql()` helper above does this).

| Situation | How it surfaces |
|---|---|
| Validation failure (`title`/`prompt` empty) | HTTP 200, `errors: [{ message }]` from the resolver |
| Bedrock returned nothing (`askAi`) | HTTP 200, `errors: [{ message: "Bedrock returned an empty response" }]` |
| Missing/invalid/expired API key | HTTP 401, `{ "errors": [{ "errorType": "UnauthorizedException" }] }` |
| Malformed query / unknown field | HTTP 200 (or 400), `errors` with a parse/validation message |

---

## Type reference (TypeScript)

Convenience types matching the schema for frontend use. (For larger apps, consider
generating these from the schema with [GraphQL Code Generator](https://the-guild.dev/graphql/codegen)
instead of hand-maintaining them.)

```ts
export interface Task {
  taskId: string;
  title: string;
  description: string | null;
  createdAt: string; // ISO-8601
}

export interface CreateTaskInput {
  title: string;
  description?: string;
}

export interface AskAiInput {
  prompt: string;
}

export interface AiResponse {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}
```

---

## Not available yet

These are planned but not implemented — don't build against them:

- **Read queries** — `getTask`, `listTasks` (only `createTask` exists today).
- **Update / delete task** mutations.
- **Cognito auth** — the API currently uses an API key; user-scoped auth is the
  planned replacement.
- **Streaming AI responses** — `askAi` is request/response only.
