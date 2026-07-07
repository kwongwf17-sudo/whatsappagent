# Safe Development Workflow

Use this workflow when real customers are already using the WhatsApp agent.

## Branches

- `master`: production only. Railway production should deploy only from this branch.
- `staging`: test changes here before production. Railway staging should deploy only from this branch.
- `codex/*`: short-lived development branches for risky or larger changes.

Do not test risky behavior directly on production.

## Railway Services

Create two separate Railway app services:

1. Production
   - Git branch: `master`
   - Database: production Postgres
   - WhatsApp: real customer number
   - `DEMO_MODE=false`

2. Staging
   - Git branch: `staging`
   - Database: separate staging Postgres
   - WhatsApp: test number, or keep in demo mode
   - `DEMO_MODE=true` until a test WhatsApp number is ready

The two services must not share the same WhatsApp Web session directory or production database.

## Safe Release Flow

1. Make code changes on a development branch, or directly on `staging` for small fixes.
2. Push to `staging`.
3. Test in staging using `/demo/chat`, Customer Demo, or a test WhatsApp number.
4. Confirm:
   - opening flow works
   - product detection works
   - RAG/vector-store answer works when relevant
   - order submission works
   - follow-up queue behavior is correct
   - no unexpected customer reply is sent
5. Merge or cherry-pick the tested commit to `master`.
6. Push `master` so Railway production redeploys.

## Feature Flags

For unfinished features, add an env setting and keep it disabled in production until tested.

Recommended naming:

```text
ENABLE_FACEBOOK_MESSENGER=false
ENABLE_MEDIA_AI_READING=false
ENABLE_NEW_FOLLOWUP_ENGINE=false
```

Staging can turn a flag on first. Production should turn it on only after staging is confirmed.

## Database Safety

- Production and staging must use different `DATABASE_URL` values.
- Before a risky release, create a Railway Postgres backup.
- Prefer additive changes: add new fields first, keep old fields working, then remove old logic later.
- Do not run cleanup scripts against production unless the target account/team is explicit.

## WhatsApp Safety

- Do not scan the production WhatsApp QR just to test new features.
- Use staging demo mode or a separate test WhatsApp number.
- Keep `WHATSAPP_WEB_PROCESS_FROM_ME=false` in production unless there is a specific approved test.
- Verify media/image URLs in staging before production.

## Knowledge Sync Safety

Each team has its own vector store ID. When testing product knowledge:

```powershell
node ingest_knowledge.mjs --account-id TEAM_ID
```

Run this against staging first. Confirm the correct team vector store before syncing production.

## Rollback

If production breaks after a deploy:

1. In Railway, redeploy the previous successful deployment.
2. Or revert the bad commit on `master` and push.
3. Keep the failed commit on `staging` for debugging.

