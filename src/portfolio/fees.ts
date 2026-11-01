/**
 * Shared eBay seller fee table (mirrors src/decision.py + config defaults).
 * FVF 13.25% + flat order fee ($0.30 ≤$10 / $0.40 otherwise) + shipping estimate.
 */

export const EBAY_SELLER_FVF_PCT = 0.1325;
export const EBAY_SELLER_FLAT_FEE_LOW_CENTS = 30;
export const EBAY_SELLER_FLAT_FEE_HIGH_CENTS = 40;
export const EBAY_SELLER_FLAT_FEE_THRESHOLD_CENTS = 1000;
export const EBAY_SELLER_SHIPPING_ESTIMATE_CENTS = 500;

export type EbayFeeBreakdown = {
  fvf_cents: number;
  flat_cents: number;
  shipping_cents: number;
  total_cents: number;
  net_proceeds_cents: number;
};

export function ebayFlatFeeCents(salePriceCents: number): number {
  return salePriceCents <= EBAY_SELLER_FLAT_FEE_THRESHOLD_CENTS
    ? EBAY_SELLER_FLAT_FEE_LOW_CENTS
    : EBAY_SELLER_FLAT_FEE_HIGH_CENTS;
}

/** Fees + net for a sale at salePriceCents (item only; free shipping to buyer). */
export function computeEbayFeesCents(
  salePriceCents: number,
  sellerShippingCents: number = EBAY_SELLER_SHIPPING_ESTIMATE_CENTS,
): EbayFeeBreakdown {
  const price = Math.max(0, Math.round(salePriceCents));
  const fvf = Math.round(price * EBAY_SELLER_FVF_PCT);
  const flat = ebayFlatFeeCents(price);
  const shipping = Math.max(0, Math.round(sellerShippingCents));
  const total = fvf + flat + shipping;
  return {
    fvf_cents: fvf,
    flat_cents: flat,
    shipping_cents: shipping,
    total_cents: total,
    net_proceeds_cents: price - total,
  };
}
