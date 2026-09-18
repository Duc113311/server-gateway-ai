# server-gateway-ai

AI gateway for the Drink Water app. The app never holds a provider key — it
calls this service, which verifies the caller, enforces a per-user quota, and
forwards the work to whichever upstream is configured.

Same stack as `server_noti_drink`: Node 18+, TypeScript, `firebase-admin`.

> **Hướng dẫn vận hành tiếng Việt:** [`docs/huong-dan-van-hanh.md`](docs/huong-dan-van-hanh.md)
> — chạy local, deploy lên VPS (systemd + nginx + TLS), chọn model, và tiết
> kiệm token. File README này là phần tham chiếu API.

## Why a gateway

A provider key shipped inside an APK is extractable, and the bill is yours.
Putting the key here means:

- the key lives in one place you control, and rotating it is a redeploy;
- every call is attributed to a Firebase uid, so one user cannot drain the
  budget;
- the system prompt is server-side and un-overridable, so the app's tokens
  cannot be repurposed as a general chatbot;
- swapping OpenAI for Gemini, DeepSeek or Grok is an env change, not an app
  release.

## Features

Four capabilities, each with its own provider setting and its own quota. A
feature left `off` answers `404 feature_disabled`, which is what the app reads
from `/healthz` to decide whether to show the entry point at all.

| Feature | Route | Env | Providers |
| ------- | ----- | --- | --------- |
| Chat | `POST /v1/chat` | `AI_PROVIDER` | `openai` · `gemini` · `deepseek` · `grok` |
| Image | `POST /v1/image` | `IMAGE_PROVIDER` | `openai` · `gemini` · `grok` · `off` |
| Video | `POST /v1/video` + poll | `VIDEO_PROVIDER` | `gemini` (Veo) · `openai` (Sora) · `off` |
| Translate | `POST /v1/translate` | `TRANSLATE_PROVIDER` | `model` · `google` · `off` |

### Picking a chat provider

| `AI_PROVIDER` | Model to start with | Notes |
| ------------- | ------------------- | ----- |
| `openai` | `gpt-4o-mini`, `gpt-5-nano` | Streams. The gpt-5 / o-series line is reasoning: `reasoning_effort=low`, no temperature. |
| `gemini` | `gemini-2.0-flash` | Streams. Cheapest of the four at this size; JSON mode is enforced by the decoder, not the prompt. |
| `deepseek` | `deepseek-chat` | Streams. OpenAI wire format. `deepseek-reasoner` is the one model here with no JSON mode — prefer `deepseek-chat`. |
| `grok` | `grok-4-fast` | Streams. OpenAI wire format. |

OpenAI, DeepSeek and xAI share one implementation
(`providers/openaiCompatible.ts`) because they share one wire format; the three
things that differ — `max_tokens` vs `max_completion_tokens`, the reasoning
budget, and whether JSON mode exists — are flags on the factory. Adding the
next OpenAI-compatible vendor is one entry in `providers/index.ts`.

## Admin dashboard

`ADMIN_ENABLED=true` puts a dashboard on `/admin`: every served request with
the uid that made it, the message, the model that answered, the tokens it
cost, the latency, and a per-hour volume chart. Filters for time range,
feature, model, status, user and a text search across messages; CSV export of
whatever is filtered.

Sign-in is two factors — a password, then a 6-digit code from Google
Authenticator or any other TOTP app.

### Enrolling

