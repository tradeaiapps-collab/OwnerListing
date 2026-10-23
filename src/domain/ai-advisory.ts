export const PUBLIC_AI_DISCLAIMER =
  "General information only. This is not financial, credit or legal advice and is not a recommendation for you. " +
  "Estimates are rough and may be wrong. Speak to a licensed broker before making any decision.";

export type AdvisoryMode = "public_general" | "broker_professional";

export interface BrokerCredential { userId: string; creditLicenceVerified: boolean }

export interface BrokerNomination {
  brokerUserId: string;
  buyerUserId: string;
  active: boolean;
  buyerConsentToShareFinancials: boolean;
}

/**
 * The professional AI is only available to a broker with a verified credit licence who has an
 * active nomination from this buyer and the buyer's consent to share financial details.
 * Everything else gets the public general-information AI.
 */
export function resolveAdvisoryMode(
  brokerId: string,
  buyerId: string,
  credential?: BrokerCredential,
  nomination?: BrokerNomination
): AdvisoryMode {
  const ok =
    credential !== undefined && nomination !== undefined &&
    credential.userId === brokerId && credential.creditLicenceVerified &&
    nomination.brokerUserId === brokerId && nomination.buyerUserId === buyerId &&
    nomination.active && nomination.buyerConsentToShareFinancials;
  return ok ? "broker_professional" : "public_general";
}

/** Public AI output always carries the disclaimer. */
export function withPublicDisclaimer(text: string): string {
  return `${text}\n\n${PUBLIC_AI_DISCLAIMER}`;
}

/** Professional AI output is a draft for the broker. The buyer sees it only after the broker releases it. */
export const PROFESSIONAL_OUTPUT_REQUIRES_BROKER_RELEASE = true;
