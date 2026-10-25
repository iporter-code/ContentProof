// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/access/Ownable.sol";

contract IdentityRegistry is Ownable {
    struct Key { address signer; uint64 authorizedAt; uint64 retiredAt; uint64 revokedAt; }
    mapping(address => mapping(uint256 => Key)) public keys;
    event KeyAuthorized(address indexed issuer, uint256 indexed epoch, address signer);
    event KeyRetired(address indexed issuer, uint256 indexed epoch);
    event KeyRevoked(address indexed issuer, uint256 indexed epoch);
    constructor() Ownable(msg.sender) {}
    modifier issuerOrOwner(address issuer) { require(msg.sender == issuer || msg.sender == owner(), "NOT_AUTHORIZED"); _; }
    function authorizeKey(address issuer, uint256 epoch, address signer) external issuerOrOwner(issuer) {
        require(issuer != address(0) && signer != address(0), "ZERO_ADDRESS");
        require(keys[issuer][epoch].authorizedAt == 0, "EPOCH_EXISTS");
        keys[issuer][epoch] = Key(signer, uint64(block.number), 0, 0);
        emit KeyAuthorized(issuer, epoch, signer);
    }
    function retireKey(address issuer, uint256 epoch) external issuerOrOwner(issuer) {
        Key storage k = keys[issuer][epoch]; require(k.authorizedAt != 0 && k.retiredAt == 0, "INVALID_KEY");
        k.retiredAt = uint64(block.number); emit KeyRetired(issuer, epoch);
    }
    function revokeKey(address issuer, uint256 epoch) external issuerOrOwner(issuer) {
        Key storage k = keys[issuer][epoch]; require(k.authorizedAt != 0 && k.revokedAt == 0, "INVALID_KEY");
        k.revokedAt = uint64(block.number); emit KeyRevoked(issuer, epoch);
    }
    function isKeyActive(address issuer, uint256 epoch, address signer) external view returns (bool) {
        Key memory k = keys[issuer][epoch];
        return k.authorizedAt != 0 && k.retiredAt == 0 && k.revokedAt == 0 && k.signer == signer;
    }
}