Enrolment runs exactly once and is gated on a token, because a fresh
deployment is reachable from the internet before anyone has claimed the admin
account:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# put that in ADMIN_SETUP_TOKEN, restart, then open:
#   https://your-gateway/admin/setup?token=THAT_TOKEN
```

The page asks for a username and password, shows a QR to scan, verifies a live
code, then prints ten recovery codes **once** — they are stored hashed and
cannot be shown again. Enrolment signs you straight in, because both factors
were just presented. Afterwards `/admin/setup` is closed for good and you can
clear the token.

Lost the phone: sign in with a recovery code (each works once). Lost those too:
delete `ADMIN_ACCOUNT_PATH` and enrol again.

### What is stored, and where

Request history is append-only JSONL at `ADMIN_LOG_PATH`. `ADMIN_LOG_PROMPTS`
is the privacy switch: with it off the dashboard still shows who, when, which
model and what it cost, but the message text is never written to disk. History
older than `ADMIN_LOG_RETENTION_DAYS` is dropped by the hourly sweep.

Both files live under `data/`, which is gitignored. On Cloud Run that path is
an ephemeral container filesystem — history does not survive a new revision.
Mount a volume, or move the store to Firestore, if the history has to last.

### Security properties

- Password hashed with scrypt (`N=2^15`), compared in constant time.
- TOTP codes are single-use: the accepted step is recorded, so a code seen over
  someone's shoulder cannot be replayed inside its own 30-second window.
- A correct password alone yields a *pending* session that every dashboard
  route rejects; the session id is rotated when the code promotes it.
- Cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` off localhost.
  State-changing calls also carry a per-session CSRF token.
- Five failures from one IP triggers a 15-minute lockout.

`npm run e2e:admin` exercises all of the above against a running instance —
see the header of `scripts/e2e-admin.ts` for how to start one.

## Run it

```bash
npm install
cp .env.example .env      # then fill in the key for your provider
npm run dev               # tsx watch
```

For local work without Firebase, set `AUTH_MODE=none` — then no service
account file is needed. Never deploy with that.

```bash
npm run build && npm start   # production
```

## Deploy

Cloud Run in the **smartdrink-ai** project is the natural home: the app's
Firebase Auth already lives there, the container scales to zero between users,
and — the part that matters most — the gateway needs no key file at all.

**No service account JSON in the image.** Set `SERVICE_ACCOUNT_PATH=` (empty)
and `firebase.ts` uses Application Default Credentials: on Cloud Run the
runtime service account comes from the metadata server. Nothing to mount, and
nothing to leak if the image is ever pulled. The file path is only for running
outside Google's infrastructure.

**Provider keys go in Secret Manager, never in `--set-env-vars`.** Env vars set
that way are visible to anyone with Viewer on the project and are printed by
`gcloud run services describe`; a secret is a separate IAM grant and is
rotatable without a rebuild.

```bash
PROJECT=smartdrink-ai
REGION=asia-southeast1          # Singapore — closest to VN users

gcloud config set project $PROJECT
gcloud services enable run.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com

# 1. The key, once. Rotating it later is this line again + a new revision.
printf '%s' 'sk-...' | gcloud secrets create openai-api-key --data-file=-

# 2. A service account for the gateway, with exactly two grants: read that
#    secret, and verify Firebase ID tokens.
gcloud iam service-accounts create ai-gateway --display-name="AI gateway"
SA=ai-gateway@$PROJECT.iam.gserviceaccount.com
gcloud secrets add-iam-policy-binding openai-api-key \
  --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:$SA --role=roles/firebaseauth.viewer

# 3. Build from source and deploy. --allow-unauthenticated is right here: the
#    gateway does its own auth with Firebase ID tokens, and Cloud Run IAM
#    cannot check those.
gcloud run deploy ai-gateway \
  --source . \
  --region $REGION \
  --service-account $SA \
  --allow-unauthenticated \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --set-env-vars "AI_PROVIDER=openai,OPENAI_MODEL=gpt-4o-mini,AUTH_MODE=firebase,SERVICE_ACCOUNT_PATH=,TRANSLATE_PROVIDER=model,IMAGE_PROVIDER=off,VIDEO_PROVIDER=off" \
  --min-instances 0 \
  --max-instances 3 \
  --concurrency 40 \
  --timeout 120
```

