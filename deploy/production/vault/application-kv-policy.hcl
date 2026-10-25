# Application reads exact configured versions. Rotation is an operator action.
path "secret/data/contentproof/storage" {
  capabilities = ["read"]
}
path "secret/data/contentproof/relayer" {
  capabilities = ["read"]
}
