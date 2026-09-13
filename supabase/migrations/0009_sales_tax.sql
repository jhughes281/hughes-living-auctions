-- Hughes Living Auctions — sales tax, published like every other rule
--
-- Furniture is taxable in Texas and every lot is collected in Houston, so tax
-- is part of what a bidder pays. The site said "Buyer premium: None" and
-- mentioned tax nowhere, which reads as "the hammer is what you pay". It is
-- not, and finding that out at the counter is the kind of surprise this whole
-- design exists to avoid.
--
-- Rate lives here rather than in the page for the same reason increments and
-- protection do: one place, server-side, and the browser only ever displays
-- what it is told.

-- ---------------------------------------------------------------- the rate
-- Basis points, so 825 = 8.25%. Houston is the state 6.25% plus 2.00% local.
-- CHANGING THE RATE IS A MIGRATION, deliberately: the rate that applied to a
-- sale is a thing you may have to justify later, and a value someone can edit
-- in a dashboard leaves no record of when it changed.
create or replace function sales_tax_bps()
returns integer language sql immutable parallel safe as $$
  select 825
$$;

comment on function sales_tax_bps is
  'Combined state + local rate in basis points for the pickup location. Houston: 6.25 state + 2.00 local = 825.';

-- Rounded half-up to the cent, which is what a register does.
create or replace function tax_cents(amount_cents integer)
returns integer language sql immutable parallel safe as $$
  select floor((amount_cents::numeric * sales_tax_bps() / 10000) + 0.5)::integer
$$;

-- ---------------------------------------------------------------- the total
-- What a winner actually owes, itemised. Protection is deliberately NOT taxed
-- here: whether a service contract is taxable in Texas is a question for an
-- accountant, and quietly charging tax on it would be worse than leaving it
-- out and saying so. The invoice at settlement is the authority; this is an
-- estimate shown before bidding so nobody is surprised.
create or replace function lot_total_cents(
  p_hammer_cents integer,
  p_protection   boolean default false
)
returns table (
  hammer_cents     integer,
  protection_cents integer,
  tax_cents        integer,
  total_cents      integer
)
language sql immutable parallel safe as $$
  select p_hammer_cents,
         case when p_protection then protection_cents(p_hammer_cents) else 0 end,
         tax_cents(p_hammer_cents),
         p_hammer_cents
           + case when p_protection then protection_cents(p_hammer_cents) else 0 end
           + tax_cents(p_hammer_cents)
$$;

-- ---------------------------------------------------------------- exposure
-- Public: a bidder has to be able to work out the real cost before bidding,
-- and anon browses lots without signing in.
revoke execute on function sales_tax_bps()                  from public;
revoke execute on function tax_cents(integer)               from public;
revoke execute on function lot_total_cents(integer, boolean) from public;

grant execute on function sales_tax_bps()                   to anon, authenticated;
grant execute on function tax_cents(integer)                to anon, authenticated;
grant execute on function lot_total_cents(integer, boolean) to anon, authenticated;

-- ---------------------------------------------------------------- verify
do $$
declare
  t record;
begin
  -- $260 sectional, protection taken: 6% is $15.60, tax 8.25% of the hammer
  select * into t from lot_total_cents(26000, true);
  if t.tax_cents <> 2145 then
    raise exception 'tax on $260 should be $21.45, got %', t.tax_cents / 100.0;
  end if;
  if t.total_cents <> 26000 + 1560 + 2145 then
    raise exception 'total does not add up: %', t.total_cents;
  end if;

  -- rounding: $1 at 8.25% is 8.25c, which must land on 8c, not 9c
  if tax_cents(100) <> 8 then
    raise exception 'tax on $1 should be 8c, got %', tax_cents(100);
  end if;

  raise notice 'sales tax: 8.25%% published, itemised, protection left untaxed';
end $$;
