// supabase/functions/check-gbpay-payment-status/index.ts
// Polls order status from Supabase DB — called by frontend every 5 s after payment creation.
//
// Optional: also queries GB Prime Pay's inquiry API to sync status server-side.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GB_SECRET_KEY   (for GB Pay inquiry API — optional, falls back to DB only)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GB_API_BASE =
  Deno.env.get("GB_API_BASE") ?? "https://api.gbprimepay.com";
const GB_SECRET_KEY = Deno.env.get("GB_SECRET_KEY") ??
  Deno.env.get("GBPRIMEPAY_SECRET_KEY") ??
  Deno.env.get("GBPAY_SECRET_KEY") ??
  "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Query GB Prime Pay's transaction inquiry endpoint */
async function queryGbPayStatus(referenceNo: string): Promise<string | null> {
  if (!GB_SECRET_KEY) return null;
  try {
    const body = new URLSearchParams({ secretKey: GB_SECRET_KEY, referenceNo });
    const res = await fetch(`${GB_API_BASE}/gbp/gateway/inquiry`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const code = String(data.resultCode ?? data.resultcode ?? "");
    if (code === "00") return "paid";
    if (["01", "02", "99"].includes(code)) return "failed";
    return null; // unknown / still pending
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { orderId } = (await req.json()) as { orderId: string };
    if (!orderId) return json({ error: "orderId required" }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Fetch order from DB
    const { data: order, error } = await sb
      .from("orders")
      .select("id, status, total, paid_at, created_at")
      .eq("id", orderId)
      .single();

    if (error || !order) return json({ error: "Order not found" }, 404);

    // 2. If DB already shows paid/failed, return that
    const dbStatus: string = order.status ?? "pending";
    if (dbStatus === "paid" || dbStatus === "failed") {
      return json({ orderId, status: dbStatus, mode: "live" });
    }

    // 3. Optionally sync with GB Pay inquiry API
    const liveStatus = await queryGbPayStatus(orderId);
    if (liveStatus === "paid") {
      await sb
        .from("orders")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", orderId);
      return json({ orderId, status: "paid", mode: "live" });
    }
    if (liveStatus === "failed") {
      await sb.from("orders").update({ status: "failed" }).eq("id", orderId);
      return json({ orderId, status: "failed", mode: "live" });
    }

    // 4. Still pending
    return json({ orderId, status: "pending", mode: "live" });
  } catch (err) {
    console.error("[check-gbpay-payment-status]", err);
    return json({ error: (err as Error).message }, 500);
  }
});
