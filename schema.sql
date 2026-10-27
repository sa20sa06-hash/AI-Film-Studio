-- AI Film Studio — database foundation
-- Run once in Supabase Dashboard > SQL Editor.
-- This script does not delete existing tables or user data.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.site_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  project_type text not null default 'series' check (project_type in ('series','film','short')),
  status text not null default 'planning' check (status in ('planning','production','complete','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '',
  abilities text not null default '',
  continuity_notes text not null default '',
  extracted_text text not null default '',
  reference_storage_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  episode_number integer not null check (episode_number > 0),
  title text not null check (char_length(title) between 1 and 200),
  synopsis text not null default '',
  status text not null default 'planning' check (status in ('planning','production','complete','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, episode_number)
);

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  scene_number integer not null check (scene_number > 0),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  dialogue jsonb not null default '[]'::jsonb,
  continuity_notes text not null default '',
  generation_status text not null default 'not_started' check (generation_status in ('not_started','queued','processing','complete','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (episode_id, scene_number)
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  kind text not null check (kind in ('video','audio','image','document','other')),
  name text not null check (char_length(name) between 1 and 255),
  storage_path text,
  content_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  episode_id uuid references public.episodes(id) on delete set null,
  scene_id uuid references public.scenes(id) on delete set null,
  provider text not null default 'external-free-provider',
  prompt text not null default '',
  status text not null default 'saved_prompt' check (status in ('saved_prompt','queued','processing','complete','failed','cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  result_storage_path text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ui_language text not null default 'ar' check (ui_language in ('ar','en')),
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_updated_idx on public.projects(user_id, updated_at desc);
create index if not exists characters_user_idx on public.characters(user_id, created_at desc);
create index if not exists episodes_project_idx on public.episodes(project_id, episode_number);
create index if not exists scenes_episode_idx on public.scenes(episode_id, scene_number);
create index if not exists media_assets_user_idx on public.media_assets(user_id, created_at desc);
create index if not exists generation_jobs_user_idx on public.generation_jobs(user_id, created_at desc);

-- Keep profile creation tied to Supabase Auth. No user can choose an admin role.
create or replace function public.handle_new_studio_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name',''))
  on conflict (user_id) do nothing;
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_studio_user_created on auth.users;
create trigger on_studio_user_created
after insert on auth.users
for each row execute procedure public.handle_new_studio_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$
declare tbl text;
begin
  foreach tbl in array array['profiles','projects','characters','episodes','scenes','generation_jobs','user_settings'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', tbl);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute procedure public.touch_updated_at()', tbl);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.site_admins enable row level security;
alter table public.projects enable row level security;
alter table public.characters enable row level security;
alter table public.episodes enable row level security;
alter table public.scenes enable row level security;
alter table public.media_assets enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.user_settings enable row level security;

-- Re-runnable policies: drop only policy definitions, never user data.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select to authenticated using (user_id = auth.uid());
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- site_admins intentionally has no authenticated insert/update/delete policies.
-- Add the owner's UUID from the SQL editor only if a future admin-only feature needs it.

drop policy if exists "projects_owner_all" on public.projects;
create policy "projects_owner_all" on public.projects for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "characters_owner_all" on public.characters;
create policy "characters_owner_all" on public.characters for all to authenticated
using (user_id = auth.uid() and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())))
with check (user_id = auth.uid() and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())));

drop policy if exists "episodes_owner_all" on public.episodes;
create policy "episodes_owner_all" on public.episodes for all to authenticated
using (user_id = auth.uid() and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
with check (user_id = auth.uid() and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

drop policy if exists "scenes_owner_all" on public.scenes;
create policy "scenes_owner_all" on public.scenes for all to authenticated
using (user_id = auth.uid() and exists (select 1 from public.episodes e where e.id = episode_id and e.user_id = auth.uid()))
with check (user_id = auth.uid() and exists (select 1 from public.episodes e where e.id = episode_id and e.user_id = auth.uid()));

drop policy if exists "media_assets_owner_all" on public.media_assets;
create policy "media_assets_owner_all" on public.media_assets for all to authenticated
using (user_id = auth.uid() and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())))
with check (user_id = auth.uid() and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())));

drop policy if exists "generation_jobs_owner_all" on public.generation_jobs;
create policy "generation_jobs_owner_all" on public.generation_jobs for all to authenticated
using (user_id = auth.uid() and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())))
with check (user_id = auth.uid() and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())));

drop policy if exists "user_settings_owner_all" on public.user_settings;
create policy "user_settings_owner_all" on public.user_settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private media bucket. Files must be stored inside a folder named with the user's UUID.
insert into storage.buckets (id, name, public)
values ('studio-assets', 'studio-assets', false)
on conflict (id) do update set public = false;

drop policy if exists "studio_assets_read_own" on storage.objects;
create policy "studio_assets_read_own" on storage.objects for select to authenticated
using (bucket_id = 'studio-assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "studio_assets_insert_own" on storage.objects;
create policy "studio_assets_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'studio-assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "studio_assets_update_own" on storage.objects;
create policy "studio_assets_update_own" on storage.objects for update to authenticated
using (bucket_id = 'studio-assets' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'studio-assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "studio_assets_delete_own" on storage.objects;
create policy "studio_assets_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'studio-assets' and (storage.foldername(name))[1] = auth.uid()::text);

-- IMPORTANT:
-- 1) Do not expose service_role keys in the frontend.
-- 2) Keep Supabase project on Free plan and do not enable paid billing.
-- 3) The user interface stores original media in browser storage first; cloud upload is explicit and quota-limited.
