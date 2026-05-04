-- Extensions required by the schema.
-- pgcrypto: column-level encryption (pgp_sym_encrypt/decrypt + armor/dearmor).
-- citext: case-insensitive email comparisons.
-- uuid-ossp: not strictly needed (gen_random_uuid is in pgcrypto), but harmless.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext   with schema extensions;
