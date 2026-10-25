import { seed } from "./client.js";
const { tokens, identities, ...ids } = await seed();
console.log(
  "Three-identity workflow anchored successfully.\n",
  JSON.stringify(ids, null, 2),
  "\nBundles: data/demo/full.zip and data/demo/private.zip.\nOpen the web app as 发布机构 C to view the final claim.",
);
