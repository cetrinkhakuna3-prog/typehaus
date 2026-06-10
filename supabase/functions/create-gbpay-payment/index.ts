// supabase/functions/create-gbpay-payment/index.ts
// Handles both PromptPay QR and credit/debit card via GB Prime Pay API
//
// Required env vars (set in Supabase Dashboard → Settings → Edge Functions):
//   GB_PUBLIC_KEY   — GB Prime Pay public key
//   GB_SECRET_KEY   — GB Prime Pay secret key
//   SUPABASE_URL    — auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase
//
// Optional:
//   GB_API_BASE     — defaults to https://api.gbprimepay.com

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- config ----------
const GB_API_BASE =
  Deno.env.get("GB_API_BASE") ?? "https://api.gbprimepay.com";
const GB_PUBLIC_KEY = Deno.env.get("GB_PUBLIC_KEY") ?? "";
const GB_SECRET_KEY = Deno.env.get("GB_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SITE_URL = "https://cetrinkhakuna3-prog.github.io/typehaus";
const RETURN_URL = `${SITE_URL}/payment-return.html`;

// ---------- CORS ----------
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

// ---------- helpers ----------

/** Convert amount (THB) → satang string, padded to 10 chars */
function toSatang(thb: number): string {
  return String(Math.round(thb * 100)).padStart(10, "0");
}

/** Build background URL pointing to our webhook function */
function backgroundUrl(orderId: string): string {
  return `${SUPABASE_URL}/functions/v1/gbpay-webhook?order_id=${orderId}`;
}

/** True when GB Prime Pay credentials are not yet configured */
function isMockMode(): boolean {
  return !GB_PUBLIC_KEY || !GB_SECRET_KEY;
}

// ---------- GB Pay — PromptPay QR ----------
async function createQrPayment(params: {
  orderId: string;
  amount: number;
  customerName: string;
  customerEmail: string;
  description: string;
}) {
  const body = new URLSearchParams({
    publicKey: GB_PUBLIC_KEY,
    amount: toSatang(params.amount),
    referenceNo: params.orderId,
    backgroundUrl: backgroundUrl(params.orderId),
    responseUrl: `${RETURN_URL}?order_id=${params.orderId}`,
    detail: params.description.slice(0, 255),
    customerName: params.customerName || "Customer",
    customerEmail: params.customerEmail || "",
    customerTelephone: "",
    customerAddress: "",
  });

  const res = await fetch(`${GB_API_BASE}/gbp/gateway/qrcode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GB Pay QR error ${res.status}: ${text}`);
  }

  // GB Pay returns either JSON or a redirect to a payment page
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  // If it redirected / returned HTML, expose the final URL as paymentUrl
  return { paymentUrl: res.url, status: "pending" };
}

