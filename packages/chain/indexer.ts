import { publicClient, deployment } from "./index.js";
import { one, run, db } from "../../apps/api/store.js";
/** Recoverable confirmed-event index. Verification never trusts these database rows. */
export async function tickIndexer() {
  const d = deployment();
  const height = await publicClient.getBlockNumber({ cacheTime: 0 });
  let checkpoint = one("SELECT * FROM checkpoints WHERE id=?", d.provenance);
  if (checkpoint) {
    const old = await publicClient
      .getBlock({ blockNumber: BigInt(checkpoint.blockNumber) })
      .catch(() => null);
    if (!old || old.hash !== checkpoint.blockHash) {
      run("DELETE FROM chain_events");
      run("DELETE FROM checkpoints WHERE id=?", d.provenance);
      checkpoint = undefined;
    }
  }
  const start = checkpoint
    ? BigInt(checkpoint.blockNumber) + 1n
    : BigInt(d.blockNumber);
  if (start > height) return;
  const end = start + 499n < height ? start + 499n : height;
  const logs = await publicClient.getLogs({
    address: [d.identity, d.provenance],
    fromBlock: start,
    toBlock: end,
  });
  const block = await publicClient.getBlock({ blockNumber: end });
  db.exec("BEGIN");
  try {
    for (const log of logs)
      run(
        "INSERT OR IGNORE INTO chain_events VALUES(?,?,?,?)",
        `${d.chainId}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`,
        String(log.blockNumber),
        log.blockHash!,
        JSON.stringify(log, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
    run(
      "INSERT OR REPLACE INTO checkpoints VALUES(?,?,?)",
      d.provenance,
      String(end),
      block.hash,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
