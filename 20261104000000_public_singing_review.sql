-- Share monthly counts for visible songs, not individual history entries.
begin;
create or replace function public.songlist_public_months(song jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with valid_records as (
    select distinct on (record->>'id') record->>'id' as id, left(record->>'date',7) as month
    from jsonb_array_elements(case when jsonb_typeof(song #> '{extra,practice,history}') = 'array' then song #> '{extra,practice,history}' else '[]'::jsonb end) with ordinality as r(record,n)
    where coalesce(record->>'id','') <> '' and public.songlist_valid_history_date(record->>'date')
    order by record->>'id', n
  ), recorded as (
    select month from valid_records
    union all
    select left(song->>'lastSung',7)
    where jsonb_typeof(song #> '{extra,practice,history}') is distinct from 'array'
      and public.songlist_valid_history_date(song->>'lastSung')
  ), totals as (select month, count(*) as amount from recorded group by month)
  select coalesce(jsonb_object_agg(month,amount),'{}'::jsonb) from totals;
$$;
revoke all on function public.songlist_public_months(jsonb) from public, anon, authenticated;
create or replace function public.songlist_public_songs(p_songs jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s->'id', 'artist', s->'artist', 'artistKana', s->'artistKana',
    'title', s->'title', 'songKana', s->'songKana',
    'artistSortIndex', s->'artistSortIndex', 'titleSortIndex', s->'titleSortIndex',
    'key', s->'key', 'transpose', s->'transpose', 'lastSung', s->'lastSung', 'visible', true,
    'singingMonths', public.songlist_public_months(s),
    'singingCount', case
      when jsonb_typeof(s #> '{extra,practice,history}') = 'array' then (
        select count(distinct record->>'id')
        from jsonb_array_elements(s #> '{extra,practice,history}') as records(record)
        where coalesce(record->>'id', '') <> '' and public.songlist_valid_history_date(record->>'date')
      )
      when public.songlist_valid_history_date(s->>'lastSung') then 1 else 0 end
  ) order by n), '[]'::jsonb)
  from jsonb_array_elements(p_songs) with ordinality as x(s,n)
  where coalesce(s->'visible', 'true'::jsonb) <> 'false'::jsonb;
$$;
revoke all on function public.songlist_public_songs(jsonb) from public, anon, authenticated;
commit;
