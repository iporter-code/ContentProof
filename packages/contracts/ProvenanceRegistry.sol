// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./IdentityRegistry.sol";

contract ProvenanceRegistry is EIP712 {
    struct Claim {
        string protocol; bytes32 assetDigest; string mediaType; uint256 byteLength;
        bytes32 claimsRoot; uint32 claimLeafCount; bytes32 parentsRoot; uint32 parentCount;
        string operation; bytes32 engineDigest; address issuer; uint256 keyEpoch; uint256 nonce; uint256 deadline;
    }
    struct Record { address issuer; bytes32 assetDigest; uint64 blockNumber; bool withdrawn; }
    bytes32 public constant TYPEHASH = keccak256("Claim(string protocol,bytes32 assetDigest,string mediaType,uint256 byteLength,bytes32 claimsRoot,uint32 claimLeafCount,bytes32 parentsRoot,uint32 parentCount,string operation,bytes32 engineDigest,address issuer,uint256 keyEpoch,uint256 nonce,uint256 deadline)");
    IdentityRegistry public immutable identity;
    mapping(address => mapping(uint256 => uint256)) public nonces;
    mapping(bytes32 => Record) public records;
    event ClaimAnchored(bytes32 indexed claimId, bytes32 indexed assetDigest, address indexed issuer, uint256 keyEpoch, bytes32 claimsRoot, bytes32 parentsRoot);
    event ClaimInvalidated(bytes32 indexed claimId, bytes32 reasonDigest);
    constructor(address registry) EIP712("ContentProof", "1") { require(registry != address(0)); identity = IdentityRegistry(registry); }
    function digest(Claim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH,
            keccak256(bytes(c.protocol)), c.assetDigest, keccak256(bytes(c.mediaType)), c.byteLength,
            c.claimsRoot, c.claimLeafCount, c.parentsRoot, c.parentCount, keccak256(bytes(c.operation)),
            c.engineDigest, c.issuer, c.keyEpoch, c.nonce, c.deadline)));
    }
    function registerClaim(Claim calldata c, bytes calldata signature) external returns (bytes32 id) {
        require(keccak256(bytes(c.protocol)) == keccak256("contentproof/1"), "PROTOCOL");
        require(c.assetDigest != bytes32(0) && c.claimsRoot != bytes32(0) && c.parentsRoot != bytes32(0), "ZERO_HASH");
        require(c.byteLength > 0 && c.byteLength <= 20 * 1024 * 1024 && c.claimLeafCount <= 128 && c.parentCount <= 8, "LIMIT");
        require(c.deadline >= block.timestamp, "EXPIRED");
        id = digest(c); require(records[id].blockNumber == 0, "EXISTS");
        require(c.nonce == nonces[c.issuer][c.keyEpoch], "NONCE");
        require(identity.isKeyActive(c.issuer, c.keyEpoch, ECDSA.recover(id, signature)), "SIGNER");
        nonces[c.issuer][c.keyEpoch]++;
        records[id] = Record(c.issuer, c.assetDigest, uint64(block.number), false);
        emit ClaimAnchored(id, c.assetDigest, c.issuer, c.keyEpoch, c.claimsRoot, c.parentsRoot);
    }
    function invalidateClaim(bytes32 id, bytes32 reasonDigest) external {
        Record storage r = records[id]; require(r.blockNumber != 0 && r.issuer == msg.sender && !r.withdrawn, "NOT_ISSUER");
        r.withdrawn = true; emit ClaimInvalidated(id, reasonDigest);
    }
    function invalidateClaimBySignature(bytes32 id, uint256 deadline, bytes calldata signature) external {
        Record storage r=records[id];
        require(r.blockNumber!=0 && !r.withdrawn && deadline>=block.timestamp,"INVALID_WITHDRAWAL");
        bytes32 message=_hashTypedDataV4(keccak256(abi.encode(keccak256("Withdrawal(bytes32 claimId,uint256 deadline)"),id,deadline)));
        require(ECDSA.recover(message,signature)==r.issuer,"NOT_ISSUER");
        r.withdrawn=true;emit ClaimInvalidated(id,keccak256("issuer-withdrawal"));
    }
}
