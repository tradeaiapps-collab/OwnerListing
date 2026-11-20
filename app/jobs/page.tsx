import { JobsList } from "./jobs-list";

export const metadata = { title: "Jobs" };

export default function Page() {
  return <JobsList focus="all" />;
}