`--max-instances` is a spending cap as much as a scaling one: the in-memory
quota is per instance, so three replicas mean a determined user gets three
allowances. Keep it low until `rateLimit.ts` moves to Firestore.

Then point the app at the URL `gcloud run deploy` prints:

```bash
flutter build apk --dart-define=AI_GATEWAY_URL=https://ai-gateway-xxxx.a.run.app
```

Changing provider afterwards is one command and no rebuild:

```bash
gcloud run services update ai-gateway --region $REGION \
  --update-env-vars AI_PROVIDER=gemini,GEMINI_MODEL=gemini-2.0-flash \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest
```

Any other container host works the same way — the only two requirements are
that `PORT` is respected (it is) and that the key arrives as an env var. Off
Google's infrastructure, point `SERVICE_ACCOUNT_PATH` at a mounted secret file
instead of leaving it empty.

### Free and cheap upstreams

There is no free OpenAI API key — the API is prepaid and separate from a
ChatGPT subscription. What there is:

| Option | `AI_PROVIDER` | Notes |
| ------ | ------------- | ----- |
| Google AI Studio | `gemini` | A genuine free tier, no card. Rate-limited per minute and per day, and prompts may be used for training — fine for this app's content, not for user data you promised to keep private. |
| OpenRouter free pool | `compat` | Models with a `:free` suffix. Daily cap, shared capacity, so latency varies. |
| GitHub Models | `compat` | Free with a GitHub PAT, low per-minute allowance. Good for development, too thin for production. |
| Groq | `compat` | Free tier, open-weight models, very fast. |
| Ollama / LM Studio | `compat` | Local, no key, no cost, no quota. Only reachable from your own machine. |
| DeepSeek | `deepseek` | Not free, but roughly an order of magnitude under OpenAI at this size. |

`compat` is how anything OpenAI-shaped gets plugged in — by URL rather than by
name — so none of the above needs a code change:

```bash
AI_PROVIDER=compat
COMPAT_BASE_URL=https://openrouter.ai/api/v1
COMPAT_MODEL=deepseek/deepseek-chat-v3-0324:free
COMPAT_API_KEY=sk-or-v1-...
```

For this app specifically, `gemini` is the better free answer than any `compat`
route: it is first-class here (it streams, and its JSON mode is enforced by the
decoder rather than by the prompt), and the free tier is the most generous of
the lot.

## API

### `GET /healthz`

No auth. Reports which upstream serves each feature — never whether a key is
set.

```jsonc
{
  "ok": true,
  "provider": "openai",
  "model": "gpt-4o-mini",
  "authMode": "firebase",
  "features": {
    "chat":      { "enabled": true,  "provider": "openai", "model": "gpt-4o-mini" },
    "image":     { "enabled": true,  "provider": "gemini", "model": "gemini-2.5-flash-image" },
    "video":     { "enabled": false },
    "translate": { "enabled": true,  "provider": "model:openai", "model": "gpt-4o-mini" }
  }
}
```

Every route below takes `Authorization: Bearer <Firebase ID token>`.

### `POST /v1/chat`

```jsonc
// request
{
  "messages": [
    { "role": "user", "content": "Uống bao nhiêu nước một ngày là đủ?" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "Còn khi tập thể thao thì sao?" }
  ],
  "locale": "vi_VN",
  "stream": false
}
```

```jsonc
// 200
{
  "card": { "intro": "...", "points": [], "outro": "", "suggestions": [] },
  "reply": "...",
  "model": "gpt-4o-mini",
  "usage": { "input": 210, "output": 88 }
}
```

The last message must be from the user. A `system` role is rejected: the
instructions are the server's and are not negotiable from the client.

With `"stream": true` the reply is SSE instead: `data: {"card": …}` frames as
the card fills in, then one `data: {"done": true, …}` and `data: [DONE]`. All
four providers stream.

### `POST /v1/image`

