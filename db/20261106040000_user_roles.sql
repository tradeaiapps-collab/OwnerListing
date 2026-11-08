-- Multi-role accounts: one account can hold several roles and switch between them.
-- user_type stays the primary role chosen at signup (and what permissions fall back to); roles lists every activated role,
-- active_role is the one last switched to. Roles are only ever added through the activate route, never from a client claim.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS active_role TEXT;

UPDATE app_user SET roles = ARRAY[user_type] WHERE user_type IN ('owner','agent','buyer') AND cardinality(roles) = 0;
UPDATE app_user SET roles = ARRAY['buyer','investor'] WHERE user_type = 'investor' AND cardinality(roles) = 0;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_roles_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_roles_check CHECK (roles <@ ARRAY['buyer','owner','agent','investor']::TEXT[]);
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_active_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_active_role_check CHECK (active_role IS NULL OR active_role IN ('buyer','owner','agent','investor'));
