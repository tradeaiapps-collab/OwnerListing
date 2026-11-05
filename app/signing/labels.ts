export const STATUS_LABEL: Record<string, string> = { draft: "Draft", out_for_signature: "Out for signature", completed: "Signed by everyone", declined: "Declined", cancelled: "Cancelled" };
export const EVENT_LABEL: Record<string, string> = {
  created: "Document created", sent: "Sent for signature", viewed: "Opened the document", explained: "Asked for an explanation", signed: "Signed",
  declined: "Declined to sign", completed: "Everyone has signed", cancelled: "Cancelled", voided: "Cancelled in DocuSign", retried: "Sent again as a new document", stored: "Signed copy saved",
  owner_viewed: "Owner viewed the document", sign_failed: "Signing attempt refused"
};
/** Offered when naming a signer; any role of 2 to 60 characters is accepted. */
export const ROLE_SUGGESTIONS = ["Buyer", "Seller", "Agent", "Inspector"] as const;
