/**
 * Human-readable names for the replay demo universe.
 *
 * A demo aid, not a data source: the replay provider deals only in symbols. A
 * live provider (Twelve Data) returns the real company name, at which point
 * this map becomes a fallback for anything it does not cover.
 */
const COMPANY_NAMES: Record<string, string> = {
  RELIANCE: "Reliance Industries",
  TCS: "Tata Consultancy Services",
  HDFCBANK: "HDFC Bank",
  INFY: "Infosys",
  ZOMATO: "Zomato",
  ITC: "ITC",
  TATAMOTORS: "Tata Motors",
  SBIN: "State Bank of India",
};

export function companyName(symbol: string): string | null {
  return COMPANY_NAMES[symbol.toUpperCase()] ?? null;
}
