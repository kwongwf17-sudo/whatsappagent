# Customer import journey

New `continue_followups` imports select a customer journey day (`NEW`, or `DAY 1` through `DAY 10`). These options are independent of message keys and their positions in the follow-up settings. Earlier configured days are marked complete; the selected day and later days remain eligible. A missing Day 2 message does not make Day 3 act as Day 2.

Each newly created imported customer stores version 1 `importJourney` metadata in the existing customer payload. The actual import timestamps remain unchanged. Labels, remaining follow-up dates, and stale-customer deletion use the selected starting day plus elapsed business calendar days. Fixed-time messages use their configured journey day and business time. Delay-after-opening messages use their configured duration against the equivalent journey start.

If the selected day's send time has passed, its message becomes due at import and enters the existing paced dispatch queue. For example, importing at DAY 9 queues Day 9 today and Day 10 tomorrow, rather than waiting another nine and ten days. Existing pacing, transport, dispatch, and opt-out checks still apply.

The existing deletion conditions still apply: at logical Day 11 or later, only customers with at most one inbound message and no orders qualify for stale-customer deletion. Responsive customers and customers with orders retain their existing protections. A fresh ad journey or subsequent product journey reset supersedes the import clock.

Customers matched within the same account during a `continue_followups` import are skipped; their history, opt-out state, product, and pending queue are preserved. Submitted-order import behavior is unchanged. Older imports without version 1 metadata keep their existing clocks and queues; this change performs no historical migration or queue synchronization.

Validation includes helper/store tests for every starting day, custom keys, missing days, multiple messages on one day, elapsed delays, late imports, labels, stale deletion, and fresh journey resets. Isolated HTTP tests exercise the real preview/import routes, customer matching, account isolation, queued dates, and preservation of existing records.
