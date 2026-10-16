-- Preserve existing lists and share URLs. New clients use revision-checked writes.
begin;
create temporary table songlist_upgrade_check on commit drop as
select l.user_id, md5((select jsonb_agg(item-'artistSortIndex'-'titleSortIndex' order by n)::text from jsonb_array_elements(l.songs) with ordinality x(item,n))) as content_hash
from public.song_lists l;
alter table public.song_lists add column if not exists revision bigint not null default 0;
alter table public.public_song_list_shares add column if not exists enabled boolean not null default true;

create or replace function public.songlist_public_songs(p_songs jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s->'id', 'artist', s->'artist', 'artistKana', s->'artistKana',
    'title', s->'title', 'songKana', s->'songKana',
    'artistSortIndex', s->'artistSortIndex', 'titleSortIndex', s->'titleSortIndex',
    'key', s->'key', 'transpose', s->'transpose', 'lastSung', s->'lastSung', 'visible', true
  ) order by n), '[]'::jsonb)
  from jsonb_array_elements(p_songs) with ordinality as x(s,n)
  where coalesce(s->'visible', 'true'::jsonb) <> 'false'::jsonb;
$$;
revoke all on function public.songlist_public_songs(jsonb) from public, anon, authenticated;

create or replace function public.get_my_song_list()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); result jsonb;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select jsonb_build_object('songs', l.songs, 'revision', l.revision,
    'share', (select jsonb_build_object('share_id', s.share_id, 'enabled', s.enabled, 'display_name', s.display_name)
      from public.public_song_list_shares s where s.user_id=u)) into result
  from public.song_lists l where l.user_id=u;
  return coalesce(result, jsonb_build_object('songs','[]'::jsonb,'revision',0,'share',null));
end;
$$;

create or replace function public.save_my_song_list(p_songs jsonb, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); current_row public.song_lists%rowtype;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_expected_revision is null or p_expected_revision<0 or jsonb_typeof(p_songs) is distinct from 'array'
    or jsonb_array_length(p_songs)>20000 or pg_column_size(p_songs)>10000000 then
    raise exception 'Invalid song list' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_songs) s where jsonb_typeof(s) is distinct from 'object'
    or coalesce(s->>'id','')='' or coalesce(s->>'artist','')='' or coalesce(s->>'title','')='')
    or (select count(*) from jsonb_array_elements(p_songs))<>(select count(distinct s->>'id') from jsonb_array_elements(p_songs) s) then
    raise exception 'Invalid or duplicate song identifiers' using errcode='22023';
  end if;
  insert into public.song_lists(user_id,songs) values(u,'[]'::jsonb) on conflict(user_id) do nothing;
  select * into current_row from public.song_lists where user_id=u for update;
  if current_row.revision<>p_expected_revision then
    return jsonb_build_object('ok',false,'revision',current_row.revision,'songs',current_row.songs);
  end if;
  update public.song_lists set songs=p_songs, revision=revision+1 where user_id=u returning * into current_row;
  return jsonb_build_object('ok',true,'revision',current_row.revision);
end;
$$;

create or replace function public.manage_my_song_share(p_action text, p_display_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); current_share public.public_song_list_shares%rowtype;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_action not in ('enable','stop','rotate','rename') then raise exception 'Invalid action' using errcode='22023'; end if;
  if p_action<>'stop' and (p_display_name is null or length(trim(p_display_name)) not between 1 and 60) then
    raise exception 'Display name required' using errcode='22023';
  end if;
  -- Serialize sharing changes with saves, including the first creation.
  insert into public.song_lists(user_id,songs) values(u,'[]'::jsonb) on conflict(user_id) do nothing;
  perform 1 from public.song_lists where user_id=u for update;
  if p_action in ('enable','rotate') then
    insert into public.public_song_list_shares(user_id,display_name,songs,enabled)
      values(u,trim(p_display_name),'[]'::jsonb,true) on conflict(user_id) do nothing;
  end if;
  update public.public_song_list_shares set
    enabled=case when p_action='stop' then false when p_action='enable' then true else enabled end,
    share_id=case when p_action='rotate' then gen_random_uuid() else share_id end,
    display_name=case when p_action='stop' then display_name else trim(p_display_name) end,
    updated_at=now()
    where user_id=u returning * into current_share;
  if not found then return null; end if;
  return jsonb_build_object('share_id',current_share.share_id,'enabled',current_share.enabled,'display_name',current_share.display_name);
end;
$$;

create or replace function public.get_public_song_list(p_share_id uuid)
returns table (share_id uuid, display_name text, songs jsonb)
language sql stable security definer set search_path = '' as $$
  select s.share_id,s.display_name,public.songlist_public_songs(l.songs)
  from public.public_song_list_shares s join public.song_lists l on l.user_id=s.user_id
  where s.share_id=p_share_id and s.enabled limit 1;
$$;

-- Preserve ordering metadata from each existing viewer snapshot on first migration.
update public.song_lists l set songs=(
  select coalesce(jsonb_agg(item || coalesce((select jsonb_strip_nulls(jsonb_build_object(
    'artistSortIndex', legacy->'artistSortIndex', 'titleSortIndex', legacy->'titleSortIndex'))
    from public.public_song_list_shares sh cross join lateral jsonb_array_elements(sh.songs) legacy
    where sh.user_id=l.user_id and legacy->>'id'=item->>'id' limit 1), '{}'::jsonb) order by n),'[]'::jsonb)
  from jsonb_array_elements(l.songs) with ordinality as x(item,n)
);

-- Existing snapshots are no longer served. Private notes never enter the public projection.
-- Stop old clients from bypassing revision checks; they must reload the updated app.
revoke insert, update, delete on public.song_lists from authenticated;
revoke insert, update, delete on public.public_song_list_shares from authenticated;
revoke all on function public.get_my_song_list() from public, anon;
revoke all on function public.save_my_song_list(jsonb,bigint) from public, anon;
revoke all on function public.manage_my_song_share(text,text) from public, anon;
grant execute on function public.get_my_song_list() to authenticated;
grant execute on function public.save_my_song_list(jsonb,bigint) to authenticated;
grant execute on function public.manage_my_song_share(text,text) to authenticated;
revoke all on function public.get_public_song_list(uuid) from public;
grant execute on function public.get_public_song_list(uuid) to anon,authenticated;
do $$ begin
  if exists (
    select 1 from songlist_upgrade_check c full join
      (select l.user_id, md5((select jsonb_agg(item-'artistSortIndex'-'titleSortIndex' order by n)::text
        from jsonb_array_elements(l.songs) with ordinality x(item,n))) as content_hash from public.song_lists l) a
    on a.user_id=c.user_id where a.user_id is null or c.user_id is null or a.content_hash is distinct from c.content_hash
  ) then raise exception 'Migration stopped: song content changed'; end if;
end $$;
commit;
select 'Safe save and sharing update applied' as status, count(*) as lists,
  coalesce(sum(jsonb_array_length(songs)),0) as songs from public.song_lists;
