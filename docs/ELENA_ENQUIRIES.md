# Elena answers buyers, and the owner's "what needs you" list

Per listing the owner switches Elena on (Listing edit, Review step, "Let Elena answer buyers"). Off by default.

**What she does.** A buyer message in an enquiry thread is classified (bedrooms, parking, price, address, documents, inspection...). The reply is built from fixed sentences filled with the listing facts and the owner's *public, active* documents. Nothing is generated, so nothing can be invented. Anything she cannot answer (unknown fact, offers, a scam-looking message, "lowest price") goes to the owner; scam/floor-probe messages get no reply at all.

**Never.** States a price or any amount, discusses or agrees terms, gives the street address (it is shared when an inspection is booked; notifications name only the suburb), sends contact details. Every reply passes `checkReply` (content filter, wording filter, no amounts, no address leak) before it is stored, again when the owner approves.

**Owner controls.** On/off, offer inspections (uses the owner's open-inspection availability at `/open-inspections`), send without approval (default: approve first). Limits: 6 replies per thread per day, 20 per listing per hour (drafts waiting for approval count). Everything is in `elena_enquiry_action` and shown to the owner (listing panel and thread card). Elena's replies are `enquiry_message` rows with `elena = true` (append-only like all messages).

**Booking.** The thread shows the buyer the free times; one tap books through the normal open-inspection booking (confirmation to buyer, alert to owner/agent, 24h and 1h reminders to the buyer, 24h reminder to the owner). Elena logs the booking and sends the owner a short summary.

**Owner list.** `GET /api/owner/today` builds the list from live tables: replies to approve, buyer questions waiting, offers, contractor times/jobs needing the owner, inspections in the next 24h, old drafts. Each item has one action (a POST such as approve, or a link). Optional daily email (`owner_digest_setting`), sent from 7 am local, once per day, only when something needs the owner, from the existing automations tick.

**Ops.** Migration `db/20261120150000_elena_enquiries.sql`. The `/api/internal/automations/run` tick also handles missed buyer messages and the digest. No new env vars.
