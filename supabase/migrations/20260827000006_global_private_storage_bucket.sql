-- One private bucket for normalized personal photos and, in a later package,
-- paid print artifacts. The backend secret key is the only Storage principal;
-- browsers receive short-lived signed object URLs.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'wolkenworte-private',
  'wolkenworte-private',
  false,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
