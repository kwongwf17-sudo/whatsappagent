# Multi-Team Rollout

This app can run as one shared deployment for multiple business teams. Each team is represented by a `business_admin` account ID, and customer/order/message/follow-up records are scoped by `businessAccountId`.

## Hosting Shape

Run two processes from the same repo:

```powershell
npm start
npm run worker:followups
```

The web process serves the dashboard, demo routes, Meta webhook, and admin APIs. The worker process imports the same application code with `WHATSAPP_SKIP_HTTP=true` and runs due follow-ups on `FOLLOWUP_INTERVAL_MINUTES`.

For shared hosting, use Postgres:

```text
WHATSAPP_STORE=postgres
DATABASE_URL=postgres://user:password@host:5432/database
WHATSAPP_POSTGRES_TABLE=json_documents
```

The Postgres adapter keeps the current JSON-document store interface, so the app can move away from local JSON/SQLite without a full schema rewrite. Existing JSON files are imported into the Postgres document table the first time each document is read.

## Team Setup

Create a business admin account from the Super Admin area. Each team must have:

- a unique account ID
- one WhatsApp phone number ID
- one WhatsApp access token
- one OpenAI vector store ID if knowledge ingestion/RAG is used
- public base URL and asset base URL when sending uploaded images through the Cloud API
- follow-up pacing settings

Team settings are Super Admin-only. Normal business admins should edit products, FAQ, sales replies, orders, and handoffs, but they should not see or manage WhatsApp tokens.

Use Super Admin:

```text
GET /superadmin/system
POST /superadmin/team-settings
```

Example payload:

```json
{
  "settings": {
    "publicBaseUrl": "https://agent.example.com",
    "whatsappPhoneNumberId": "1234567890",
    "whatsappAccessToken": "EAA...",
    "openaiVectorStoreId": "vs_...",
    "followupSendsPerMinute": 10,
    "followupIntervalMinutes": 1
  }
}
```

Public responses mask sensitive WhatsApp credentials. The WhatsApp access token is encrypted at rest using `ADMIN_SESSION_SECRET` before it is stored, then decrypted only internally by the outbound sender. Re-save existing team tokens after deploying this version so older plain-text values are replaced.

## Team Content

Each team gets isolated product and reply content in `team_content.json` or the configured shared store. On first access, a team is seeded from the default files:

- `product_catalog.json`
- `general_faqs.json`
- `sales_replies.json`

After that, the team's catalog, package prices, opening flow, product images, approved FAQ replies, and sales replies are saved separately. Product image uploads are stored under a team-specific asset path:

```text
assets/<account-id>/<product-id>/<filename>
```

For team-specific OpenAI knowledge ingestion:

```powershell
node ingest_knowledge.mjs --account-id TEAM_ID --knowledge-dir knowledge/TEAM_ID
```

The script creates or reuses that team's vector store and saves the `openaiVectorStoreId` back to Super Admin Team Settings.

## Tenant Boundaries Added

The app now has scoped reads for:

- customers
- deleted customers
- orders
- outbox/messages
- no-reply reviews
- follow-up queue
- operational errors and failed messages
- product/catalog content
- uploaded product image paths
- approved FAQ replies
- approved sales replies
- OpenAI vector store IDs

Incoming Meta webhooks preserve `metadata.phone_number_id`; the app maps that value to the matching business account and stores the inbound message under that team. Outbound Cloud API sends use the team-specific WhatsApp phone number ID and access token when configured, falling back to global `.env` credentials for single-team deployments.

## Required Before Deploying Multiple Teams

- Rotate OpenAI, Meta, Super Admin, Admin, and session secrets before production.
- Set a strong stable `ADMIN_SESSION_SECRET`; changing it later prevents existing encrypted team tokens from decrypting until you re-save them.
- Run `npm start` for the web process and `npm run worker:followups` for scheduled follow-ups.
- Use Postgres or another shared durable store for multi-team hosting.
- In Super Admin, create each team and set its WhatsApp phone number ID, WhatsApp access token, public URL settings, and vector store ID if used.
- In each team dashboard, configure that team's products, packages, product images, FAQ replies, and sales replies.

## Later Hardening

Move from document-style Postgres storage to normalized Postgres tables when reporting volume grows. The current adapter is a deployment bridge, not the final analytics schema.
