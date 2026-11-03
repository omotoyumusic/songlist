-- Share only the number of valid singing records, never their dates or details.
begin;
create or replace function public.songlist_valid_history_date(value text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  return to_char(value::date, 'YYYY-MM-DD') = value;
exception when others then return false;
end;
$$;
revoke all on function public.songlist_valid_history_date(text) from public, anon, authenticated;

create or replace function public.songlist_public_songs(p_songs jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s->'id', 'artist', s->'artist', 'artistKana', s->'artistKana',
    'title', s->'title', 'songKana', s->'songKana',
    'artistSortIndex', s->'artistSortIndex', 'titleSortIndex', s->'titleSortIndex',
    'key', s->'key', 'transpose', s->'transpose', 'lastSung', s->'lastSung', 'visible', true,
    'singingCount', case
      when jsonb_typeof(s #> '{extra,practice,history}') = 'array' then (
        select count(distinct record->>'id')
        from jsonb_array_elements(s #> '{extra,practice,history}') as records(record)
        where coalesce(record->>'id', '') <> ''
          and public.songlist_valid_history_date(record->>'date')
      )
      when public.songlist_valid_history_date(s->>'lastSung') then 1
      else 0 end
  ) order by n), '[]'::jsonb)
  from jsonb_array_elements(p_songs) with ordinality as x(s,n)
  where coalesce(s->'visible', 'true'::jsonb) <> 'false'::jsonb;
$$;
revoke all on function public.songlist_public_songs(jsonb) from public, anon, authenticated;
commit;
