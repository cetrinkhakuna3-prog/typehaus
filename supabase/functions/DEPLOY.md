# Deploy Edge Functions — TYPEHAUS

## 1. ติดตั้ง Supabase CLI

```bash
brew install supabase/tap/supabase
```

## 2. Login & link project

```bash
supabase login
supabase link --project-ref piivygeapqvhjuppxhuy
```

## 3. ตั้งค่า Secrets (GB Prime Pay credentials)

```bash
supabase secrets set GB_PUBLIC_KEY="your-public-key-here"
supabase secrets set GB_SECRET_KEY="your-secret-key-here"
```

> หา key ได้ที่ GB Prime Pay Dashboard → Settings → API Keys
> ใช้ Sandbox keys สำหรับทดสอบก่อน

## 4. Deploy functions

```bash
# Deploy ทีละ function
supabase functions deploy create-gbpay-payment
supabase functions deploy check-gbpay-payment-status
supabase functions deploy gbpay-webhook

# หรือ deploy ทั้งหมดพร้อมกัน
supabase functions deploy
```

## 5. ทดสอบ (optional)

```bash
# ทดสอบ create payment (mock mode ถ้ายังไม่มี key)
curl -X POST https://piivygeapqvhjuppxhuy.supabase.co/functions/v1/create-gbpay-payment \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"test-001","amount":299,"userId":"test","customerEmail":"test@test.com","description":"Test","paymentType":"qr"}'
```

---

## Flow สรุป

### PromptPay QR
```
Frontend → create-gbpay-payment (paymentType: "qr")
        → GB Pay /qrcode API
        → returns { paymentUrl } (iframe) หรือ { qrCodeUrl }
        → frontend polls check-gbpay-payment-status ทุก 5 วิ
        → GB Pay เรียก gbpay-webhook (backgroundUrl) เมื่อจ่ายแล้ว
        → webhook อัปเดต orders.status = "paid"
        → poll เจอ "paid" → แสดงหน้าสำเร็จ
```

### บัตรเครดิต/เดบิต
```
Frontend → create-gbpay-payment (paymentType: "card", cardInfo: {...})
        → GB Pay /token API
        → ถ้าอนุมัติเลย: status = "paid"
        → ถ้าต้องการ 3DS: returns { paymentUrl } → แสดงใน iframe ให้ user ยืนยัน
        → GB Pay เรียก gbpay-webhook เมื่อเสร็จ
        → poll เจอ "paid" → แสดงหน้าสำเร็จ
```

---

## DB columns ที่ต้องมีใน orders table

| column               | type      | note                          |
|----------------------|-----------|-------------------------------|
| id                   | uuid      | primary key                   |
| user_id              | uuid      |                               |
| font_ids             | uuid[]    |                               |
| total                | numeric   | THB                           |
| status               | text      | pending / paid / failed       |
| paid_at              | timestamptz | filled by webhook            |
| provider_payment_id  | text      | GB Pay reference no           |
| provider_result_code | text      | GB Pay result code            |
| receipt_info         | jsonb     | ใบเสร็จ                        |
| items                | jsonb     | รายการ font + license          |
| created_at           | timestamptz |                             |
