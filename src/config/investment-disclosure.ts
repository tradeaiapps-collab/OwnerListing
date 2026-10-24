/**
 * General-risk disclaimer shown on every investor-facing page. PLACEHOLDER wording: counsel must replace it
 * (docs/COUNSEL_QUESTIONS.md section 9). Changing the text needs a new version: investors then re-acknowledge,
 * and an admin must re-confirm counsel approval before the module can be switched on with it.
 */
export const INVESTMENT_DISCLOSURE = {
  version: "2026-10-25-draft-1",
  counselApproved: false,
  title: "General risk warning",
  text:
    "This is not financial advice and not an offer of securities or any other financial product. " +
    "The platform does not hold funds, does not accept investments and does not arrange, recommend or decide on any investment. " +
    "Projects are posted by their owners and are indicative only. Any agreement is made between the parties off-platform, " +
    "through their own solicitors and advisers. Property projects can lose some or all of the money put into them. " +
    "Get independent legal, tax and financial advice before deciding anything."
} as const;
