# Customer message processing

The existing pending buffer now retains an active `processingBatch` in its JSON payload. New arrivals accumulate in the outer `messages`, `sources` and `messageIds` arrays. Claim and completion use the existing store write queue, and an in-process guard permits one flush per buffer key. Successful completion removes only its own batch. Pending arrivals are scheduled afterward; failures retain the active batch for retry. Startup recovery uses the same pending-buffer loader and scheduler. No new service or database table is required.

The guard follows the current single app process deployment; it is not a distributed lease. Recovery retains the existing retry semantics. A crash after an external WhatsApp send but before the completion checkpoint is not an exactly-once transport guarantee.

Batch-processing audit events record a batch ID, fragment count and inbound message IDs for future diagnosis. Existing buffers without this metadata remain supported.

The route classifier distinguishes order-price confirmation from shipping progress using an optional `conversationAction` on the existing product/general-FAQ route. Confirmations use the latest order linked to the same customer and account, including its saved option/package price, rather than the current promotion. Missing prices go to admin review. Shipping status remains on the existing status handler.

Closing thanks recognise existing acknowledgement spellings plus `oke`. Standalone closing thanks bypass product retrieval and handoff after sales/order completion. Pending-order, package-interest and upsell states still use contextual routing, so agreement can continue order collection. Acknowledgements containing an actual question or request do not qualify for silent closing.

Validation: durable buffer overlap, message preservation, restart recovery, retry, customer isolation, actual staging PostgreSQL adapter with a rolled-back temporary table, acknowledgement spelling/intent guards, and live model tests for correct/incorrect price, thanks, shipping, missing price, and order agreement.