```jsonc
// request
{ "prompt": "a glass of water on a wooden table, soft morning light",
  "n": 1, "size": "1024x1024", "quality": "standard" }
```

```jsonc
// 200
{
  "images": [{ "b64": "iVBORw0…", "mimeType": "image/png", "revisedPrompt": "…" }],
  "model": "gpt-image-1",
  "provider": "openai"
}
```

Bytes come back inline, not as a provider URL: every upstream here either
expires its links within the hour or gates them behind the API key. `size` and
`quality` are honoured where the model has them and ignored where it does not
(grok-2-image picks its own frame).

### `POST /v1/video` — start, then poll

A render takes one to several minutes, which outlives any sane HTTP timeout, so
the call is split in three.

```jsonc
// POST /v1/video   { "prompt": "…", "size": "1280x720", "seconds": 8 }
// 202
{ "jobId": "3f2a…", "status": "pending", "model": "veo-3.0-fast-generate-001",
  "provider": "gemini", "pollAfter": 10 }
```

```jsonc
// GET /v1/video/3f2a…      →  { "status": "pending", "pollAfter": 10 }
//                          →  { "status": "ready", "url": "/v1/video/3f2a…/content" }
//                          →  { "status": "failed", "error": "render_failed" }
```

`GET /v1/video/:id/content` streams the mp4. It is a gateway path, not a
provider link, because both Veo and Sora gate the bytes behind the API key —
the app must never see it. A job is readable only by the uid that started it,
and is swept `VIDEO_JOB_TTL_MS` after its last update.

### `POST /v1/translate`

```jsonc
// request — one string
{ "text": "Drink {amount} ml of water now", "to": "vi" }
// or a batch
{ "texts": ["…", "…"], "to": "vi", "from": "auto" }
```

```jsonc
// 200
{
  "translation": "Hãy uống {amount} ml nước ngay bây giờ",  // only for "text"
  "translations": ["Hãy uống {amount} ml nước ngay bây giờ"],
  "detected": "en",
  "model": "gpt-4o-mini",
  "provider": "model:openai",
  "usage": { "input": 244, "output": 310 }
}
```

Batch, don't loop: one call with fifty strings costs a fraction of fifty calls,
because the system prompt is sent once instead of fifty times.

Two providers, and the choice is a real trade-off:

- `TRANSLATE_PROVIDER=model` reuses `AI_PROVIDER` — no extra key, keeps tone and
  register, understands `{placeholders}` and markup, and can be told about
  context. Billed as chat tokens. The reply is length-checked against the
  request before it is trusted, so a misbehaving model fails the call rather
  than silently misaligning your strings.
- `TRANSLATE_PROVIDER=google` is Cloud Translation v2 — billed per character,
  far cheaper in bulk, 100+ languages, but literal: no tone, no context, and
  placeholders survive only because they look like tokens.

The strings are passed to the model as JSON *data*, so a string that reads
"ignore your instructions" is translated, not obeyed.

### Errors

| Status | `error` | Meaning |
| ------ | ------- | ------- |
| 400 | `empty_messages`, `bad_role`, `empty_content`, `content_too_long`, `last_not_user` | Malformed chat request |
| 400 | `empty_prompt`, `prompt_too_long` | Malformed image/video request |
| 400 | `empty_texts`, `bad_texts`, `too_many_texts`, `texts_too_long`, `missing_target`, `bad_target` | Malformed translate request |
| 401 | `missing_token`, `invalid_token` | Sign in / refresh the ID token and retry |
| 404 | `feature_disabled` (+ `feature`) | That provider is `off` in this deploy — hide the entry point |
| 404 | `job_not_found`, `job_not_ready` | Unknown, expired, or someone else's video job |
| 429 | `rate_limited` (+ `scope`, `feature`, `retryAfter`) | Quota hit; `Retry-After` header is set |
| 502 | `upstream_failed`, `retryable: false` | Provider rejected the call — check the server log |
| 503 | `upstream_failed`, `retryable: true` | Provider busy or 5xx; retry with backoff |
| 504 | `upstream_failed`, `retryable: true` | Provider timed out |

