# Hughes Living Auctions — auction core

The bidding engine, as Postgres. This is the part that has to be right before
anything else gets built, so it ships on its own and it ships tested.

## What is here

    supabase/migrations/0001_auction_core.sql   tables, rules, RPCs, RLS
    supabase/migrations/0002_realtime_and_close.sql   publication + sweeper
    supabase/seed.sql                           the thirteen bench lots
    test/run.sh                                 rebuild db, run everything
    test/01_engine_test.sql                     30 assertions on the rules
    test/02_race_test.sh                        concurrency invariants
    test/03_exposure_test.sql                   what anon and bidders can read
    test/00_auth_shim.sql                       fakes auth.uid() off Supabase

Run it against any local Postgres 15+:

    pg_ctl -D /tmp/pgdata -o '-k /tmp -p 5433' start
    PGHOST=/tmp PGPORT=5433 ./test/run.sh

## The shape of it

**Bids are append-only.** One row per submitted maximum, never updated, never
deleted. There are no synthetic "auto bid" rows, so the table is exactly what
people did — which is what you want in your hand when someone disputes a hammer.

**The price is derived, not stored by a client.** `resolve_price()` takes each
bidder's highest max and returns one increment over the runner-up, capped at the
leader's own max. `lots.current_price_cents` is a cache written only inside
`place_bid`, and the test suite asserts the cache still equals the derived value
after twenty connections fight over one lot.

**One row lock serializes everything.** `place_bid` opens with
`select … from lots where lot_no = $1 for update`. Validation, proxy resolution,
the clock extension and the insert all happen inside that lock, in one
transaction. Two bidders at the same millisecond cannot both win, and they
cannot each extend the clock separately.

**Nobody's maximum ever leaves the server.** RLS restricts `bids` to your own
rows, and column grants keep `reserve_cents` and `high_bidder` off `lots`
entirely — RLS is row-level only, which is the half that usually gets missed.
`my_positions()` answers "am I winning" without naming anyone else.

## The published rules, in one place

| Rule | Where |
|---|---|
| $5 under $50, $10 to $249, $25 to $999, $50 above | `bid_increment_cents()` |
| Bench protection, 6% of the bid, $8 minimum | `protection_cents()` |
| Proxy — you advance only to the next increment | `resolve_price()` |
| Two-minute rule | `place_bid`, extension is transactional with the bid |
| Buy-it-now comes off at the first bid | `place_bid` sets `buy_now_cents` null |
| Everything opens at a dollar | `lots.opening_cents` default 100 |

## Deliberate differences from the demo front end

1. **The two-minute rule now leaves exactly two minutes.** `app.js` did
   `lot.ends += 120000`, so a bid at 1:59 left produced 3:59 — bid late enough
   and the clock grew without limit. This sets `ends_at = now() + 2 minutes`,
   which is what "the clock pushes out two more" means on every other auction
   site. `max_extensions` is there if you ever want a hard cap; null is uncapped.
2. **Proxy bidding actually proxies.** The demo collected your max, showed it in
   the total, and threw it away — submitting just moved the price one increment
   and marked you the holder. Your max is now held server-side and defends the
   lot while you are away.
3. **The seeded lots open at $1 with no bid history.** Those "23 bids, $640"
   numbers were demo furniture. Real counts accrue from real bids.
4. **Bids are whole dollars.** The published increments are all whole dollars, so
   cents in a max were never meaningful.
5. **The current leader may raise their own ceiling without clearing the
   minimum.** They already hold the lot at the current price; anyone else has to
   clear `current_price + increment`.

## What is deliberately NOT here yet

- **Auth.** `bidders.id` references `auth.users`. Sign-in, registration and the
  paddle handout are the next slice.
- **Stripe.** Card on file at registration via SetupIntent, charged off-session
  after the hammer. Nothing here touches money yet.
- **Outbid notification.** Proxy bidding does not really work commercially
  without it. Hook it to an insert trigger on `bids` once auth exists.
- **Front-end wiring.** `app.js` still runs its localStorage engine. Replacing it
  means: render `ends_at` from the server instead of a page-load constant,
  subscribe to the `lots` publication, and call `place_bid` on submit.
- **Reserve handling in the UI.** The column and the close-time check exist;
  nothing displays it.

## Before real money moves

Auctioneer licensing and the "auction vs. timed online sale" distinction vary by
state, sales tax applies per lot, and the bench protection product may carry its
own rules depending on how the terms are written. Worth a real answer from
someone qualified before the first hammer, not after.
