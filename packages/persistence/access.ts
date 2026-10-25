// Correlated predicates share the database clock, including cursor/stat queries.
export const activeAssetGrant =
  "NOT EXISTS(SELECT 1 FROM asset_grant_expiries e WHERE e.digest=p.digest AND e.owner=p.owner AND e.expires<=cp_now())";
export const activeClaimGrant =
  "NOT EXISTS(SELECT 1 FROM claim_grant_expiries e WHERE e.id=p.id AND e.owner=p.owner AND e.expires<=cp_now())";
