import { JobsList } from "../../jobs/jobs-list";

export const metadata = { title: "Your jobs" };

export default function Page() {
  return <JobsList focus="contractor" />;
}
