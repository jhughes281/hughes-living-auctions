-- LOCAL DEVELOPMENT ONLY, part 1 of 2. Runs BEFORE the core migration.
-- Never runs against Supabase.
--
-- Supabase supplies auth.users, auth.uid() and Realtime. Plain Postgres does
-- not, so this file fakes exactly those three things and nothing else. The
-- production migrations in supabase/ are untouched by it.

-- ---------------------------------------------------------------- auth shim
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);

-- The server sets test.uid transaction-locally before every RPC, so a pooled
-- connection can never carry one bidder's identity into another's request.
create or replace function auth.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;

