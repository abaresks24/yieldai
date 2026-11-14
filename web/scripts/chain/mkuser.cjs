// Create the demo user sub-account (funded by the deployer) and store its key.
const fs = require("fs");
const { conn, toYocto, genKey, fromYocto } = require("./lib.cjs");
const P = ".secrets/testnet-keys.json";
const k = JSON.parse(fs.readFileSync(P, "utf8"));
(async () => {
  const dep = await conn(k.deployer.account, k.deployer.sk);
  const id = `user.${k.deployer.account}`;
  const key = genKey();
  await dep.createAccount(id, key.pk, BigInt(toYocto(2)));
  k.demoUser = { account: id, sk: key.sk };
  fs.writeFileSync(P, JSON.stringify(k, null, 2), { mode: 0o600 });
  const keep = ["deployer", "agent", "accounts", "coordinator", "vault", "guardianAccounts", "demoUser"];
  fs.writeFileSync(".secrets/launch-keys.min.json", JSON.stringify(Object.fromEntries(keep.map((x) => [x, k[x]]))));
  const u = await conn(id, key.sk);
  console.log("created", id, fromYocto((await u.getAccountBalance()).total), "NEAR");
})().catch((e) => { console.error(String(e.message || e).slice(0, 300)); process.exit(1); });
