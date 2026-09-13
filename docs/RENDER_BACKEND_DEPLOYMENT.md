# Render Backend Deployment

This guide deploys Linkly's backend services to Render while the Next.js client remains on Vercel.

## Service topology

The root `render.yaml` defines:

| Render resource   | Purpose                                      | Public? |
| ----------------- | -------------------------------------------- | ------- |
| `linkly-api`      | Fastify API, auth, URL management, analytics | Yes     |
| `linkly-redirect` | Fastify `/:shortCode` redirect service       | Yes     |
| `linkly-worker`   | BullMQ analytics and scheduled jobs          | No      |
| Neon PostgreSQL   | External managed PostgreSQL                  | No      |
| Upstash Redis     | External Redis-compatible cache and queue    | No      |

The API and redirect URLs are configured as the Vercel client's API and redirect targets. The
client is intentionally not defined in this Blueprint. Neon and Upstash remain external managed
services and are connected using their URLs.

## Deploy with the Blueprint

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository.
3. Select the `main` branch and apply `render.yaml`.
4. During the initial setup, provide the `sync: false` values for each backend service:

- `DATABASE_URL`, the Neon pooled or direct connection string
- `VALKEY_URL`, the Upstash Redis URL (`rediss://...` is supported)
- `BASE_URL`, for example `https://linkly-api.onrender.com`
- `REDIRECT_URL`, for example `https://linkly-redirect.onrender.com`
- `CLIENT_ORIGINS`, the exact Vercel origin, for example `https://linkly.vercel.app`

6. After the first deployment, set Vercel's `NEXT_PUBLIC_API_BASE_URL` to the API service URL and
   redeploy the Vercel client.

Render generates `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `IP_HASH_SECRET`. Do not put these values
or the Neon/Upstash URLs in `render.yaml` or commit them to Git.

## Render lifecycle

Each service runs from the `server/` monorepo root. This is essential because `server/package.json`
declares `api`, `redirect`, `shared`, and `worker` as npm workspaces. `npm ci` installs the local
`@url-shortener/shared` workspace link, and each build explicitly compiles `shared` first:

```text
server/
  package.json       workspace root
  package-lock.json  workspace lockfile
  shared/            built first -> shared/dist
  api/               consumes @url-shortener/shared
  redirect/          consumes @url-shortener/shared
  worker/            consumes @url-shortener/shared
```

Render must not use `api`, `redirect`, or `worker` as the root directory because those folders
cannot see the sibling `shared` workspace.

The service lifecycle is:

- Build: `npm ci --include=dev`, build `shared`, generate the service's Prisma client, then build the service.
- API build: also runs `prisma migrate deploy` against Neon PostgreSQL.
- Start: runs the service's existing compiled `start` script.
- API and redirect web services expose `/health` for Render health checks.
- The worker is a background worker and does not need an HTTP port.

The API migration intentionally runs during the build because Render's pre-deploy command is not
available on free web-service plans. For production teams using paid web services, moving the
migration command to `preDeployCommand` is preferable because migrations then run after build and
before the new instance starts.

## Required runtime behavior

Render web services must listen on `0.0.0.0` and the injected `PORT`. The API and redirect servers
already use `0.0.0.0` by default and read `PORT`. Render terminates TLS at its edge. Use the Neon
connection string for `DATABASE_URL` and the Upstash `rediss://` connection string for `VALKEY_URL`.

## Local Render-like verification

Start local Postgres and Valkey using the repository's Docker Compose setup, then export production-like
values in the shell. Do not commit a local `.env`:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require'
export VALKEY_URL='rediss://default:PASSWORD@HOST.upstash.io:6379'
export JWT_SECRET="$(openssl rand -hex 32)"
export JWT_REFRESH_SECRET="$(openssl rand -hex 32)"
export IP_HASH_SECRET="$(openssl rand -hex 32)"
export NODE_ENV=production

bash infra/verify-render-backend.sh
```

The script performs a clean `npm ci`, Prisma generation, migration deployment, all three backend
builds, and worker unit tests. For a running smoke test, start the API and redirect processes with
`PORT` values exposed locally and check `/health` on both services.

## Troubleshooting checklist

- **Port scan/deploy fails:** verify the service is a `web` service and the process uses Render's
  `PORT`, not a hard-coded port.
- **API starts then exits:** verify `DATABASE_URL`, `VALKEY_URL`, both JWT secrets, and `CLIENT_ORIGINS`.
- **Redirect health check fails:** deploy the current code with the `/health` endpoint; older versions
  only exposed the redirect route.
- **CORS fails from Vercel:** set `CLIENT_ORIGINS` to the exact scheme and host, without a trailing slash.
- **BullMQ jobs do not process:** verify all three backend services use the same Upstash
  `VALKEY_URL` and that the URL includes the required TLS/authentication settings.
- **Migration fails:** inspect the API build logs and confirm the Neon connection string is valid and the
  migration files are present under `server/api/prisma/migrations`.

## Render documentation

- [Web Services](https://render.com/docs/web-services)
- [Deploys](https://render.com/docs/deploys)
- [Blueprint Specification](https://render.com/docs/blueprint-spec)
- [Monorepo Support](https://render.com/docs/monorepo-support)
- [Background Workers](https://render.com/docs/background-workers)
- [Neon connection strings](https://neon.tech/docs/connect/connect-from-any-app)
- [Upstash Redis connection strings](https://upstash.com/docs/redis/howto/connectwith)
