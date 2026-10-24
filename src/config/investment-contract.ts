/**
 * Platform "Investor introduction and fee agreement" template. DRAFT PLACEHOLDER: counsel must write the real wording
 * (docs/COUNSEL_QUESTIONS.md section 9). Served as a plain-text download on investor pages; never contains anyone's details.
 */
export const INVESTMENT_CONTRACT = {
  version: "2026-10-25-draft-1",
  counselApproved: false,
  filename: "investor-introduction-and-fee-agreement-DRAFT.txt",
  title: "Investor introduction and fee agreement (DRAFT)",
  text: [
    "DRAFT - NOT FOR USE - NEEDS COUNSEL REVIEW",
    "",
    "INVESTOR INTRODUCTION AND FEE AGREEMENT",
    "",
    "Parties: the Project Owner (the poster) and the Investor named below. The platform is not a party to any investment.",
    "",
    "1. Introduction. The platform introduced the parties through its project listing service. The platform gives no advice, makes no recommendation and does not arrange the investment.",
    "2. No custody. The platform does not receive, hold or pass on any investment money. Any money moves directly between the parties under their own agreement, through their own solicitors.",
    "3. Platform fee. Where the project was posted under the commission model, the Project Owner agrees to pay the platform the fee shown on the project at posting time, invoiced after this signed agreement is returned. The fee is never deducted from investment money.",
    "4. Communication. Until this agreement is returned, the parties communicate through the platform.",
    "5. Independent advice. Each party confirms it has had the chance to take independent legal, tax and financial advice.",
    "",
    "Project reference: ____________________",
    "Indicative amount: ____________________",
    "Project Owner name and signature: ____________________   Date: __________",
    "Investor name and signature: ____________________   Date: __________",
    "",
    "Upload the signed copy as a PDF on the conversation page. Staff check it before anything else happens."
  ].join("\n")
} as const;
