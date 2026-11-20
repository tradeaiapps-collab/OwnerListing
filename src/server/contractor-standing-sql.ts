/** SQL fragment: true when the contractor in `col` is NOT suspended by staff. Used wherever a contractor would get or act on a job. */
export const notSuspendedSql = (col: string) => `NOT EXISTS (SELECT 1 FROM contractor_standing cs WHERE cs.user_id = ${col} AND cs.suspended)`;

/** SQL fragment: the contractor in `col` is staff-verified and their insurance (and licence, if given) is still in date today. */
export const verifiedInDateSql = (col: string) =>
  `EXISTS (SELECT 1 FROM contractor_verification cv WHERE cv.user_id = ${col} AND cv.status = 'verified' AND cv.insurance_expiry >= current_date AND (cv.licence_expiry IS NULL OR cv.licence_expiry >= current_date))`;
