import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toRlp, type Hex } from "viem";
const root = resolve("data/qbft-network"),
  network = "ccf-qbft-net";
function docker(args: string[], allowFailure = false) {
  const r = spawnSync("docker", args, { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0 && !allowFailure)
    throw Error(r.stderr || "DOCKER_COMMAND_FAILED");
  return r;
}
const command = process.argv[2] ?? "init",
  file = resolve(root, "compose.json");
if (command === "init") {
  if (existsSync(file)) throw Error("QBFT_CONFIGURATION_EXISTS_USE_UP");
  if (
    existsSync(resolve(root, "genesis.json")) ||
    existsSync("data/qbft-app/node.key")
  )
    throw Error("QBFT_PARTIAL_CONFIGURATION_PRESERVED_REVIEW_BEFORE_INIT");
  if (docker(["network", "inspect", network], true).status !== 0)
    docker(["network", "create", network]);
  const meta = JSON.parse(docker(["network", "inspect", network]).stdout)[0],
    subnet = meta.IPAM.Config[0].Subnet as string,
    [base, prefix] = subnet.split("/");
  if (Number(prefix) > 24) throw Error("NETWORK_SUBNET_TOO_SMALL");
  const start = base
      .split(".")
      .map(Number)
      .reduce((n, x) => (n * 256 + x) >>> 0, 0),
    ip = (offset: number) => {
      const n = (start + offset) >>> 0;
      return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    };
  mkdirSync(root, { recursive: true });
  const nodes = Array.from({ length: 4 }, (_, i) => {
    const key = generatePrivateKey();
    return { account: privateKeyToAccount(key), ip: ip(11 + i), key };
  });
  const addresses = nodes
      .map((n) => n.account.address.toLowerCase() as Hex)
      .sort(),
    extraData = toRlp([`0x${"00".repeat(32)}`, addresses, [], "0x", []]);
  const relayer = generatePrivateKey(),
    fee = privateKeyToAccount(relayer),
    genesis = {
      config: {
        chainId: 31338,
        berlinBlock: 0,
        londonBlock: 0,
        zeroBaseFee: true,
        qbft: {
          blockperiodseconds: 2,
          epochlength: 30000,
          requesttimeoutseconds: 4,
        },
      },
      nonce: "0x0",
      timestamp: "0x0",
      extraData,
      gasLimit: "0x1c9c380",
      difficulty: "0x1",
      mixHash:
        "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
      coinbase: `0x${"00".repeat(20)}`,
      alloc: {
        [fee.address.slice(2).toLowerCase()]: {
          balance: "1000000000000000000000",
        },
      },
    };
  writeFileSync(
    resolve(root, "genesis.json"),
    JSON.stringify(genesis, null, 2),
    { flag: "wx" },
  );
  const enodes = nodes.map(
      (n) => `enode://${n.account.publicKey.slice(4)}@${n.ip}:30303`,
    ),
    services: Record<string, any> = {},
    volumes: Record<string, any> = {};
  writeFileSync(
    resolve(root, "permissions.toml"),
    `nodes-allowlist=${JSON.stringify(enodes)}\naccounts-allowlist=${JSON.stringify([fee.address])}\n`,
  );
  for (let i = 0; i < nodes.length; i++) {
    const name = `validator${i + 1}`,
      key = resolve(root, `${name}.key`);
    writeFileSync(key, nodes[i].key.slice(2), { flag: "wx", mode: 0o600 });
    volumes[name] = {};
    services[name] = {
      image: "ccf-besu:26.10.0",
      command: [
        "--data-path=/var/lib/besu",
        "--genesis-file=/config/genesis.json",
        "--node-private-key-file=/config/node.key",
        `--p2p-host=${nodes[i].ip}`,
        "--discovery-enabled=false",
        "--static-nodes-file=/config/static-nodes.json",
        "--permissions-nodes-config-file-enabled=true",
        "--permissions-nodes-config-file=/var/lib/besu/permissions.toml",
        "--permissions-accounts-config-file-enabled=true",
        "--permissions-accounts-config-file=/var/lib/besu/permissions.toml",
        "--rpc-http-enabled=true",
        "--rpc-http-host=0.0.0.0",
        "--rpc-http-api=ETH,NET,WEB3,QBFT",
        "--host-allowlist=*",
        "--min-gas-price=0",
        "--sync-mode=FULL",
        "--data-storage-format=FOREST",
        "--logging=WARN",
      ],
      volumes: [
        {
          type: "bind",
          source: key,
          target: "/config/node.key",
          read_only: true,
        },
        {
          type: "bind",
          source: resolve(root, "genesis.json"),
          target: "/config/genesis.json",
          read_only: true,
        },
        {
          type: "bind",
          source: resolve(root, "static-nodes.json"),
          target: "/config/static-nodes.json",
          read_only: true,
        },
        {
          type: "bind",
          source: resolve(root, "permissions.toml"),
          target: "/config/permissions.toml",
          read_only: true,
        },
        { type: "volume", source: name, target: "/var/lib/besu" },
      ],
      networks: { qbft: { ipv4_address: nodes[i].ip } },
      ports: [`127.0.0.1:${8575 + i}:8545`],
      mem_limit: "1024m",
      cpus: 1,
      pids_limit: 128,
      stop_grace_period: "30s",
    };
  }
  writeFileSync(resolve(root, "static-nodes.json"), JSON.stringify(enodes));
  writeFileSync(
    file,
    JSON.stringify(
      {
        name: "ccf-qbft",
        services,
        volumes,
        networks: { qbft: { external: true, name: network } },
      },
      null,
      2,
    ),
  );
  mkdirSync("data/qbft-app", { recursive: true });
  if (existsSync("data/qbft-app/node.key")) throw Error("RELAYER_FILE_EXISTS");
  writeFileSync("data/qbft-app/node.key", relayer, { flag: "wx", mode: 0o600 });
  console.log(
    "Generated four random validators and a separate funded relayer. Private material stays under data/.",
  );
} else {
  if (!existsSync(file)) throw Error("RUN_QBFT_INIT_FIRST");
  if (command === "up") {
    const config = JSON.parse(readFileSync(file, "utf8"));
    for (const service of Object.values(config.services) as any[])
      service.command = service.command.map((arg: string) =>
        arg.replace(
          "config-file=/config/permissions.toml",
          "config-file=/var/lib/besu/permissions.toml",
        ),
      );
    writeFileSync(file, JSON.stringify(config, null, 2));
  }
  const args =
    command === "up"
      ? ["up", "-d"]
      : command === "down"
        ? ["down"]
        : command === "logs"
          ? ["logs", "--tail", "30"]
          : [command, ...process.argv.slice(3)];
  const r = spawnSync("docker", ["compose", "-f", file, ...args], {
    windowsHide: true,
    stdio: "inherit",
  });
  process.exitCode = r.status ?? 1;
}
