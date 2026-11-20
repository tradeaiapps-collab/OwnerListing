import { formatJobNo } from "../domain/contractor-market";
import type { JobNotify } from "../domain/job-board";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

/** Notifications for a job. The job number is in every title (so in every email subject) and the link opens the job. Never throws. */
export function makeJobNotify(db: Queryable): JobNotify {
  return async (to, kind, job, extra = {}) => {
    try {
      const toContractor = to === job.contractorUserId;
      await notifyUser(db, to, kind, { listing: job.address, name: toContractor ? job.ownerName : job.contractorName, job: formatJobNo(job.jobNumber), link: `/jobs/${job.id}`, ...extra });
    } catch { /* a notification never blocks the action */ }
  };
}
