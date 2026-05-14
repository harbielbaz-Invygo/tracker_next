/**
 * VIN-chase classifier — shared between server data layer + drawer UI.
 *
 * Admins rename action_types freely (e.g. "Plate Waiting from Dealer"
 * instead of literal "Plate"), so we route an action by SUBSTRING match
 * against a small keyword list rather than canonical name equality.
 *
 * Tokens are specific enough not to false-match common internal-phase
 * names (no token appears in "Car Specs", "Pricing", "SKU", or
 * "Uploading Cars"). App Listing + Delivery are filtered upstream into
 * their own drawer panels and never reach this classifier.
 */

export const VIN_CHASE_KEYWORDS = [
  "vin",
  "plate",
  "customs",
  "tracking",
  "inspection",
  "showroom",
  "confirmation email",   // "Send Dealer Confirmation Email"
  "dealer email",         // alternate phrasing
] as const;

export function isVinChaseName(actionTypeName: string): boolean {
  const name = actionTypeName.toLowerCase();
  return VIN_CHASE_KEYWORDS.some((kw) => name.includes(kw));
}

export function clusterFor(actionTypeName: string): "vin_chase" | "internal" {
  return isVinChaseName(actionTypeName) ? "vin_chase" : "internal";
}
