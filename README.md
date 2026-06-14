# WhatsApp AI Customer Service Agent

This module is a one-user demo agent for WhatsApp Business customer service. It can run locally without WhatsApp credentials first, then switch to the Meta WhatsApp Cloud API when you are ready. The current demo product is `Blackhead Remover`.

## What It Does

- Replies to WhatsApp messages that come from Facebook ads.
- Chooses the product flow from the ad referral or customer message.
- Sends a product opening flow with text and image messages.
- Labels customers as `new_customer`, `day_1_customer`, or `day_2_customer`.
- Sends follow-up messages based on the customer label.
- Answers approved FAQ by semantic meaning while sending only saved business replies, then uses OpenAI file-search RAG for broader knowledge when configured.
- Collects order details and records them in JSON or SQLite storage.
- Sends an admin notification for each new order.
- Sends customers a runner/delivery message when admin marks an order as reached warehouse.
- Lets Business Admin move orders from `Order Submitted` to `Reached Warehouse`.
- Answers customer order-status enquiries from the latest order belonging to the same business account and WhatsApp customer.
- Detects complaints, refunds, damaged or wrong-item reports, and report/legal threats for human handoff.

## Local Demo

1. Copy the env example:

```powershell
Copy-Item whatsapp_agent\.env.example whatsapp_agent\.env
```

2. Keep `DEMO_MODE=true` in `whatsapp_agent/.env`.

3. Save the Blackhead Remover images into `whatsapp_agent/assets/blackhead-remover/` using the filenames listed in `whatsapp_agent/assets/blackhead-remover/README.md`.

4. Start the server:

```powershell
npm run whatsapp:start
```

5. Send a demo customer message:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/demo/message -ContentType "application/json" -Body '{"from":"demo_customer_1","text":"Assalamualaikum, interested","source":{"referralHeadline":"Facebook ad blackhead remover"}}'
```

The response shows the text/image messages the bot would send. Demo outbound messages are also saved to:

```text
whatsapp_agent/data/outbox.json
```

## SQLite Storage

For a real WABA pilot, use SQLite instead of JSON files:

```powershell
$env:WHATSAPP_STORE="sqlite"
$env:WHATSAPP_SQLITE_PATH="agent.sqlite"
```

Then start the server normally. The app stores admin accounts, customers, orders, outbox messages, complaints, audit logs, profile settings, failed messages, and follow-up queue records in:

```text
whatsapp_agent/data/agent.sqlite
```

Existing JSON files are imported into SQLite automatically the first time each document is read. Keep uploaded product images in `assets/`, and keep the product catalog in `data/product_catalog.json` for now.

## Demo Order Flow

Ask to order:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/demo/message -ContentType "application/json" -Body '{"from":"demo_customer_1","text":"I want to order"}'
```

Submit order details:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/demo/message -ContentType "application/json" -Body '{"from":"demo_customer_1","text":"Name: Ali\nPhone: 6731234567\nDelivery address: Kiulap\nPackage: B"}'
```

View recorded orders:

```powershell
Invoke-RestMethod http://localhost:3000/admin/orders
```

## Follow-Ups

Run follow-ups manually:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/admin/followups/run
```

To run them automatically, set:

```text
FOLLOWUP_AUTORUN=true
FOLLOWUP_INTERVAL_MINUTES=1
FOLLOWUP_SENDS_PER_MINUTE=10
FOLLOWUP_RETRY_MINUTES=5
```

Follow-up text and timing live in:

```text
whatsapp_agent/data/product_catalog.json
```

Due follow-ups are saved to `whatsapp_agent/data/followup_dispatch_queue.json`. The worker
sends no more than `FOLLOWUP_SENDS_PER_MINUTE` messages per one-minute check, retries
temporary send failures after `FOLLOWUP_RETRY_MINUTES`, and rechecks opt-out, order,
and WhatsApp 24-hour-window rules before every dispatch.

## Reached Warehouse

When stock reaches warehouse, use the Orders tab in the admin dashboard to mark the order as `Reached Warehouse`. The agent sends the saved runner/delivery message to the customer.

The legacy `/admin/stock-arrival` endpoint is still available for batch updates, but the dashboard button is the normal workflow.

## Order Tracking

Each order status change is recorded in the order status history with its timestamp and actor.

Business Admin can edit the approved WhatsApp reply for each order stage in the `Orders` tab of `/admin/dashboard`. When a customer asks about their own order progress, OpenAI classifies the request by meaning and the application sends only the saved status reply for that business account.

Orders, order-status replies, and customer records are scoped by `businessAccountId`, so the same WhatsApp customer can exist under more than one business account without crossing order results.

## Complaint Handoff

When a customer raises a complaint, requests a refund/return, reports a damaged or wrong item, or threatens a report/legal action, the agent:

1. Sends the saved complaint acknowledgement message once.
2. Adds a case to the Business Admin `Handoff` tab.
3. Blocks promotional follow-ups and automatic FAQ/sales responses while the case is open.
4. Resumes automation only after Business Admin marks the case resolved, unless the customer has opted out or already submitted an order.

Business Admin can edit the complaint acknowledgement message from the `Handoff` tab. Complaint cases and settings are scoped by `businessAccountId`.

## RAG FAQ Setup

Open `http://localhost:3000/admin/faq-library` to maintain approved FAQ replies:

- `General FAQ` applies to every product, for example delivery charge or business location.
- `Product FAQ` applies only to the selected product, for example suction heads or product usage.
- Add several example customer questions for each FAQ. When OpenAI is configured, the agent matches similar customer meaning to one approved FAQ ID and sends the stored approved reply exactly.

For broader product documents or SOP answers that are not in the approved FAQ library, use OpenAI file search:

1. Put product info, FAQ, and SOP documents in `whatsapp_agent/knowledge/`.
2. Add `OPENAI_API_KEY` to `whatsapp_agent/.env`.
3. Upload the knowledge base:

```powershell
npm run whatsapp:ingest
```

4. Put the printed `OPENAI_VECTOR_STORE_ID` into `whatsapp_agent/.env`.

## WhatsApp Cloud API Setup

When local demo behavior looks right:

1. Set `DEMO_MODE=false`.
2. Fill in:

```text
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
ADMIN_WHATSAPP_NUMBER=
PUBLIC_BASE_URL=
```

3. Start the server:

```powershell
npm run whatsapp:start
```

4. Expose it with HTTPS, for example:

```powershell
ngrok http 3000
```

5. In Meta Developers, set the webhook callback URL:

```text
https://YOUR_PUBLIC_DOMAIN/webhook
```

Use the same verify token as `WHATSAPP_VERIFY_TOKEN`.

## Useful Endpoints

- `GET /health`
- `GET /webhook`
- `POST /webhook`
- `POST /demo/message`
- `GET /demo/state`
- `POST /admin/followups/run`
- `GET /admin/orders`
- `POST /admin/stock-arrival`
- `GET /admin/order-status-replies`
- `POST /admin/order-status-replies`
- `GET /admin/complaint-settings`
- `POST /admin/complaint-settings`
- `POST /admin/handoff/complaint/resolve`
- `GET /admin/faq-library`

## Next Production Steps

- Replace `product_catalog.json` with your real product flows, product images, FAQ, pricing, and stock rules.
- For production image sending, set `PUBLIC_BASE_URL` to your HTTPS tunnel/domain or replace catalog image paths with hosted HTTPS links.
- Use `WHATSAPP_STORE=sqlite` for the first real WABA pilot.
- Add approved WhatsApp message templates for business-initiated messages outside the customer service window.
- Move follow-up queue and customer records to PostgreSQL before high-volume multi-account ads.
