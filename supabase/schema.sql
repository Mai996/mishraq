-- قاعدة بيانات مِشراق على Supabase. يُنفذ مرة واحدة من SQL Editor.
create extension if not exists postgis with schema extensions;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'مشروعي',
  data jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner_idx on public.projects (owner, updated_at desc);

-- القاعدة المكانية: نسخة قابلة للاستعلام من نتائج كل مبنى
create table if not exists public.buildings (
  project_id uuid not null references public.projects (id) on delete cascade,
  id text not null,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text,
  area_name text,
  neighborhood text,
  wilaya text,
  governorate text,
  source text,
  confidence text,
  footprint_m2 double precision,
  roof_m2 double precision,
  usable_m2 double precision,
  panels integer,
  kwp double precision,
  annual_kwh double precision,
  geom extensions.geometry(Geometry, 4326) not null,
  primary key (project_id, id)
);
create index if not exists buildings_geom_idx on public.buildings using gist (geom);
create index if not exists buildings_admin_idx on public.buildings (governorate, wilaya);

alter table public.projects enable row level security;
alter table public.buildings enable row level security;

drop policy if exists projects_own on public.projects;
create policy projects_own on public.projects for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists buildings_own on public.buildings;
create policy buildings_own on public.buildings for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

-- حفظ المشروع ومبانيه في معاملة واحدة، مع رفض الكتابة فوق نسخة أحدث
create or replace function public.save_project(
  p_id uuid,
  p_name text,
  p_data jsonb,
  p_buildings jsonb,
  p_expected_version integer
) returns table (id uuid, version integer)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_id uuid := p_id;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if v_id is null then
    insert into public.projects as p (name, data)
    values (p_name, p_data)
    returning p.id, p.version into v_id, v_version;
  else
    update public.projects as p
    set name = p_name, data = p_data, version = p.version + 1, updated_at = now()
    where p.id = v_id and p.version = p_expected_version
    returning p.version into v_version;
    if v_version is null then
      raise exception 'version_conflict';
    end if;
  end if;

  delete from public.buildings as b where b.project_id = v_id;
  insert into public.buildings (
    project_id, id, name, area_name, neighborhood, wilaya, governorate, source, confidence,
    footprint_m2, roof_m2, usable_m2, panels, kwp, annual_kwh, geom
  )
  select
    v_id, r.id, r.name, r.area_name, r.neighborhood, r.wilaya, r.governorate, r.source, r.confidence,
    r.footprint_m2, r.roof_m2, r.usable_m2, r.panels, r.kwp, r.annual_kwh,
    st_setsrid(st_geomfromgeojson(r.geom), 4326)
  from jsonb_to_recordset(p_buildings) as r (
    id text, name text, area_name text, neighborhood text, wilaya text, governorate text,
    source text, confidence text, footprint_m2 double precision, roof_m2 double precision,
    usable_m2 double precision, panels integer, kwp double precision, annual_kwh double precision,
    geom text
  );

  return query select v_id, v_version;
end;
$$;

revoke all on function public.save_project(uuid, text, jsonb, jsonb, integer) from public, anon;
grant execute on function public.save_project(uuid, text, jsonb, jsonb, integer) to authenticated;
