-- Optional, non-destructive migration.
-- The application detects missing columns at runtime, so it keeps working
-- without this migration (licenses without expires_at are treated as Lifetime).
--
-- Run this manually in the Supabase SQL editor only if you need expiration
-- dates and last-used tracking. It only adds columns; it never drops or
-- recreates tables and never modifies existing rows.

alter table public.licenses
    add column if not exists expires_at timestamptz,
    add column if not exists last_used_at timestamptz;

comment on column public.licenses.expires_at is
    'Expiration instant (UTC). NULL means the license never expires (Lifetime).';

comment on column public.licenses.last_used_at is
    'Timestamp of the last successful verification (UTC).';
