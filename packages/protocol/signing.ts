// Browser-safe EIP-712 field definition shared with the server and verifier.
export const claimTypes = {
  Claim: [
    { name: "protocol", type: "string" },
    { name: "assetDigest", type: "bytes32" },
    { name: "mediaType", type: "string" },
    { name: "byteLength", type: "uint256" },
    { name: "claimsRoot", type: "bytes32" },
    { name: "claimLeafCount", type: "uint32" },
    { name: "parentsRoot", type: "bytes32" },
    { name: "parentCount", type: "uint32" },
    { name: "operation", type: "string" },
    { name: "engineDigest", type: "bytes32" },
    { name: "issuer", type: "address" },
    { name: "keyEpoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
