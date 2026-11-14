import { NextResponse } from "next/server";
import { asDemoUser, call, nearblocksTx, TGAS } from "@/lib/launch/chain";
import { REGISTRY_ID } from "@/lib/near";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// No-wallet path: the demo user's server-held key signs register_mandate.
// The wallet path (client-side, user-signed) is unchanged; this exists so the demo
// doesn't depend on an external wallet's RPC being healthy.
export async function POST(req: Request) {
  let body: { mandate_json?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const { mandate_json, label } = body;
  if (typeof mandate_json !== "string" || typeof label !== "string" || mandate_json.length > 4096 || label.length > 200)
    return NextResponse.json({ ok: false, error: "invalid mandate" }, { status: 400 });
  try {
    JSON.parse(mandate_json);
  } catch {
    return NextResponse.json({ ok: false, error: "mandate_json is not JSON" }, { status: 400 });
  }
  try {
    const { id, acc } = await asDemoUser();
    const r = await call(acc, REGISTRY_ID, "register_mandate", { mandate_json, label }, {
      gas: TGAS(30),
      deposit: BigInt("10000000000000000000000"), // 0.01 NEAR
    });
    return NextResponse.json({
      ok: !r.failure,
      account: id,
      hash: r.hash,
      url: r.hash ? nearblocksTx(r.hash) : "",
      error: r.failure,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
