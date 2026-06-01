# Floreboard AI Proxy

Cloudflare Workers backend for managed Floreboard AI generation. The iOS app should call this
service instead of sending requests directly to LLM or image providers.

## Scope

- `POST /v1/designs/plan` creates a synchronous text design plan.
- `POST /v1/uploads/reference-image` creates an upload slot.
- `PUT /v1/uploads/reference-image/:uploadId` streams a compressed reference image into R2.
- `POST /v1/designs/visual` creates an async visual-design job.
- `POST /v1/images/generate` creates an async image-generation job.
- `GET /v1/jobs/:jobId` returns job status.

The current async handlers are intentionally conservative placeholders. They create and update job
state through D1 and Queue bindings, but provider-specific visual and image generation still need to
be enabled after the R2/image-provider path is finalized.

## Cloudflare Resources

Create these resources before deploying:

```bash
npx wrangler d1 create floreboard-ai-proxy
npx wrangler r2 bucket create floreboard-reference-images
npx wrangler r2 bucket create floreboard-generated-images
npx wrangler queues create floreboard-ai-jobs
```

Then replace the placeholder D1 `database_id` in `wrangler.jsonc`.

Apply migrations:

```bash
npx wrangler d1 migrations apply floreboard-ai-proxy --local
npx wrangler d1 migrations apply floreboard-ai-proxy --remote
```

## Secrets

Do not commit real secrets. For local development, copy `.dev.vars.example` to `.dev.vars`.

For deployed environments:

```bash
npx wrangler secret put AI_PROVIDER_API_KEY
npx wrangler secret put APP_AUTH_TOKEN
```

`AI_CHAT_COMPLETIONS_URL` can be configured as a non-secret variable when it points at an AI Gateway
or OpenAI-compatible chat completions endpoint.

## Development

```bash
npm install
npx wrangler types
npm run typecheck
npm test
npm run dev
```

Wrangler generated `worker-configuration.d.ts`; rerun `npx wrangler types` after changing
`wrangler.jsonc`.

## Notes For iOS Integration

The iOS client should send the bearer token for `APP_AUTH_TOKEN` only as an app/backend session
placeholder until real account auth exists. It must never send LLM provider keys, model names, or
provider-native request bodies.
