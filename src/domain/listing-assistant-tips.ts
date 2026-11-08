/** Elena's field tips. Kept free of server-only imports so the listing form (a client component) can use them. */

// ---- Field tips (the Elena "?" tooltips) ---------------------------------------------------------------------------------------

export const TIP_FIELDS = ["title", "address", "suburb", "price", "description", "bedrooms", "bathrooms", "parking", "amenities"] as const;
export type TipField = (typeof TIP_FIELDS)[number];

export function fieldTips(f: { transactionType: "sale" | "rent"; propertyType: string }): Record<TipField, string> {
  const rent = f.transactionType === "rent";
  return {
    title: "Lead with the best feature and the suburb, in under 60 characters. For example: \"Renovated 3 bedroom home with pool, Paddington\".",
    address: "Start typing and pick a suggestion: Elena fills the suburb, state and postcode for you. The street address is not shown to buyers until you choose.",
    suburb: "Buyers search by suburb, and Elena uses it to find recent nearby results for price guidance.",
    price: rent
      ? "Enter the weekly rent. Elena compares it with recent nearby leases and suggests a figure just under a common search step."
      : "Enter the price you have in mind. Elena compares it with recent nearby sales and shows where it sits. Never quote below what you would accept.",
    description: "Say what the property has and where it is. Use numbers (rooms, car spaces, distances) and describe the property, not who should live there. Elena can shorten or tidy your text.",
    bedrooms: "Count bedrooms with a built-in wardrobe or a door that closes. Leave blank for land.",
    bathrooms: "Count every bathroom, including an ensuite. A separate toilet is not a bathroom.",
    parking: "Garage, carport and off-street spaces all count. Leave blank if there are none.",
    amenities: "Ticked extras become search filters, so tick every one that is true. Elena suggests ticks from your description."
  };
}

