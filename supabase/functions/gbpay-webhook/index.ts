// supabase/functions/gbpay-webhook/index.ts
// Receives server-side callbacks (backgroundUrl) from GB Prime Pay after payment.
// Works for both PromptPay QR and card payments.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GB_SECRET_KEY  (used to verify the callback signature)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "https://deno.land/std@0.168.0/node/crypto.ts";

const GB_SECRET_KEY = Deno.env.get("GB_SECRET_KEY") ??
  Deno.env.get("GBPRIMEPAY_SECRET_KEY") ??
  Deno.env.get("GBPAY_SECRET_KEY") ??
  "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function text(body: string, status = 200) {
  return new Response(body, { status, headers: CORS });
}

// ---------- signature verification ----------
/**
 * GB Prime Pay HMAC-SHA256 signature:
 * HMAC-SHA256( secretKey, amount + referenceNo + resultCode )
 */
function verifySignature(
  secretKey: string,
  amount: string,
  referenceNo: string,
  resultCode: string,
  checksum: string
): boolean {
  if (!secretKey || !checksum) return true; // skip verification in mock mode
  try {
    const hmac = createHmac("sha256", secretKey)
      .update(amount + referenceNo + resultCode)
      .digest("hex");
    return hmac === checksum;
  } catch {
    return false;
  }
}

// ---------- parse callback body ----------
async function parseBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await req.json()) as Record<string, string>;
  }
  // GB Pay sends form-encoded
  const text = await req.text();
  const params = new URLSearchParams(text);
  const obj: Record<string, string> = {};
  params.forEach((v, k) => { obj[k] = v; });
  return obj;
}

// ---------- main ----------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const payload = await parseBody(req);

    // GB Pay callback fields
    const referenceNo =
      payload.referenceNo ??
      payload.merchantDefined1 ??
      payload.order_id ?? // our custom query param
      new URL(req.url).searchParams.get("order_id") ??
      "";

    const resultCode = String(payload.resultCode ?? payload.resultcode ?? "");
    const amount = String(payload.amount ?? "");
    const checksum = String(payload.checksum ?? payload.hmac ?? "");
    const gbpReferenceNo = String(payload.gbpReferenceNo ?? payload.providerPaymentId ?? "");

    if (!referenceNo) {
      console.warn("[gbpay-webhook] Missing referenceNo", payload);
      return text("missing referenceNo", 400);
    }

    // Verify signature (skip if secretKey not set)
    if (GB_SECRET_KEY && !verifySignature(GB_SECRET_KEY, amount, referenceNo, resultCode, checksum)) {
      console.warn("[gbpay-webhook] Signature mismatch for order", referenceNo);
      return text("invalid signature", 403);
    }

    const isPaid = resultCode === "00";
    const isFailed = ["01", "02", "99", "X3"].includes(resultCode) && !isPaid;

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (isPaid) {
      await sb.from("orders").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        provider_payment_id: gbpReferenceNo || null,
        provider_result_code: resultCode,
      }).eq("id", referenceNo).eq("status", "pending"); // guard: only update if still pending
    } else if (isFailed) {
      await sb.from("orders").update({
        status: "failed",
        provider_result_code: resultCode,
      }).eq("id", referenceNo);
    }

    console.log(`[gbpay-webhook] order=${referenceNo} resultCode=${resultCode} paid=${isPaid}`);
    return text("OK");
  } catch (err) {
    console.error("[gbpay-webhook]", err);
    return text("error", 500);
  }
});
