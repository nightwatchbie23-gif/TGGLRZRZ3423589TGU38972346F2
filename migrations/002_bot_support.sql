-- Optional, non-destructive migration for the LicenseManagerTGG Discord bot.
-- The application detects missing columns/tables at runtime and keeps working
-- without them. Run manually in the Supabase SQL editor.
--
-- - Adds optional license association columns (never touches existing rows).
-- - Creates supporting tables for HWID bans, bot events, audit logs,
--   license-sharing alerts and bot settings.

alter table public.licenses
    add column if not exists discord_user_id text,
    add column if not exists minecraft_username text,
    add column if not exists mc_uuid text;

create table if not exists public.hwid_bans (
    id bigint generated always as identity primary key,
    hwid text not null,
    reason text not null,
    banned_by text,
    license_key text,
    active boolean not null default true,
    created_at timestamptz not null default now()
);

create index if not exists hwid_bans_hwid_active_idx
    on public.hwid_bans (hwid, active);

create table if not exists public.bot_events (
    id bigint generated always as identity primary key,
    event_type text not null,
    payload jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
    id bigint generated always as identity primary key,
    event_type text not null,
    actor text,
    target text,
    reason text,
    details jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.sharing_alerts (
    id bigint generated always as identity primary key,
    license_key text not null,
    alert_kind text not null,
    status text not null default 'open',
    details jsonb,
    decided_by text,
    decided_at timestamptz,
    created_at timestamptz not null default now()
);

create table if not exists public.bot_settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
);

comment on table public.hwid_bans is
    'HWID device bans. Separate from license disable/revoke. active=false rows are kept as history.';
comment on table public.bot_events is
    'Event bus written by the backend (login attempts etc.), consumed by the Discord bot.';
comment on table public.sharing_alerts is
    'License-sharing alerts with administrator decisions. Never auto-bans.';
