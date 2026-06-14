# Reply Flows

## Facebook Ad Greeting

When a customer starts a chat from a Facebook ad, identify the product from the referral/ad text or message. Send the product opening flow from `product_catalog.json`, including text and image messages.

## Labels

- `new_customer`: first day after the first message.
- `day_1_customer`: one day after the first message.
- Continue labels until `day_10_customer`.
- On day 11, customers with no order and no opt-out can be expired/deleted from active follow-up.

Use the matching follow-up message for the customer's current label. Send each label follow-up only once.

Follow-up continues even if the customer asks normal questions, replies with sales objections, or asks FAQ.
Only stop follow-up when:

- Customer submits complete order details.
- Customer clearly opts out, for example "stop", "unsubscribe", "jangan message", "nda minat", or similar meaning.

## Order Capture

When the customer wants to order, ask for:

- Full name
- Full address
- Phone number
- Order Package

Use this exact order request:

Noted and thank you.

Can you help me fill up this details for hold promo? 🥰

✅ Full name :
🏠 Full address :
📱 Phone number :

Order Package :

After all required details are available, record the order, notify admin, and tell the customer:

Sorry Dear our stock just finish , it will take order again, will take around 15-18 days for arrived brunei new stock 🥰

REMINDER : ORDER AFTER 1 HOURS CANNOT BE CANCEL

But i will proceed system for COD service 🥰

Brg Sampai baru byr runner

## Stock Arrival

When admin marks a product as stock arrived, notify customers with pending orders and ask for preferred delivery date and time.

## General Approved Replies

These replies apply to all products:

- Customer: Business location kat mana?
  Reply: Warehouse at bandar. Tapi skrg buleh proceed delivery dgn MP service saja
- Customer: Delivery ada caj?
  Reply: nda ya
- Customer: Ada delivery?
  Reply: ada
- Customer: Buleh bayar hujung bulan?
  Reply: Buleh
- Customer: Berapa hari barang baru sampai?
  Reply: 15-18 days.
- Customer: nanti if barang sampai kita deliver or pickup sendiri?
  Reply: Kami akan deliver ya.

After any approved general FAQ or product FAQ answer, send this as a separate sales follow-up message:

Ada minat nak beli Package B?

When the customer replies directly to that question:

- Customer: ada
  Reply: Send the order details form.
- Customer: nda minat
  Reply: bah, terima kasih.

## Unknown Answer

If the answer is not in the knowledge base, say that you will check with the team rather than guessing.
