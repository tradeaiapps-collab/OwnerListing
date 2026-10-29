-- Account deletion with a recovery window (super admin only, enforced in the app). Soft delete: nothing is removed.
--   deleted_at      when the account was deleted. NULL means a live account; queries for live accounts check deleted_at IS NULL.
--   restore_until   end of the recovery window, fixed at deletion (deleted_at + the window in force then).
--   deactivated_at  when the recovery window closed without a restore. From then on the account cannot be restored.
--   retain_until    end of the record-keeping period (deleted_at + 7 years). Offers, invoices and audit history are kept until then.
--   personal_data_purged_at  when the account's name, email and Google link were cleared after retain_until.
--   restored_at     the latest restore. Sessions issued before it stay refused, so a restore never revives an old sign-in.
-- Existing accounts are all live, so every new column starts NULL for them.
ALTER TABLE app_user
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deactivated_at TIMESTAMPTZ,
  ADD COLUMN restore_until TIMESTAMPTZ,
  ADD COLUMN retain_until TIMESTAMPTZ,
  ADD COLUMN status_before_delete TEXT CHECK (status_before_delete IN ('pending', 'active', 'suspended')),
  ADD COLUMN personal_data_purged_at TIMESTAMPTZ,
  ADD COLUMN restored_at TIMESTAMPTZ;

-- A deleted account is always closed (so every session and sign-in is refused) and carries its windows; the steps happen in order.
ALTER TABLE app_user ADD CONSTRAINT app_user_deletion_shape CHECK (
  (deleted_at IS NULL AND restore_until IS NULL AND retain_until IS NULL AND status_before_delete IS NULL
     AND deactivated_at IS NULL AND personal_data_purged_at IS NULL)
  OR (deleted_at IS NOT NULL AND status = 'closed' AND restore_until > deleted_at AND retain_until > restore_until
     AND status_before_delete IS NOT NULL
     AND (deactivated_at IS NULL OR deactivated_at >= deleted_at)
     AND (personal_data_purged_at IS NULL OR deactivated_at IS NOT NULL))
);

CREATE INDEX app_user_deleted_idx ON app_user(deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;

-- Listings of a deleted account are archived: hidden everywhere, kept as records, and brought back if the account is restored.
ALTER TABLE property_listing DROP CONSTRAINT property_listing_status_check;
ALTER TABLE property_listing ADD CONSTRAINT property_listing_status_check
  CHECK (status IN ('draft', 'pending_review', 'published', 'suspended', 'withdrawn', 'archived'));
