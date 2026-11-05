import type { TemplateCategory, TemplateContent } from "../domain/doc-templates";

/**
 * Starter templates. They are installed as DRAFT version 1 by a staff member (POST /api/staff/doc-templates, action install_starters) and
 * do nothing until a different staff member publishes them. The wording is a plain-language starting point, NOT legal advice:
 * counsel must review each one (and the state it is used in) before it is published. Contracts of sale are state specific and
 * prepared by the owner's solicitor, so there is deliberately no contract of sale here. The platform holds no money; deposits go to the solicitor's trust account.
 */
export interface StarterTemplate { key: string; title: string; category: TemplateCategory; content: TemplateContent }

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    key: "agent_appointment", title: "Agent appointment agreement", category: "agreement",
    content: {
      fields: [
        { key: "agent_name", label: "Agent or agency name", type: "text", required: true },
        { key: "licence_number", label: "Agent licence number", type: "text", required: true },
        { key: "start_date", label: "Appointment starts", type: "date", required: true },
        { key: "end_date", label: "Appointment ends", type: "date", required: true },
        { key: "commission", label: "Fee or commission agreed (describe)", type: "text", required: true }
      ],
      clauses: [
        { id: "parties", heading: "Parties and property", text: "{{owner_name}} (the owner) appoints {{agent_name}}, licence {{licence_number}} (the agent), to help market {{listing_title}} at {{listing_address}} in {{jurisdiction}}.",
          explanation: "This says who is agreeing to what, and which property it is about. Check the names and the address are right before you sign." },
        { id: "term", heading: "Length of appointment", text: "The appointment starts on {{start_date}} and ends on {{end_date}}, unless the owner ends it earlier through the platform.",
          explanation: "This is how long the agent can act for the owner. The owner can end it early on the platform, and access then stops." },
        { id: "fee", heading: "Fee", text: "The agent's fee is: {{commission}}. No fee is payable unless it is written here.",
          explanation: "This is the only fee the agent can charge for this property. If something about money is not written here, it is not agreed." },
        { id: "authority", heading: "What the agent may and may not do", text: "The agent may answer enquiries, arrange inspections and pass on offers. The agent may not accept an offer or sign a contract for the owner. The owner decides every offer.",
          explanation: "The agent helps, but only the owner can accept an offer. The platform's AI also never accepts an offer for anyone." },
        { id: "money", heading: "Money", text: "The platform does not hold money. Any deposit is paid to the solicitor's trust account named in the contract.",
          explanation: "Deposits do not go to the platform or the agent. They go to a solicitor's trust account." }
      ]
    }
  },
  {
    key: "owner_declaration", title: "Owner declaration", category: "disclosure",
    content: {
      fields: [
        { key: "known_defects", label: "Known defects or issues (write 'None known' if none)", type: "multiline", required: true },
        { key: "works_done", label: "Building work or renovations in the last 7 years", type: "multiline", required: true }
      ],
      clauses: [
        { id: "truth", heading: "Accuracy", text: "I, {{owner_name}}, declare that the information I have given about {{listing_title}} at {{listing_address}} is true and complete to the best of my knowledge.",
          explanation: "You are telling buyers the facts are true as far as you know. Giving false information can have legal consequences for you, not the platform." },
        { id: "defects", heading: "Known defects", text: "Known defects or issues: {{known_defects}}", explanation: "List anything a buyer would want to know about, such as damp, termites, cracks or noisy neighbours. If you are unsure, say so." },
        { id: "works", heading: "Building work", text: "Building work or renovations in the last 7 years: {{works_done}}", explanation: "Buyers and their lawyers ask about approvals for building work, so be specific about what was done and when." },
        { id: "update", heading: "Keeping this up to date", text: "I will tell the platform and any interested buyer if anything above changes before the property is sold.",
          explanation: "If you find a new problem, or something changes, you need to update this before settlement." }
      ]
    }
  },
  {
    key: "buyer_acknowledgement", title: "Buyer pre-contract acknowledgement", category: "agreement",
    content: {
      fields: [{ key: "indicative_price", label: "Price the buyer is considering", type: "money", required: true }],
      clauses: [
        { id: "scope", heading: "What this is", text: "This acknowledgement is about {{listing_title}} at {{listing_address}}. The buyer is considering a price of {{indicative_price}}.",
          explanation: "This records that you are interested at roughly this price. It is not an offer and it does not bind anyone to buy or sell." },
        { id: "nobinding", heading: "Not a contract", text: "Signing this does not form a contract of sale. A contract exists only when a written contract of sale is signed by both sides, after each has been able to get legal advice.",
          explanation: "You can walk away after signing this. A sale only becomes binding with a proper contract of sale." },
        { id: "advice", heading: "Independent advice", text: "The buyer understands that the platform and its AI assistant give general information only and are not a lawyer, conveyancer or financial adviser.",
          explanation: "Elena and the platform can explain how things work, but cannot give legal advice. Talk to a solicitor or conveyancer before you commit to buying." }
      ]
    }
  },
  {
    key: "inspection_access", title: "Inspection access and acknowledgement", category: "agreement",
    content: {
      fields: [{ key: "inspection_date", label: "Inspection date", type: "date", required: true }],
      clauses: [
        { id: "access", heading: "Access", text: "{{owner_name}} allows the person signing below to enter {{listing_title}} at {{listing_address}} on {{inspection_date}} to inspect it.",
          explanation: "This lets the visitor in on that day only." },
        { id: "care", heading: "Taking care", text: "The visitor will take reasonable care of the property and its contents, will not take photos of personal items, and will leave when asked.",
          explanation: "These are house rules for a visit, to protect the owner's privacy and belongings." },
        { id: "risk", heading: "Risk", text: "The visitor enters at their own risk, except for harm caused by the owner's own negligence. Nothing here limits any right the law gives either side.",
          explanation: "Homes can have uneven floors or steps. You take normal care, and the law still protects you if the owner is at fault." }
      ]
    }
  }
];
