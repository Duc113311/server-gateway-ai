# Hướng dẫn vận hành AI Gateway

Tài liệu tiếng Việt cho người vận hành. Phần tham chiếu API chi tiết nằm ở
`README.md` (tiếng Anh); file này trả lời: chạy thế nào, deploy lên VPS ra sao,
chọn model nào, và làm sao đừng đốt tiền token.

**Mục lục**

1. [Gateway này là gì](#1-gateway-này-là-gì)
2. [Chạy ở máy local](#2-chạy-ở-máy-local)
3. [Bốn công tắc cấu hình](#3-bốn-công-tắc-cấu-hình)
4. [Chọn LLM nào](#4-chọn-llm-nào)
5. [Tiết kiệm token](#5-tiết-kiệm-token)
6. [Deploy lên VPS](#6-deploy-lên-vps)
7. [Dashboard quản trị](#7-dashboard-quản-trị)
8. [Sự cố thường gặp](#8-sự-cố-thường-gặp)

---

## 1. Gateway này là gì

App Flutter **không giữ API key nào cả**. Nó gọi vào gateway này, gateway mới
gọi lên OpenAI/Gemini/DeepSeek/Grok.

```
App Flutter  ──Firebase ID token──▶  Gateway  ──API key──▶  OpenAI / Gemini / …
                                        │
                                        ├─ xác thực người gọi
                                        ├─ áp quota theo từng user
                                        ├─ giữ system prompt (client không sửa được)
                                        └─ ghi log cho dashboard
```

Vì sao phải làm vậy:

- **Key nhét trong APK là moi ra được**, và hoá đơn là của anh. Đặt key ở đây
  thì nó nằm một chỗ anh kiểm soát, đổi key chỉ cần redeploy.
- **Mỗi lượt gọi gắn với một Firebase uid**, nên một người không thể vét sạch
  ngân sách.
- **System prompt nằm ở server**, client không ghi đè được — nếu không, ai đó
  có thể biến token anh trả tiền thành chatbot đa năng của họ.
- **Đổi nhà cung cấp chỉ là đổi biến môi trường**, không cần phát hành app mới.

Bốn tính năng, mỗi cái có provider riêng và quota riêng:

| Tính năng | Route | Biến env |
| --- | --- | --- |
| Chat | `POST /v1/chat` | `AI_PROVIDER` |
| Tạo ảnh | `POST /v1/image` | `IMAGE_PROVIDER` |
| Tạo video | `POST /v1/video` rồi poll | `VIDEO_PROVIDER` |
| Dịch đa ngôn ngữ | `POST /v1/translate` | `TRANSLATE_PROVIDER` |

Tính năng để `off` sẽ trả `404 feature_disabled` — app đọc `/healthz` để biết
mà ẩn nút đi.

---

## 2. Chạy ở máy local

### Gateway

```bash
cd D:\smart_drink\server_gateway_ai
npm install
cp .env.example .env     # rồi điền key cho provider đang chọn
npm run dev              # tsx watch — sửa file là tự reload
```

Chạy đúng sẽ thấy:

```
gateway listening on :8080 (chat=compat/ag/gemini-3.7-flash-low auth=none)
features: image=off video=off translate=model:compat
admin dashboard on /admin (prompts=logged, retention=30d)
```

Các lệnh khác:

| Lệnh | Việc |
| --- | --- |
| `npm run typecheck` | **Chạy sau mỗi lần sửa code.** Repo gần như không có test. |
| `npm run build` | Biên dịch ra `dist/` + copy asset của dashboard |
| `npm start` | Chạy bản đã build (dùng cho production) |
| `npm run e2e:admin` | Test luồng đăng nhập admin (xem header file script) |

### App Flutter

```bash
cd D:\smart_drink
flutter run --flavor dev --dart-define=AI_GATEWAY_URL=http://192.168.1.42:8080
```

Ba thứ hay quên:

- **`--flavor dev` là bắt buộc.** Project có 4 flavor (`alpha`, `dev`,
  `product`, `claude`) và Gradle không có flavor mặc định — thiếu là lỗi ngay.
- **IP là địa chỉ DHCP, hay hết hạn.** Mặc định trong
  `lib/configs/ai_gateway_config.dart` trỏ tới máy dev qua LAN. Kiểm bằng
  `ipconfig`, và nên dùng `--dart-define` thay vì sửa file.
- **HTTP thường chỉ chạy được ở bản debug.** Ngoại lệ cleartext nằm trong
  `android/app/src/debug/AndroidManifest.xml`. Bản release bắt buộc HTTPS.

Điện thoại phải **cùng Wi-Fi** với máy chạy gateway, không dùng 4G. Test nhanh:
mở trình duyệt trên điện thoại vào `http://<IP-máy>:8080/healthz`, thấy JSON là
thông.

### 9Router (tuỳ chọn, để test miễn phí)

9Router là proxy local gom nhiều nguồn model. Nó là ứng dụng TUI nên **phải mở
trong terminal thật**, không chạy nền được:

```bash
9router
```

Rồi trỏ gateway vào nó:

```env
AI_PROVIDER=compat
COMPAT_BASE_URL=http://localhost:20128/v1
COMPAT_MODEL=ag/gemini-3.7-flash-low
COMPAT_API_KEY=        # để trống nếu 9Router không bật "Require API key"
```

---

## 3. Bốn công tắc cấu hình

Toàn bộ nằm trong `.env`. File `.env.example` có chú thích đầy đủ từng biến.

```env
AI_PROVIDER=openai          # openai | gemini | deepseek | grok | compat
IMAGE_PROVIDER=off          # off | openai | gemini | grok
VIDEO_PROVIDER=off          # off | gemini | openai
TRANSLATE_PROVIDER=off      # off | model | google
```

Key dùng chung theo hãng — bật `IMAGE_PROVIDER=gemini` thì xài lại
`GEMINI_API_KEY`, không cần key mới.

| Hãng | Biến key | Chat | Ảnh | Video |
| --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini`, `gpt-5-nano` | `gpt-image-1`, `dall-e-3` | `sora-2` |
| Google | `GEMINI_API_KEY` | `gemini-2.0-flash` | `gemini-2.5-flash-image`, `imagen-4.0-*` | `veo-3.0-fast-generate-001` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` | — | — |
| xAI | `GROK_API_KEY` | `grok-4-fast` | `grok-2-image-1212` | — |
| Khác | `COMPAT_API_KEY` | bất kỳ endpoint OpenAI-compatible | — | — |

**`compat` là cửa thoát hiểm**: trỏ bằng URL thay vì bằng tên hãng, dùng được
cho OpenRouter, GitHub Models, Groq, Ollama local, 9Router… Lý do phải có slot
riêng: OpenAI đổi tên tham số thành `max_completion_tokens`, còn tất cả những
chỗ kia vẫn dùng `max_tokens` — cắm thẳng vào slot `openai` sẽ lỗi 400.

---

## 4. Chọn LLM nào

### Chat

| Provider | Model nên dùng | Ghi chú |
| --- | --- | --- |
| `gemini` | `gemini-2.0-flash` | **Rẻ nhất và có free tier thật.** Stream được. JSON mode ép ở tầng decoder chứ không nhờ prompt, nên card không bao giờ dính ```` ```json ```` fence. |
| `openai` | `gpt-4o-mini` | Ổn định, tài liệu tốt nhất. Dòng `gpt-5`/`o-series` là reasoning: nhận `reasoning_effort`, từ chối `temperature`. |
| `deepseek` | `deepseek-chat` | Rẻ hơn OpenAI khoảng một bậc. **Đừng dùng `deepseek-reasoner`** cho app này — nó là model duy nhất ở đây không ép được JSON mode. |
| `grok` | `grok-4-fast` | Cân bằng giá/độ trễ tốt. |

### Miễn phí thật sự

**OpenAI API không có free tier.** Nó trả trước, tách hoàn toàn khỏi gói ChatGPT
Plus — có Plus cũng không gọi được API.

| Cách | `AI_PROVIDER` | Đánh đổi |
| --- | --- | --- |
| Google AI Studio | `gemini` | Free thật, không cần thẻ. **Prompt có thể bị dùng để train** — đừng đẩy dữ liệu đã cam kết bảo mật qua đây. |
| OpenRouter (model `:free`) | `compat` | Có trần ngày, dùng chung tài nguyên nên độ trễ dao động. |
| GitHub Models | `compat` | Free với PAT GitHub, hạn mức phút rất thấp. Đủ để dev, không đủ cho production. |
| Groq | `compat` | Free tier, model open-weight, rất nhanh. |
| Ollama / LM Studio | `compat` | Chạy local, không key, không tốn tiền, không quota. Chỉ máy anh gọi được. |
| DeepSeek | `deepseek` | Không free nhưng rẻ hơn OpenAI khoảng một bậc. |

Với app này, **`gemini` là câu trả lời free tốt nhất** — nó là first-class ở đây
(stream được, JSON mode chắc chắn) và free tier hào phóng nhất.

### Dịch: `model` hay `google`?

Đây là đánh đổi thật, không phải cái nào cũng hơn:

- **`model`** — dịch qua chính model chat đang cấu hình. Không cần key mới, giữ
  được giọng văn, hiểu `{placeholder}` và markup, biết ngữ cảnh. Tính tiền theo
  token chat.
- **`google`** — Cloud Translation v2. Tính theo **ký tự** nên rẻ hơn nhiều khi
  dịch số lượng lớn, 100+ ngôn ngữ, nhưng dịch máy móc: không giọng văn, không
  ngữ cảnh.

Dùng chuỗi UI của app (ngắn, nhiều, cần đúng placeholder) → `model`. Dịch khối
lượng lớn văn bản thuần → `google`.

### Video

Chỉ có Veo (Google) và Sora (OpenAI). **Đây là lệnh gọi đắt nhất trong gateway,
hơn hẳn một bậc độ lớn.** Để `VIDEO_PROVIDER=off` trừ khi `VIDEO_RATE_PER_DAY`
là con số anh chịu được.

Video là **start-rồi-poll**, không phải một request: render mất 1–5 phút, quá
mọi HTTP timeout hợp lý.

```
POST /v1/video        → 202 { jobId, pollAfter: 10 }
GET  /v1/video/:id    → { status: "pending" | "ready" | "failed" }
GET  /v1/video/:id/content  → bytes mp4
```

Bytes phải đi xuyên qua gateway vì cả Veo lẫn Sora đều chặn link sau API key.

---

## 5. Tiết kiệm token

Phần quan trọng nhất của tài liệu này.

### Hiểu cơ cấu chi phí trước đã

Số đo thật, lấy từ log khi chạy `ag/gemini-3.7-flash-low` qua 9Router, chat một
lượt duy nhất (không có lịch sử):

```
input  ≈ 2.660 token
output ≈    110 – 430 token
```

**Input gấp khoảng 10–20 lần output.** Nghĩa là tối ưu câu trả lời ngắn lại gần
như vô nghĩa — tiền nằm ở phía input.

Input đó gồm những gì:

| Thành phần | Kích thước | Gửi lại mỗi lượt? |
| --- | --- | --- |
| System prompt (`prompt.ts`) | 2.653 ký tự | **Có, mọi lượt** |
| Câu hỏi của user | vài chục–vài trăm ký tự | Có |
| Lịch sử hội thoại | tới `MAX_HISTORY_TURNS` lượt | **Có, toàn bộ, mọi lượt** |

### Ba đòn bẩy, xếp theo mức độ hiệu quả

**1. `MAX_HISTORY_TURNS` — đòn bẩy lớn nhất.**

```env
MAX_HISTORY_TURNS=12    # mặc định
```

Mỗi lượt cũ được **gửi lại và tính tiền lại như input ở mọi lượt sau**. Hội
thoại 12 lượt tốn gấp nhiều lần hội thoại 1 lượt. Giảm xuống 4–6 thường không
làm hỏng trải nghiệm với app hỏi đáp kiểu này, vì mỗi câu hỏi về nước uống
phần lớn là độc lập.

> Nếu sửa giá trị này, sửa luôn `maxHistoryTurns` trong
> `lib/configs/ai_gateway_config.dart` cho khớp — nếu không, thứ user thấy trên
> màn hình và thứ model thực sự nhận sẽ lệch nhau âm thầm.

**2. Rút gọn system prompt.**

2.653 ký tự gửi lại ở **mọi** lượt gọi. Đây là khoản cố định lớn nhất. Cắt được
1/3 là tiết kiệm 1/3 khoản đó vĩnh viễn. Nhưng cẩn thận: phần "LANGUAGE RULE" ở
đầu và phần mô tả JSON schema là thứ giữ cho output parse được — cắt nhầm là
card vỡ.

**3. Chọn model rẻ.** Xem bảng ở mục 4. Chênh lệch giữa các hãng ở cùng tầm
chất lượng có thể tới một bậc độ lớn.

### Các trần khác

```env
MAX_PROMPT_CHARS=1000     # chặn user gửi tiểu thuyết
MAX_OUTPUT_TOKENS=500     # trần độ dài trả lời
RATE_PER_MINUTE=8         # quota chat theo phút
RATE_PER_DAY=5            # quota chat theo ngày, tính theo Firebase uid
```

`RATE_PER_DAY` chính là **suất miễn phí mỗi thiết bị được dùng một ngày** (mỗi
lần cài app là một anonymous uid).

Quota **tách riêng theo từng tính năng** — một tấm ảnh đắt bằng hàng chục lượt
chat nên không thể chung một rổ. Chat hết quota không ăn vào quota dịch.

```env
IMAGE_RATE_PER_DAY=5
VIDEO_RATE_PER_DAY=2
TRANSLATE_RATE_PER_DAY=200
```

### Với API dịch: gộp lô, đừng lặp

```jsonc
// TỐT — 1 lệnh gọi
{ "texts": ["chuỗi 1", "chuỗi 2", "…", "chuỗi 50"], "to": "vi" }

// TỆ — 50 lệnh gọi, system prompt bị gửi 50 lần
{ "text": "chuỗi 1", "to": "vi" }
```

System prompt dịch là 998 ký tự. Gọi 50 lần riêng lẻ nghĩa là trả tiền cho nó
50 lần. Một lệnh gọi với 50 chuỗi chỉ trả một lần.

Trần lô: `MAX_TRANSLATE_ITEMS=50`, `MAX_TRANSLATE_CHARS=5000`.

### Theo dõi thực tế

Dashboard ở `/admin` cho biết chính xác token đang đi đâu: tổng input/output,
phân tách theo model, theo user, theo giờ. Đó là cách duy nhất biết đòn bẩy nào
thực sự hiệu quả với lưu lượng của anh.

---

## 6. Deploy lên VPS

Hướng dẫn cho Ubuntu 22.04/24.04. Toàn bộ chạy bằng user thường, không phải
root.

### 6.1 Chuẩn bị máy

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx

node -v      # phải >= 18
```

Tạo user riêng cho service — **đừng chạy gateway bằng root**:

```bash
sudo adduser --system --group --home /opt/aigw aigw
sudo mkdir -p /opt/aigw/app
sudo chown -R aigw:aigw /opt/aigw
```

### 6.2 Lấy code và build

```bash
sudo -u aigw -H bash
cd /opt/aigw/app
git clone <repo-url> .
npm ci
npm run build          # ra dist/ + copy asset dashboard
exit
```

> `npm run build` **không phải** chỉ `tsc`. HTML/CSS/JS của dashboard không
> phải TypeScript nên `scripts/copy-assets.mjs` copy chúng sang `dist/`. Bỏ
> bước đó thì mọi trang admin sẽ 404 — mà chỉ 404 trên production, local vẫn
> chạy, nên rất khó phát hiện.

### 6.3 Biến môi trường

```bash
sudo -u aigw cp /opt/aigw/app/.env.example /opt/aigw/app/.env
sudo -u aigw nano /opt/aigw/app/.env
sudo chmod 600 /opt/aigw/app/.env      # chỉ user aigw đọc được
```

Cấu hình production tối thiểu:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash

AUTH_MODE=firebase
SERVICE_ACCOUNT_PATH=/opt/aigw/serviceAccount.json

TRANSLATE_PROVIDER=model
IMAGE_PROVIDER=off
VIDEO_PROVIDER=off

ADMIN_ENABLED=true
ADMIN_SETUP_TOKEN=<sinh bằng lệnh ở mục 7>
ADMIN_ACCOUNT_PATH=/opt/aigw/data/admin.json
ADMIN_LOG_PATH=/opt/aigw/data/requests.jsonl

PORT=8080
LOG_LEVEL=info
```

Service account Firebase (tải từ Firebase console → Project settings → Service
accounts). **Trên VPS thì bắt buộc dùng file này**, khác với Cloud Run nơi có
thể để `SERVICE_ACCOUNT_PATH=` rỗng và dùng metadata server:

```bash
sudo -u aigw nano /opt/aigw/serviceAccount.json    # dán nội dung vào
sudo chmod 600 /opt/aigw/serviceAccount.json
sudo mkdir -p /opt/aigw/data && sudo chown aigw:aigw /opt/aigw/data
```

### 6.4 systemd

`/etc/systemd/system/aigw.service`:

```ini
[Unit]
Description=AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aigw
Group=aigw
WorkingDirectory=/opt/aigw/app
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Siết quyền: service chỉ cần đọc code và ghi vào data/
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/aigw/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aigw
sudo systemctl status aigw
journalctl -u aigw -f          # xem log trực tiếp
```

### 6.5 Nginx + HTTPS

`/etc/nginx/sites-available/aigw`:

```nginx
server {
    listen 80;
    server_name gateway.example.com;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Gateway đọc header này để khoá brute-force theo đúng IP thật,
        # nếu thiếu thì mọi request trông như đến từ 127.0.0.1.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # BẮT BUỘC cho streaming chat. Nginx mặc định gom buffer, làm SSE
        # dồn cục và chỉ hiện ra khi đã trả lời xong — mất hẳn hiệu ứng
        # chữ chạy dần trong app.
        proxy_buffering off;
        proxy_cache off;

        # Render video và ảnh chạy lâu hơn timeout mặc định 60s.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/aigw /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# TLS
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d gateway.example.com
```

Certbot tự thêm block `listen 443 ssl` và chuyển hướng 80 → 443.

### 6.6 Tường lửa

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

**Không mở port 8080 ra ngoài.** Gateway chỉ nên nghe ở localhost, mọi thứ đi
qua nginx.

### 6.7 Trỏ app vào

```bash
flutter build apk --release --flavor product \
  --dart-define=AI_GATEWAY_URL=https://gateway.example.com
```

HTTPS nên không cần ngoại lệ cleartext — bản release chạy được.

### 6.8 Cập nhật về sau

```bash
sudo -u aigw -H bash -c 'cd /opt/aigw/app && git pull && npm ci && npm run build'
sudo systemctl restart aigw
```

Đổi provider thì chỉ cần sửa `.env` rồi `sudo systemctl restart aigw`, không
cần build lại.

### 6.9 Giới hạn cần biết trước khi scale

Quota, video job và session admin đều **nằm trong RAM**:

- Chạy 2 instance = mỗi instance một suất quota riêng, user được gấp đôi.
- Poll video rơi vào instance khác sẽ nhận `job_not_found`.
- Restart service là đăng xuất admin.

Muốn chạy nhiều instance thì phải chuyển `rateLimit.ts` và `videoJobs.ts` sang
Redis hoặc Firestore trước. Với một VPS đơn thì không vấn đề gì.

---

## 7. Dashboard quản trị

Bật bằng `ADMIN_ENABLED=true`, truy cập ở `/admin`.

Xem được: từng request với uid gọi, câu hỏi, model trả lời, token in/out, độ
trễ, biểu đồ lưu lượng theo giờ, phân tách theo model và theo user, lọc theo
khoảng thời gian / tính năng / model / trạng thái / user / tìm trong nội dung,
và xuất CSV.

### Đăng ký lần đầu

Chỉ chạy được **một lần** và phải có token, vì một deployment mới đã nằm trên
internet trước khi ai đó kịp chiếm tài khoản admin:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# đặt vào ADMIN_SETUP_TOKEN, restart, rồi mở:
#   https://gateway.example.com/admin/setup?token=TOKEN_ĐÓ
```

Luồng: nhập username + password → quét QR bằng Google Authenticator → nhập mã
xác nhận → hiện **10 recovery code chỉ một lần duy nhất** (lưu ngay, chúng được
băm và không lấy lại được) → vào thẳng dashboard.

Xong rồi `/admin/setup` đóng vĩnh viễn và có thể xoá token đi.

Mất điện thoại: đăng nhập bằng recovery code (mỗi cái dùng một lần). Mất luôn
recovery code: xoá file `ADMIN_ACCOUNT_PATH` rồi đăng ký lại từ đầu.

### Quyền riêng tư

```env
ADMIN_LOG_PROMPTS=true      # lưu cả nội dung tin nhắn
ADMIN_LOG_RETENTION_DAYS=30
```

Đặt `false` thì dashboard vẫn cho biết ai / lúc nào / model gì / tốn bao nhiêu,
nhưng **không ghi nội dung chat xuống đĩa**. Nếu app có cam kết không lưu hội
thoại thì phải để `false`.

Lịch sử là file JSONL ghi nối, nằm ở `ADMIN_LOG_PATH`. Cả nó và file tài khoản
đều nằm trong `data/` (đã gitignore). Nhớ **đưa `data/` vào backup**, hoặc chấp
nhận mất lịch sử.

### Bảo mật đã có sẵn

- Password băm scrypt (N=2^15, memory-hard), so sánh constant-time.
- **Mã TOTP chỉ dùng được một lần** — mã bị nhìn trộm không replay được ngay
  trong 30 giây của chính nó.
- Password đúng chỉ cho session "pending", mọi route dashboard vẫn từ chối cho
  tới khi nhập mã 2FA. ID session được đổi mới sau khi lên full.
- Cookie `HttpOnly` + `SameSite=Strict` + `Secure`, kèm CSRF token riêng.
- Sai 5 lần từ một IP → khoá 15 phút.

---

## 8. Sự cố thường gặp

| Triệu chứng | Nguyên nhân |
| --- | --- |
| `EADDRINUSE :::8080` | Process cũ còn sống. `npm run dev` → `tsx` → `node` là chuỗi process con, giết cái cha không giết cháu. Xem mục dưới. |
| App báo `network_unreachable` | IP trong `ai_gateway_config.dart` đã hết hạn DHCP, hoặc điện thoại khác mạng, hoặc firewall chặn. |
| `CLEARTEXT communication not permitted` | Đang chạy bản release mà trỏ vào `http://`. Dùng debug build hoặc deploy HTTPS. |
| Chat trả `502` ngay lập tức | Sai model name hoặc sai key. Xem log server — thông điệp thật của provider nằm ở đó, client cố tình không được biết. |
| Chat `504`, latency ~5ms | Không kết nối được upstream. Với `compat` thì thường là 9Router/Ollama chưa bật. |
| Streaming bị dồn cục trên production | Thiếu `proxy_buffering off` trong nginx. |
| Trang `/admin/*` trả 404 trên VPS | Build thiếu bước copy asset. Chạy lại `npm run build`, đừng chạy `tsc` trực tiếp. |
| `feature_disabled` | Provider của tính năng đó đang `off` trong `.env`. |
| `429 rate_limited` | Đụng quota. Dashboard hiện các dòng này dạng `rate_limited_day` / `rate_limited_minute`. |

### Giải phóng port đang bị chiếm

Windows:

```bash
netstat -ano | findstr :8080
taskkill /PID <pid> /F
```

Linux:

```bash
sudo ss -lptn 'sport = :8080'
sudo systemctl restart aigw
```

### Xem log

```bash
journalctl -u aigw -f              # trực tiếp
journalctl -u aigw --since "1 hour ago"
```

Thông điệp lỗi của provider **luôn nằm ở log server, không bao giờ trả về
client** — vì nó có thể lộ tên model hoặc key. Client chỉ biết `upstream_failed`
và việc thử lại có đáng hay không.
