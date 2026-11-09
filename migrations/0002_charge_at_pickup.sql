-- Insured renters: the card is held at request, saved, approved without charging, then charged the day
-- before pickup (new status 'confirmed' = approved, waiting to be charged).
ALTER TABLE bookings ADD COLUMN customer_id TEXT;        -- Stripe customer that owns the saved card
ALTER TABLE bookings ADD COLUMN payment_method_id TEXT;  -- saved card to charge off-session
ALTER TABLE bookings ADD COLUMN charge_error TEXT;       -- last failed charge message (cleared when the renter updates their card)
ALTER TABLE bookings ADD COLUMN charge_failed_at TEXT;
