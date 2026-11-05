export const STATUS_LABEL: Record<string, string> = { draft: "Draft", out_for_signature: "Out for signature", completed: "Signed by everyone", declined: "Declined", cancelled: "Cancelled" };
export const EVENT_LABEL: Record<string, string> = {
  created: "Document created", sent: "Sent for signature", viewed: "Opened the document", explained: "Asked for an explanation", signed: "Signed",
  declined: "Declined to sign", completed: "Everyone has signed", cancelled: "Cancelled",
  owner_viewed: "Owner viewed the document", sign_failed: "Signing attempt refused"
};
