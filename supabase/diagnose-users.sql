-- Who exists, and did each one get a profile?
--
-- An auth user with a null role has no profile row: the account exists, but
-- it cannot be listed in BookBin and is signed straight back out on login.
-- That is the state to look for if a newly created user never appears.
select
  u.email,
  u.created_at,
  u.last_sign_in_at,
  p.role,
  case when p.id is null then 'NO PROFILE - cannot use BookBin' else 'ok' end as status
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at;
