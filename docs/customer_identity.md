# Customer identity and duplicate repair

Imports, inbound text/media, manual WhatsApp replies, and reconnect recovery resolve
customer identity before recording messages or creating customers. A phone number,
phone JID, and WhatsApp LID can point to the same existing customer. Matching always
requires a business account; the same phone in another account remains independent.

The Postgres adapter stores aliases in `customers_identities` (derived from the
configured customer table name) and indexes the stored phone field. JSON/SQLite
storage retains the existing document architecture and uses `customer_identities.json`.
Unknown LIDs remain separate until WhatsApp supplies reliable phone metadata.
Existing conflicting records are not silently merged during message processing.

## Repair an existing duplicate

The repair command previews one explicit pair by default:

```powershell
railway run node scripts/merge_duplicate_customer.mjs --account=JointCare --target=6737326455@s.whatsapp.net --duplicate=125847323324420@lid
```

Add `--apply` to repair that pair. The live repair requires the Postgres customer
and follow-up tables. It does not bulk-merge other customers.

The dedicated operation runs in one transaction, requires matching verified phone
numbers within an account, and refuses conflicting products or active pending
order states. Active message buffers, processing messages, and processing follow-up
rows block repair. It combines sent history, order IDs and opening history,
preserves blocking states, migrates message/order/complaint/operational references,
and removes duplicate follow-up dispatch entries. Sent stages cannot become pending.
Aliases redirect future messages to the surviving record. A repeated merge is a no-op.
Original customer and queue snapshots are retained in a `customer_merge_backup_*`
JSON document. The normal customer deletion operation is not used.

**Queue due times are preserved.** This change does not synchronize follow-up
settings or recalculate existing schedules. Queue alias normalization only prevents
an old customer ID from recreating duplicate pending entries after repair.

## Validation

```powershell
node --test lib/customer_identity.test.mjs lib/store.test.mjs lib/web_whatsapp_transport.test.mjs
railway run node scripts/test_customer_identity_postgres.mjs
```

Postgres integration tests create a unique isolated schema, test with fixtures,
and drop that schema afterward. They do not use production customer tables.
