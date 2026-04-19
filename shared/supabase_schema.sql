create extension if not exists pgcrypto;

create table if not exists public.face_references (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  relationship text not null,
  photo_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.geofence_config (
  id int primary key,
  latitude double precision not null,
  longitude double precision not null,
  radius_meters int not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  medication_name text,
  reference_photo_path text,
  reference_photo_bucket text,
  time text not null,
  days text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.reminders add column if not exists medication_name text;
alter table public.reminders add column if not exists reference_photo_path text;
alter table public.reminders add column if not exists reference_photo_bucket text;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.conversations;
