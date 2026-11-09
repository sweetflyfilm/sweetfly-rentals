# Shop checkout: one-time setup

Nothing here is live yet. Do these in order.

## 1. Cloudflare (free tier)
```
npx wrangler d1 create sweetfly-shop                 # paste the database_id into wrangler.toml
npx wrangler d1 execute sweetfly-shop --remote --file=migrations/0001_init.sql
npx wrangler d1 execute sweetfly-shop --remote --file=migrations/0002_charge_at_pickup.sql
npx wrangler r2 bucket create sweetfly-shop-private  # keep private: NO public URL, NO custom domain
```
Then Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> connect the `sweetfly-rentals` GitHub repo.
Build command: none. Output directory: `/`. After the first deploy, Settings -> Bindings should show DB and DOCS (they come from wrangler.toml).

## 2. Secrets (Pages -> Settings -> Variables and Secrets, or `npx wrangler pages secret put NAME --project-name=sweetfly-shop`)
| Name | What |
|---|---|
| STRIPE_SECRET_KEY | `sk_live_...` (use `sk_test_...` first) |
| STRIPE_WEBHOOK_SECRET | `whsec_...` from step 3 |
| ADMIN_TOKEN | a long random string; it is the password for /admin.html |
| NOTIFY_WEBHOOK_URL, NOTIFY_WEBHOOK_SECRET | the n8n email flow (already built and published). Exact values are in `.shop-secrets.local.txt` |
| REMINDER_TOKEN | a long random string; read-only token the n8n morning reminder uses for `/api/reminders/charges-due` |
| SITE_URL | optional: base for links in emails (set to the pages.dev address while reviewing) |
| TURNSTILE_SECRET | optional bot check; also put the site key in `catalog.json` -> `turnstileSiteKey` |

## 3. Stripe
1. Turn on **Identity** (Dashboard -> Identity). Check "require matching selfie" is allowed. About $1.50 per check.
2. Developers -> Webhooks -> add `https://shop.sweetflyfilm.com/api/stripe-webhook` with events:
   `checkout.session.completed`, `checkout.session.expired`, `payment_intent.canceled`,
   `identity.verification_session.verified`, `identity.verification_session.requires_input`.
   Copy the signing secret into STRIPE_WEBHOOK_SECRET.
3. Settings -> Customer emails: turn on "Successful payments" receipts.
4. Test mode first: card 4242 4242 4242 4242; Identity test mode has its own test documents.

## 4. Domain
Point `shop.sweetflyfilm.com` at the new Pages project (Pages -> Custom domains). That is one DNS record on the subdomain;
sweetflyfilm.com is not touched. Delete `CNAME` from the repo once GitHub Pages is off.
Put `/admin.html` and `/api/admin/*` behind Cloudflare Access too if you want a second lock.

## 5. Numbers to confirm before launch (all in `catalog.json`)
- `stock`: how many generators, canopies, tables, chairs, jugs, airpots, camera/light/dolly kits you own. Current values are guesses.
- Days are noon to noon (`pickupTime` / `returnTime` in `catalog.json`): pickup Mon, return Tue = 1 day. Same-day turnaround for the next renter is allowed.
- `deposit` per item, `waiverRate` (12%), `noInsuranceDepositMultiplier` (2x).
- `taxRate` 8.25%. Colorado rentals are taxed and Aurora/Denver are home-rule cities; confirm the rate and whether the waiver is taxable with your accountant. The waiver is currently taxed.
- `rental-terms.html` is a draft (cancellation, late fee, waiver limits). Read it.

## 6. Public files to move out of the repo
`Sweet Flypaper of Film - Master Gear Inventory & Rate Card.md/.docx` sit in the repo root and would be public on the site.

## Testing with real Stripe test keys (VS Code Stripe extension)
The Stripe extension needs the Stripe CLI. Install it, run `stripe login` once (opens the browser), then:
`stripe listen --forward-to localhost:8788/api/stripe-webhook` prints a `whsec_...` signing secret.
Put that and your `sk_test_...` key in `.dev.vars` (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN), run `npx wrangler pages dev . --port 8788`,
and use card 4242 4242 4242 4242. Real test webhooks hit your local server, no deploy needed. `stripe trigger` can fire sample events.

## Local testing
`npm test` (pricing and availability). `npx wrangler pages dev .` with a `.dev.vars` file (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN) and
`npx wrangler d1 execute sweetfly-shop --local --file=migrations/0001_init.sql`.

## Insured renters: charged the day before pickup
With a certificate on file there is no deposit and no waiver. The card is held at request and also saved. **Approve** only confirms the
dates (status `confirmed`, nothing charged; the booking holds the gear). The day before pickup press **Charge now** in `/admin.html`: it
captures the original hold if Stripe still has it, otherwise charges the saved card off-session. If the charge fails, the booking stays
`confirmed`, the renter gets an email with an **Update my card** button (a Stripe page that only saves a card), you get an email when they do,
and you press Charge again. n8n workflow "PROD -- Schedule -- Shop Charge Reminders" emails you each morning with what to charge.

## Request-to-book flow
The card is authorized (held) at checkout, not charged. In `/admin.html` you **Approve** (charges the card) or **Decline** (releases the hold,
nothing charged, optional reason shown to the renter). Card holds last about 7 days; after that Stripe drops them and the request shows as expired.
Requests don't block gear. Only approved bookings and dates you block by hand do. If you approve something that overlaps, the admin warns you first.
Counter-offers: in the admin, **Change dates / items** (e.g. 3 of the 4 days). The renter gets an email and accepts or declines on their status page in one tap; their card, ID and insurance stay on file. If the new total is at or under the held amount, only the lower amount is captured. If it's higher, they confirm their card once more.
Emails (n8n workflow `syNDMseyEaM3Lj2C`, Gmail as grant@sweetflyfilm.com): `booking.requested` (you + renter), `booking.approved`, `booking.offered`, `booking.offer_accepted` (renter + FYI to you), `booking.declined`, `booking.offer_declined` (you), `booking.expired` (you + renter), `booking.id_failed` (you + renter). `booking.id_verified` sends nothing.
Tax: `taxRate` in `catalog.json` is 0, so no tax line shows anywhere. Set it back (e.g. 0.0825) and tax reappears everywhere.

## How it works
- Browser prices the cart with `pricing.js`; the server re-prices with the same file and never trusts the browser's numbers.
- `POST /api/checkout` validates, stores the insurance file in the private bucket, and creates a Stripe Checkout session that only authorizes the card.
- The webhook marks the request as received. The thank-you page then sends the renter to Stripe Identity (license + selfie). Stripe keeps the images.
- `/admin.html`: see bookings, open insurance files, flag name mismatches, mark picked up/returned, refund the deposit or part of it, refund a cancellation.
