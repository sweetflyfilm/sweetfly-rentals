-- Rental bookings. Money is integer cents. Renter ID images are never stored here:
-- Stripe Identity holds them, we keep only the verification status.
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,                    -- secret in the renter status link
  status TEXT NOT NULL DEFAULT 'pending', -- pending (at Stripe) | requested (card held, awaiting Grant) | offered (Grant changed the order, awaiting renter) | paid (approved + charged) | picked_up | returned | declined | cancelled | expired
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  waiver_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,           -- everything charged, deposit included
  has_coi INTEGER NOT NULL DEFAULT 0,
  coi_key TEXT,                           -- private R2 object
  coi_name TEXT,
  stripe_session_id TEXT,
  payment_intent TEXT,
  identity_session_id TEXT,
  identity_status TEXT NOT NULL DEFAULT 'none', -- none | pending | verified | failed
  identity_name TEXT,                     -- name on the ID, to compare with the booking name
  deposit_refunded_cents INTEGER NOT NULL DEFAULT 0,
  other_refunded_cents INTEGER NOT NULL DEFAULT 0,
  admin_note TEXT,
  terms_accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,                        -- Stripe checkout window, then the card-hold deadline
  authorized_at TEXT,                     -- card held
  paid_at TEXT,                           -- approved and charged
  decline_reason TEXT,
  offer_json TEXT,                        -- Grant's amended order while status = offered
  offer_session_id TEXT,                  -- Stripe session if the amended order needs a new card hold
  offered_at TEXT
);
CREATE INDEX IF NOT EXISTS bookings_dates ON bookings (start_date, end_date);
CREATE INDEX IF NOT EXISTS bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_session ON bookings (stripe_session_id);

-- Dates Grant blocks by hand, e.g. gear booked on ShareGrid. end_date is the return day (exclusive), like bookings.
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_dates ON blocks (start_date, end_date);
