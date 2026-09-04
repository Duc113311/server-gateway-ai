# server-gateway-ai

AI gateway for the Drink Water app. The app never holds an OpenAI or Gemini
key — it calls this service, which verifies the caller, enforces a per-user
quota, and forwards the conversation to whichever provider is configured.

Same stack as `server_noti_drink`: Node 18+, TypeScript, `firebase-admin`.

## Why a gateway

A provider key shipped inside an APK is extractable, and the bill is yours.
Putting the key here means:

- the key lives in one place you control, and rotating it is a redeploy;
- every call is attributed to a Firebase uid, so one user cannot drain the
  budget (`RATE_PER_MINUTE`, `RATE_PER_DAY`);
- the system prompt is server-side and un-overridable, so the app's tokens
  cannot be repurposed as a general chatbot;
- swapping OpenAI for Gemini is an env change, not an app release.

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

## API

### `GET /healthz`

No auth. Returns `{ ok, provider, model, authMode }` for the host's probe.

### `POST /v1/chat`

Header: `Authorization: Bearer <Firebase ID token>`

```jsonc
// request
{
  "messages": [
    { "role": "user", "content": "Uống bao nhiêu nước một ngày là đủ?" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "Còn khi tập thể thao thì sao?" }
  ],
  "locale": "vi_VN"
}
```

```jsonc
// 200
{
  "reply": "...",
  "model": "gpt-4o-mini",
  "usage": { "input": 210, "output": 88 }
}
```

The last message must be from the user. A `system` role is rejected: the
instructions are the server's and are not negotiable from the client.

| Status | `error`                                             | Meaning |
| ------ | --------------------------------------------------- | ------- |
| 400    | `empty_messages`, `bad_role`, `empty_content`, `content_too_long`, `last_not_user` | Malformed request |
| 401    | `missing_token`, `invalid_token`                    | Sign in / refresh the ID token and retry |
| 429    | `rate_limited` (+ `scope`, `retryAfter`)            | Quota hit; `Retry-After` header is set |
| 502    | `upstream_failed`, `retryable: false`               | Provider rejected the call — check the server log |
| 503    | `upstream_failed`, `retryable: true`                | Provider busy or 5xx; retry with backoff |
| 504    | `upstream_failed`, `retryable: true`                | Provider timed out |

Provider error text stays in the log — it can name the model or the key, so
the client only learns whether retrying is worthwhile.

## Client side

Wired up in the app already:

| File | Role |
| ---- | ---- |
| `lib/configs/ai_gateway_config.dart` | base URL, timeout, and the caps that mirror this server's |
| `lib/services/application/ai_chat_service.dart` | the HTTP call, the ID token, and error codes |
| `lib/controller/chat_controller.dart` | transcript, in-flight state, retry |
| `lib/presentation/screens_chat/chat_bot_screen.dart` | presentation only |

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

`MAX_HISTORY_TURNS` is the main lever: every past turn is re-sent and re-billed
as input on each message. Twelve turns of chat costs several times what one
does. `MAX_OUTPUT_TOKENS` caps the other side.

## Scaling

The quota lives in memory, so limits are **per instance** — two replicas mean
two allowances. Move `rateLimit.ts` onto Firestore or Redis before scaling out.
