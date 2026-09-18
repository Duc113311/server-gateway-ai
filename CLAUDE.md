# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`server-gateway-ai` is the AI gateway for the AquaMind / WaterNudge Flutter app
(the parent repo, which carries this one as a git submodule). The app ships no
provider key: it calls this service, which verifies a Firebase ID token,
enforces a per-user quota, and forwards the work to whichever upstream is
configured.

Two documents sit alongside this one and answer different questions:
`README.md` is the API reference (English); `docs/huong-dan-van-hanh.md` is the
operator handbook in Vietnamese (running it, VPS deployment, picking a model,
saving tokens). Keep all three in step when behaviour changes.

Node 18+, TypeScript, Express, `firebase-admin`. The only automated test is
`npm run e2e:admin`, which covers the admin auth flow; everything else is
checked with `npm run typecheck` and a live call.

## Commands

```bash
npm run dev         # tsx watch src/index.ts
npm run typecheck   # tsc --noEmit — run this after every change
npm run build       # tsc -> dist/, then copies src/admin/public -> dist/
npm start           # node dist/index.js
npm run e2e:admin   # admin auth end-to-end; see the script header for setup
```

`build` is not plain `tsc`: the dashboard's HTML/CSS/JS are not TypeScript, so
`scripts/copy-assets.mjs` copies them into `dist/`. Dropping that step makes
every admin page 404 in production only.

## Architecture

Four capabilities, each with its own provider setting, its own quota bucket,
and its own route. A capability set to `off` answers `404 feature_disabled`,
which is what the app reads from `/healthz` to decide whether to show the entry
point at all.

| Feature | Route | Env | Providers |
| ------- | ----- | --- | --------- |
| Chat | `POST /v1/chat` | `AI_PROVIDER` | `openai` · `gemini` · `deepseek` · `grok` · `compat` |
| Image | `POST /v1/image` | `IMAGE_PROVIDER` | `openai` · `gemini` · `grok` · `off` |
| Video | `POST /v1/video` + poll | `VIDEO_PROVIDER` | `gemini` (Veo) · `openai` (Sora) · `off` |
| Translate | `POST /v1/translate` | `TRANSLATE_PROVIDER` | `model` · `google` · `off` |

```
routes/      -> validation, quota, HTTP shape. No upstream knowledge.
providers/   -> one file per upstream, all behind the interfaces in types.ts
prompt.ts    -> the server-owned system prompt and the card parser
rateLimit.ts -> per-uid, per-feature quota (in memory)
videoJobs.ts -> in-flight render handles (in memory)
store/       -> request history, append-only JSONL + an in-memory index
admin/       -> the /admin dashboard: TOTP, account, sessions, routes, public/
```

**The admin dashboard** (`ADMIN_ENABLED=true`) reports on the request history
every route writes through `store/requestLog.record()`. Sign-in is password +
TOTP. `admin/totp.ts` implements RFC 6238 directly rather than depending on a
package — an auth dependency is a supply-chain risk carried forever, and it is
thirty lines.

`providers/index.ts` is the only place env names map to implementations.
Adding an upstream is an entry there plus one file — never a change in a route.

**Chat providers share one implementation.** OpenAI, DeepSeek, xAI and
`compat` all speak `POST /chat/completions`, so they are instances of
`createOpenAiCompatibleProvider` rather than four files. Exactly three things
differ, and each is a flag: `max_tokens` vs `max_completion_tokens`, whether
`reasoning_effort` exists, and whether JSON mode exists. Gemini has its own
file because its wire format genuinely differs.

**`compat` is the escape hatch** — any other OpenAI-compatible endpoint
addressed by `COMPAT_BASE_URL` instead of by name: OpenRouter, GitHub Models,
Groq, a local Ollama, or the 9Router proxy used in local development.

## Gotchas found the hard way

These are all real failures that have already happened here. Do not "simplify"
them away.

- **Some proxies stream even when `stream` was not asked for.** 9Router does.
  `chat()` therefore checks the response `content-type` and folds SSE frames
  back into a single reply; calling `response.json()` unconditionally breaks
  against any such proxy.
- **Some models ignore JSON mode and wrap the object in a ```json fence.**
  Claude via 9Router does. `stripFence()` in `prompt.ts` runs before every
  parse — in `parseCard`, in `parseCardPartial` (before `completeJson`, or the
  bracket repair balances around the fence markers), and in
  `parseTranslations`.
- **`parseCardPartial` must stay tolerant.** It reads a half-arrived stream, so
  a frame it cannot repair is skipped, not an error.
- **Video bytes cannot be handed to the client.** Both Veo and Sora gate the
  finished clip behind the API key, so `/v1/video/:id/content` streams it
  through the gateway. A job is readable only by the uid that started it.
- **`str()` in `config.ts` treats an empty env var as unset.**
  `SERVICE_ACCOUNT_PATH` deliberately bypasses it: an explicitly empty value
  means "use Application Default Credentials", which is how a Cloud Run deploy
  avoids shipping a key file.
- **Quota and video jobs live in memory**, so limits are per instance. Two
  replicas mean two allowances, and a poll landing on the other replica gets
  `job_not_found`. Move both to Firestore or Redis before scaling out.
- **`sendHtml` takes its status as an argument.** Setting `res.status(403)`
  beforehand does nothing — the helper sets the status itself, and an earlier
  call is overwritten. This shipped a 200 on a refused setup page once already.
- **A TOTP step is single-use.** `account.lastTotpStep` is what makes a code
  unusable twice inside its own 30-second window. Enrolment burns the step it
  verified, which is why setup signs the operator in directly instead of
  redirecting to a login page that would reject the code still on their screen.
- **Request logging must never throw.** `record()` swallows write failures: a
  full disk turning a working chat into a 500 is a far worse outcome than a
  gap in a report.

## Security invariants

- The system prompt is server-owned and never merged with client input. A
  client-supplied `system` role is rejected in `parseTurns` — one that got
  through could talk the model out of its instructions and turn the app's
  tokens into a general chatbot.
- Strings sent to `/v1/translate` are passed to the model as JSON **data**. A
  string that reads "ignore your instructions" is translated, not obeyed.
- Upstream error text stays in the log; the client only learns `upstream_failed`
  plus whether a retry is worthwhile. Provider messages can name the model or
  the key.
- `/healthz` reports which provider serves each feature and never whether a key
  is set.
- `AUTH_MODE=none` is local development only. Never deploy it.

## Conventions

- Every cap is an env var with a default in `config.ts`, and `assertConfig()`
  fails at boot rather than on the first user request.
- A new upstream failure mode gets a `ProviderError` with a status and a
  `retryable` flag; `upstreamError()` maps an HTTP status onto both.
- Comments explain *why*, especially where a line guards against a specific
  upstream's behaviour. Match that density.
- `npm run typecheck` after every change. There are no tests to catch a slip.

## Local development

`AUTH_MODE=none` skips Firebase entirely, so no service account file is needed.

The parent app reaches this server over the LAN, not localhost — see
`lib/configs/ai_gateway_config.dart` there. Two things bite regularly: the
default is a DHCP address that goes stale, and plain http works only in a debug
build (the cleartext exception lives in the app's debug manifest). The app also
has Android product flavors, so `flutter run` needs `--flavor dev`.

Freeing the port after a crashed run, on Windows:

```bash
netstat -ano | findstr :8080
taskkill /PID <pid> /F
```

Killing a `npm run dev` wrapper does not always kill the `node` child that
holds the port.
