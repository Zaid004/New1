import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // ── Verify admin ───────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json({ error: 'غير مصرح' }, 401);

  const { data: caller } = await supabase
    .from('employees').select('role').eq('auth_user_id', user.id).maybeSingle();
  if (caller?.role !== 'admin') return json({ error: 'للمدير فقط' }, 403);

  // ── Loyverse token ─────────────────────────────────────────
  const loyToken = Deno.env.get('LOYVERSE_TOKEN');
  if (!loyToken) return json({ error: 'LOYVERSE_TOKEN غير مضبوط في Supabase Secrets' }, 500);

  // ── Parse month ────────────────────────────────────────────
  const body = await req.json().catch(() => ({}));
  const { month } = body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return json({ error: 'month مطلوب بصيغة YYYY-MM' }, 400);
  }

  const [y, m] = month.split('-');
  const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
  const from = `${y}-${m}-01T00:00:00.000Z`;
  const to   = `${y}-${m}-${String(lastDay).padStart(2, '0')}T23:59:59.000Z`;

  // ── Fetch from Loyverse (paginated) ────────────────────────
  let salesTotal    = 0;  // sum of SALE total_money
  let discountTotal = 0;  // sum of |SALE total_discounts|
  let refundTotal   = 0;  // sum of |REFUND total_money|
  let cursor: string | null = null;
  let firstReceipt: unknown = null;

  try {
    do {
      const params = new URLSearchParams({
        created_at_min: from,
        created_at_max: to,
        limit: '250',
      });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`https://api.loyverse.com/v1.0/receipts?${params}`, {
        headers: { Authorization: `Bearer ${loyToken}` },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return json(
          { error: (err as { errors?: { message: string }[] })?.errors?.[0]?.message ?? `Loyverse ${res.status}` },
          502,
        );
      }

      const data = await res.json() as {
        receipts: { total_money: number; total_discounts: number; receipt_type: string }[];
        cursor?: string;
      };

      for (const r of data.receipts ?? []) {
        if (!firstReceipt) {
          firstReceipt = { type: r.receipt_type, total_money: r.total_money, total_discounts: r.total_discounts };
          console.log('first receipt:', JSON.stringify(firstReceipt));
        }
        if (r.receipt_type === 'SALE') {
          salesTotal    += r.total_money ?? 0;
          discountTotal += Math.abs(r.total_discounts ?? 0);
        } else if (r.receipt_type === 'REFUND') {
          refundTotal   += Math.abs(r.total_money ?? 0);
        }
      }
      cursor = data.cursor ?? null;

    } while (cursor);

    // net = salesTotal - discountTotal - refundTotal
    // (if total_money is gross before discounts)
    const net = Math.round(salesTotal - discountTotal - refundTotal);

    return json({
      total:     net,
      sales:     Math.round(salesTotal),
      discounts: Math.round(discountTotal),
      refunds:   Math.round(refundTotal),
    });

  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