Provider error text stays in the log — it can name the model or the key, so
the client only learns whether retrying is worthwhile.

## Client side

Wired up in the app already, for chat:

| File | Role |
| ---- | ---- |
| `lib/configs/ai_gateway_config.dart` | base URL, timeout, and the caps that mirror this server's |
| `lib/services/application/ai_chat_service.dart` | the HTTP call, the ID token, and error codes |
| `lib/controller/chat_controller.dart` | transcript, in-flight state, retry |
| `lib/presentation/screens_chat/chat_bot_screen.dart` | presentation only |

Image, video and translate have no Dart client yet — the routes are live and
`/healthz` advertises them, but nothing in the app calls them.

Point the app at an instance with a define, so no URL is committed per
developer:

```bash
flutter run --dart-define=AI_GATEWAY_URL=https://gateway.example.com
```

The default is `http://10.0.2.2:8080` — this machine as seen from the Android
emulator. An iOS simulator or a web build wants `http://localhost:8080`. Note
that a plain-`http` URL needs a cleartext exception on Android and ATS on iOS,
so only a real deployment over TLS works without one.

The app sends a Firebase ID token. A real account is not required: the uid from
an **anonymous** sign-in is enough, and it is what the quota is counted against
— `AiChatService` signs in anonymously if nobody is signed in. Tokens expire
after an hour, so it fetches one per request and retries a 401 exactly once
with `getIdToken(true)`.

> Because of that anonymous sign-in, `AuthController.isLoggedIn` is
> `user != null && !user.isAnonymous`. Plain `user != null` would light up the
> Settings profile row and its "Log out" entry for someone who only ever used
> the chat.

Failures reach the UI as an `AiChatException.code` — the gateway's own `error`
value, or `network_unreachable` / `auth_failed` / `bad_response` locally — which
`ChatController` maps to a localized line (`chat_error_*` in
`lib/xml_strings`). A retry button appears only when the gateway said the
failure was transient, so a rejected request never spends a second call.

### Trying it without a provider key

`AUTH_MODE=none` plus an OpenAI-shaped stub on `OPENAI_BASE_URL` exercises the
whole path — validation, quota, and a 200 — for free:

```bash
AI_PROVIDER=openai OPENAI_API_KEY=dummy \
  OPENAI_BASE_URL=http://localhost:8098/v1 \
  AUTH_MODE=none PORT=8097 npm run dev
```

## Cost

Quotas are **per feature**, so an image never eats the chat allowance:

| Feature | Knobs |
| ------- | ----- |
| Chat | `MAX_HISTORY_TURNS` is the main lever — every past turn is re-sent and re-billed as input on each message. `MAX_OUTPUT_TOKENS` caps the other side. `RATE_PER_MINUTE`, `RATE_PER_DAY`. |
| Image | `MAX_IMAGES_PER_REQUEST`, `IMAGE_RATE_PER_MINUTE`, `IMAGE_RATE_PER_DAY`. One image costs what many chat turns do. |
| Video | `VIDEO_RATE_PER_DAY`, and one render in flight per minute. The dearest call here by an order of magnitude — leave `VIDEO_PROVIDER=off` unless the daily cap is one you can afford. |
| Translate | `MAX_TRANSLATE_CHARS` and `MAX_TRANSLATE_ITEMS` cap the batch; `TRANSLATE_RATE_PER_MINUTE`, `TRANSLATE_RATE_PER_DAY`. |

## Scaling

The quota and the video job store both live in memory, so limits are **per
instance** — two replicas mean two allowances, and a poll that lands on the
other replica gets `job_not_found`. Move `rateLimit.ts` and `videoJobs.ts` onto
Firestore or Redis before scaling out.
