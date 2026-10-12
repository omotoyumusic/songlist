create table if not exists public.public_song_list_shares (
  user_id uuid primary key references auth.users (id) on delete cascade,
  share_id uuid not null unique default gen_random_uuid(),
  display_name text not null default 'ユーザー',
  songs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.public_song_list_shares enable row level security;
revoke all on table public.public_song_list_shares from anon, public;
grant select, insert, update, delete on table public.public_song_list_shares to authenticated;

drop policy if exists "Users can read their own shared song list" on public.public_song_list_shares;
create policy "Users can read their own shared song list"
  on public.public_song_list_shares for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own shared song list" on public.public_song_list_shares;
create policy "Users can create their own shared song list"
  on public.public_song_list_shares for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own shared song list" on public.public_song_list_shares;
create policy "Users can update their own shared song list"
  on public.public_song_list_shares for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own shared song list" on public.public_song_list_shares;
create policy "Users can delete their own shared song list"
  on public.public_song_list_shares for delete to authenticated
  using (auth.uid() = user_id);

create or replace function public.get_public_song_list(p_share_id uuid)
returns table (share_id uuid, display_name text, songs jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select s.share_id, s.display_name, s.songs
  from public.public_song_list_shares as s
  where s.share_id = p_share_id
  limit 1;
$$;

revoke all on function public.get_public_song_list(uuid) from public;
grant execute on function public.get_public_song_list(uuid) to anon, authenticated;
