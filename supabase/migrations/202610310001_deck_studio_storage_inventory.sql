create function public.deck_studio_storage_inventory(prefix text default '', after_path text default '', page_size integer default 1000)
returns table(pathname text, size bigint, "uploadedAt" timestamptz)
language sql stable security invoker set search_path = '' as $$
  select name, coalesce((metadata->>'size')::bigint, 0), coalesce((user_metadata->>'migrated_uploaded_at')::timestamptz, created_at)
  from storage.objects
  where bucket_id = 'deck-studio' and starts_with(name, prefix) and name > after_path and coalesce(is_delete_marker, false) = false
  order by name limit greatest(1, least(page_size, 1000));
$$;
revoke all on function public.deck_studio_storage_inventory(text, text, integer) from public, anon, authenticated;
grant execute on function public.deck_studio_storage_inventory(text, text, integer) to service_role;
