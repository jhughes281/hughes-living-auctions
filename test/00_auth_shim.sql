-- LOCAL ONLY. Runs BEFORE the core migration, for both the test suite and
-- the dev server. There is deliberately ONE copy of this file: two copies
-- drifted apart once already and the suite broke on the difference.
-- Never runs against Supabase.
--
-- Supabase supplies auth.users, auth.uid() and Realtime. Plain Postgres does
-- not, so this file fakes exactly those three things and nothing else. The
-- production migrations in supabase/ are untouched by it.

-- ---------------------------------------------------------------- refuse to run on Supabase
-- This file replaces auth.uid() with a value read from a session setting.
-- On a real Supabase project that would be a total authentication bypass:
-- identity would become something the connection asserts rather than something
-- a signed token proves. Refuse rather than trust the operator to notice.
do $$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator', 'supabase_auth_admin')) then
    raise exception
      'local_1_auth.sql is for plain Postgres only. This looks like a Supabase database, where running it would replace real authentication with a client-settable variable.';
  end if;
end $$;

-- ---------------------------------------------------------------- auth shim
create schema if not exists auth;
-- Shaped like Supabase's auth.users in the columns our migrations touch, so
-- 0003 can be tested here rather than discovered broken in production.
create table if not exists auth.users (
  id    uuid primary key,
  email text
);

-- The server sets test.uid transaction-locally before every RPC, so a pooled
-- connection can never carry one bidder's identity into another's request.
create or replace function auth.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;

