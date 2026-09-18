# Hughes Living Auctions

Auction front end for the pallet side of Hughes Living Co. — furniture, household goods
and odd lots bought by the pallet (customer returns, freight damage, short parts), repaired
on the bench, then sold at auction or buy-it-now with optional coverage.

Local preview: port **8753** (`hla-auctions` in `~/.claude/launch.json`).

## Running it

The site talks to one of three engines, chosen in `config.js`. It never decides an auction
question itself — prices, minimums, extensions and who is leading all come from the engine.

| Backend | What answers a bid | When |
|---|---|---|
| `demo` | the page, against `lots-demo.json` | static hosting with no database. Says so on screen. |
| `local` | Postgres, via `server/` | development on this machine |
| `supabase` | the same Postgres, hosted | production |

### Local, with the real engine

Needs Node. It does **not** need Postgres installed — `embedded-postgres` ships the binaries.

```
npm install
npm run pg       # Postgres on 5433, in its own terminal
npm run db       # migrations + seed, writes lots-demo.json
npm run serve    # http://127.0.0.1:8754
```

`config.js` selects the `local` backend automatically when the page is served from port 8754.
Sign-in there is passwordless on purpose: it exists so you can open two browsers and bid
against yourself. It is not authentication, the server refuses to bind anywhere but loopback,
and Supabase Auth replaces it in production.

### Tests

```
npm test
```

52 assertions: the published rules, what anon and a signed-in bidder can read, and a race
suite that fires 20 real connections at one lot and checks that nothing is lost, exactly one
bidder leads, the cached price still equals the derived price, and ten simultaneous bids
inside the two-minute window leave two minutes rather than twenty.

`test/run.sh` and `test/02_race_test.sh` are the original bash + psql versions. They need a
`psql` on PATH; `run-tests.mjs` does the same work over the wire and does not.

### Going to Supabase

1. Create a project, then run `supabase/migrations/0001`, `0002` and `supabase/seed.sql`.
2. Put the project URL and the **anon** key in `config.js` and set `backend` to `'supabase'`.

The anon key is meant to be public — row level security is what restricts it, and the engine
was written for exactly that: `bids` is readable only by its owner, and column grants keep
`reserve_cents` and `high_bidder` off `lots` entirely. The **service_role** key bypasses all
of it and must never appear in this repo or anywhere the browser can see.

See `docs-auction-core.md` for the engine's design and the list of what it deliberately does
not do yet.

## Listing a pallet

Lots come in from a spreadsheet, not by hand-writing SQL.

```
node tools/import-lots.mjs pallet-0451.csv --images ./photos/0451      --open "2026-08-28 09:00" --close "2026-08-30 19:00" --stagger 4
```

That prints what it would do and writes nothing. Add `--commit` to list them.

`tools/lots-template.csv` is the shape. Required per row: `category`, `title`,
`grade`, `found`, `fixed`, `still`. Optional: `ref`, `pallet`, `retail`,
`buy_now`, `reserve`, `image`, `alt`, `opening`.

**It validates the whole file before writing any of it**, because a
half-imported pallet is worse than none. It rejects a bad grade, a missing
photo, a `buy_now` above retail or below the opening, cents in a `buy_now`
when the increments are whole dollars, two rows with the same title and no
`ref` to tell them apart — and an empty `Still` line, which is the one that
matters. Publishing the remaining flaw is the whole trust mechanism, so a
blank one is an error, not a warning. Write "Nothing worth printing" when a
piece genuinely came back clean.

Lot numbers are handed out by the database. Closing times are computed from
`--close` and `--stagger`, which matches how the sale actually runs: pallets in
Tuesday, lots open Friday, everything closes Sunday evening a few minutes apart.

Re-running the same file is safe. Rows are matched on `ref` (or pallet + title),
so a second run corrects the listing rather than duplicating it — and **a lot
that already has bids on it is skipped entirely.** Nothing about a live lot
changes under the people bidding on it.

The importer talks to Postgres directly and does not go through the browser
API, so `lots` stays unwritable by any client, which is doing real security
work. Credentials come from the environment, never from a file in this repo:
`DATABASE_URL` for Supabase, or the `PG*` variables locally.

Photos are copied into `img/` and referenced relatively. That is fine for a
pallet or two and wrong for a year of them — Git is not an image host. Moving
to Supabase Storage changes `--image-prefix` and the copy step, nothing else.

## The idea

Every lot is presented as the manila inspection tag the bench tech filled out, and the tag
carries a three-line **condition ledger**:

| Line | What it says |
|---|---|
| Found | What was wrong when it hit the bench |
| Fixed | What we did about it |
| Still | What we did not get all the way back |

The "still" line is the point. On a damaged-goods auction, publishing the remaining flaw is
what makes the rest of the listing believable.

## Files

- `index.html` — page shell. The hero lot, the open-lot grid, the counts and the
  "what closed" table all render from the engine's data, so the page cannot claim
  a lot is open when it is not. With nothing open the hero says when the next sale is.