// ---------- GB Pay — Card (Token) ----------
async function createCardPayment(params: {
  orderId: string;
  amount: number;
  customerName: string;
  customerEmail: string;
  description: string;
  cardInfo: {
    name: string;
    number: string;
    expMonth: string; // "01"–"12"
    expYear: string;  // "2025"
    cvv: string;
  };
}) {
  const { cardInfo } = params;

  const body = new URLSearchParams({
    publicKey: GB_PUBLIC_KEY,
    amount: toSatang(params.amount),
    referenceNo: params.orderId,
    backgroundUrl: backgroundUrl(params.orderId),
    responseUrl: `${RETURN_URL}?order_id=${params.orderId}`,
    detail: params.description.slice(0, 255),
    customerName: cardInfo.name || params.customerName || "Customer",
    customerEmail: params.customerEmail || "",
    cardNumber: cardInfo.number.replace(/\s/g, ""),
    cardExpirationMonth: cardInfo.expMonth.padStart(2, "0"),
    cardExpirationYear: cardInfo.expYear,
    cardCVV: cardInfo.cvv,
  });

  const res = await fetch(`${GB_API_BASE}/gbp/gateway/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GB Pay Card error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = await res.json();
    // resultCode "00" = success / approved
    // resultCode "2S" = requires 3-D Secure redirect
    return data;
  }
  // Redirect case (3DS) — return the URL to load in the iframe
  return { paymentUrl: res.url, status: "pending" };
}

// ---------- normalise GB Pay response ----------
function normaliseGbPayResponse(
  raw: Record<string, unknown>,
  orderId: string,
  paymentType: string
): Record<string, unknown> {
  const resultCode = String(raw.resultCode ?? raw.resultcode ?? "");
  const isPaid =
    resultCode === "00" ||
    String(raw.status ?? "").toLowerCase() === "success";

  // 3DS redirect URL
  const redirectUrl =
    (raw.redirectUrl as string) ||
    (raw.redirect_url as string) ||
    (raw.paymentUrl as string) ||
    null;

  return {
    paymentId: raw.gbpReferenceNo || raw.paymentToken || raw.id || null,
    orderId,
    status: isPaid ? "paid" : resultCode === "2S" ? "3ds_required" : "pending",
    resultCode,
    mode: "live",
    paymentType,
    // For QR: qrCodeUrl; for card 3DS: paymentUrl (loaded in iframe)
    qrCodeUrl: (raw.qrCodeUrl as string) || (raw.qr_image_url as string) || null,
    paymentUrl: redirectUrl,
    note: isPaid
      ? "ชำระเงินสำเร็จ"
      : resultCode === "2S"
      ? "กรุณายืนยัน 3-D Secure ในกรอบด้านล่าง"
      : (raw.message as string) || "กำลังรอการยืนยัน",
  };
}

// ---------- mock responses (no credentials) ----------
function mockQrResponse(orderId: string) {
  return {
    paymentId: `mock_${Date.now()}`,
    orderId,
    status: "pending",
    mode: "mock",
    paymentType: "qr",
    qrCodeUrl: null,
    paymentUrl: `${GB_API_BASE}/mock-qr?ref=${orderId}`,
    note: "Mock mode: ยังไม่ได้ตั้งค่า GB_PUBLIC_KEY / GB_SECRET_KEY ใน Edge Function secrets",
  };
}

function mockCardResponse(orderId: string) {
  return {
    paymentId: `mock_card_${Date.now()}`,
    orderId,
    status: "pending",
    mode: "mock",
    paymentType: "card",
    qrCodeUrl: null,
    paymentUrl: null,
    note: "Mock mode: ยังไม่ได้ตั้งค่า GB_PUBLIC_KEY / GB_SECRET_KEY ใน Edge Function secrets",
  };
}

// ---------- main ----------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const payload = await req.json();
    const {
      orderId,
      amount,
      userId,
      customerEmail,
      description,
      receiptInfo,
      items,
      paymentType = "qr", // "qr" | "card"
      cardInfo,
    } = payload as {
      orderId: string;
      amount: number;
      userId: string;
      customerEmail: string;
      description: string;
      receiptInfo?: Record<string, unknown>;
      items?: unknown[];
      paymentType?: string;
      cardInfo?: {
        name: string;
        number: string;
        expMonth: string;
        expYear: string;
        cvv: string;
      };
    };

    if (!orderId || !amount || !userId) {
      return json({ error: "Missing required fields: orderId, amount, userId" }, 400);
    }

    // ── Supabase admin client ──
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Update order with receipt / items metadata
    if (receiptInfo || items) {
      await sb.from("orders").update({ receipt_info: receiptInfo, items }).eq("id", orderId);
    }

    // ── Mock mode ──
    if (isMockMode()) {
      const mock = paymentType === "card"
        ? mockCardResponse(orderId)
        : mockQrResponse(orderId);
      return json(mock);
    }

    // ── Live mode ──
    const customerName =
      (receiptInfo?.name as string) || customerEmail?.split("@")[0] || "Customer";

    let gbRaw: Record<string, unknown>;

    if (paymentType === "card") {
      if (!cardInfo) {
        return json({ error: "cardInfo is required for card payment" }, 400);
      }
      gbRaw = await createCardPayment({
        orderId,
        amount,
        customerName,
        customerEmail,
        description,
        cardInfo,
      });
    } else {
      gbRaw = await createQrPayment({
        orderId,
        amount,
        customerName,
        customerEmail,
        description,
      });
    }

    const result = normaliseGbPayResponse(gbRaw, orderId, paymentType);

    // If already paid (unlikely for card initial call but handle it)
    if (result.status === "paid") {
      await sb.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", orderId);
    }

    return json(result);
  } catch (err) {
    console.error("[create-gbpay-payment]", err);
    return json({ error: (err as Error).message ?? "Internal error" }, 500);
  }
});
