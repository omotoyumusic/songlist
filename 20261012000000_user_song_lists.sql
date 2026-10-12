create table if not exists public.song_lists (
  user_id uuid primary key references auth.users (id) on delete cascade,
  songs jsonb not null default '[]'::jsonb check (jsonb_typeof(songs) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.song_lists enable row level security;
revoke all on table public.song_lists from anon, public;
grant select, insert, update, delete on table public.song_lists to authenticated;

drop policy if exists "Users can read their own song list" on public.song_lists;
create policy "Users can read their own song list"
  on public.song_lists for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own song list" on public.song_lists;
create policy "Users can create their own song list"
  on public.song_lists for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own song list" on public.song_lists;
create policy "Users can update their own song list"
  on public.song_lists for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own song list" on public.song_lists;
create policy "Users can delete their own song list"
  on public.song_lists for delete to authenticated
  using (auth.uid() = user_id);

create or replace function public.song_lists_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists song_lists_updated_at on public.song_lists;
create trigger song_lists_updated_at
  before update on public.song_lists
  for each row execute function public.song_lists_set_updated_at();