- `styles.css` — tokens at the top, lifted from the live hugheslivingco.com Shopify theme
  so the two sites read as one company:

  | Auction token | Value | Store token |
  |---|---|---|
  | `--ground` | `#FBF6EE` | `--color-background` |
  | `--card` | `#FFFFFF` | `--color-base-background` |
  | `--ink` / `--ink-2` | `#000000` / `#545454` | `--color-foreground` / `--color-foreground2` |
  | `--accent` | `#814037` | `--color-accent` |
  | `--flag` | `#FC5732` | `--color-on-sale-badge-background` |
  | `--verdict` | `#3D7A40` | `--color-success-text` (darkened for AA) |
  | buttons | black fill, 3px radius | `--color-button`, `--rounded-button` |
  | cards | 0 radius | `--rounded-product-card` |

  Type is **Albert Sans**, the store's face. DM Mono is kept only for auction machine data —
  lot numbers, prices, and countdowns, where digits need to hold their width.

  Two store values were darkened to clear WCAG AA at small sizes: muted text `#868686` → `#707070`
  and success green `#428445` → `#3D7A40`. The sale red `#FC5732` is used as a fill only; small
  red text uses `#C93C19`.
- `app.js` — the lot list: grid, filters, clocks, the bid sheet
- `lot.html` / `lot.js` — one lot at its own address, with the photo gallery,
  dimensions and the condition ledger. This is the page you send someone.
- `paddle.html` / `paddle.js` — where a bidder stands: lots in play, outbid first,
  their own maximum, and the settlement clock on anything they have won
- `staff.html` / `staff.js` — the office view. What closed, who won, what to
  collect, whose window runs out tonight. Hidden from bidders and refused by the
  database, not just by the page.
- `terms.html` / `privacy.html` — what a bidder agrees to, and what is kept
- `auth.js` — sign in, register, change and reset a password. Injects its own
  dialogs so all six pages share one, rather than six copies drifting apart.
- `api.js` — the seam. Three interchangeable backends (`demo`, `local`,
  `supabase`); the pages never decide an auction question themselves.
- `tools/import-lots.mjs` — the bulk importer. CSV in, validated lots out.
- `tools/images-to-storage.mjs` — moves photos out of git into Supabase Storage
- `img/` — lot photos. Being migrated to Storage; git is not an image host.

## The migrations, in order

Each one is a published rule or a piece of state, and every rule the site
prints lives in SQL rather than in the page.

| | |
|---|---|
| `0001_auction_core` | tables, increments, proxy resolution, the two-minute rule, RLS |
| `0002_realtime_and_close` | realtime publication, the closing sweeper |
| `0003_auth_bridge` | issues a paddle on signup, `server_now()` |
| `0004_hardening` | revokes the default grants Supabase hands out |
| `0005_lot_import` | `import_key`, auto lot numbers, the Found/Fixed/Still constraint |
| `0006_staff_view` | `is_staff`, the office view, gated in the database |
| `0007_rules_hardening` | reserves actually enforced, `sold` as a public column |
| `0008_lot_detail` | photo galleries, dimensions, attributes, account watchlist |
| `0009_sales_tax` | the published rate, itemised |
| `0010_settlement` | the four-day window, declining, and relisting |
| `0011_office_settlement` | the settlement clock on the office screen |

Changing a rate or a window is a migration on purpose: the number that applied
to a sale is something you may have to justify later, and a value editable in a
dashboard leaves no record of when it changed.

## What the engine does

- Per-lot countdowns; the clock turns red inside the final hour and reads `Closed` at zero
- Proxy bidding — you enter a maximum, the lot advances only to the next increment
- Published increments: $5 under $50, $10 to $249, $25 to $999, $50 above
- **Two-minute rule** — a bid inside the final two minutes pushes the close out two minutes
- Buy-it-now, removed from a lot as soon as it takes a bid
- Bench protection priced at 6% of the bid, $8 minimum, computed live in the bid sheet
- Watchlist and paddle number persist in `localStorage`

## Before this goes live

The engine is real and hosted: bids are recorded, prices are derived server-side,
and the clock is the server's. The line that used to be here — "bids run in the
page, there is no server" — has been wrong since the Supabase project went up.

What genuinely stands between this and a first sale:

**Needs a person, not code**

- `LEGAL_ENTITY` in the footer of every page, and in `terms.html`. The sales tax
  permit is issued to a personal name with the business name "Hughes Furniture",
  which is neither name the site trades under.
- `CONTACT_EMAIL` — `auctions@hugheslivingco.com` does not exist yet.
- Pickup address and hours. Nowhere on the site.
- Bench protection terms. 6% of the hammer, $8 minimum, ninety days is invented
  text, and Texas may treat a paid coverage plan as a service contract with its
  own registration requirements.
- A lawyer over `terms.html` and `privacy.html`. Both are drafts that describe
  the real system accurately; neither has been reviewed.
- Photographs of the flaws. Every lot page still says the flaw is not pictured,
  because it is not. The gallery is built and waiting.

**Needs building**

- SMTP. Supabase's built-in sender allows two emails an hour and the limit is
  locked. Without it there is no registration confirmation, no password
  recovery, and no way to tell a winner their four-day window has started.
- Outbid and settlement notifications. Not auth emails, so SMTP alone does not
  provide them — they need a trigger and an Edge Function.
- Payments. A winner who cannot be charged is not a sale.

**Known and deliberate**

- Nothing prevents the seller bidding on their own lots. No technical control
  exists, and `lot_events` would record it plainly. Worth a rule before anyone
  else has an account.
- Relisted lots reopen for 72 hours by default. That number is a guess, and the
  real answer probably depends on whether forfeited stock should join the next
  scheduled sale instead.
