# Alternative to KV, not an additional provider for the same storage key.
# The KEK stays in Vault. The unwrapped data key still enters app memory.
path "transit/decrypt/contentproof-storage" {
  capabilities = ["update"]
}
path "transit/rewrap/contentproof-storage" {
  capabilities = ["update"]
}
