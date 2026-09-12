import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type BoxyOrder = {
  uid: string;
  platform_code: string;
  payment_type: string;
  products_value: number;
  fee: number;
  shipment_fee_type: string;
  status: { slug: string; label?: string };
  created_at: string;
  updated_at: string;
};

type BoxyListResponse = {
  data: BoxyOrder[];
  total: number;
  pages: number;
  page: number;
  perPage: number;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // ── Verify user ────────────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json({ error: 'غير مصرح' }, 401);

  // ── Boxy credentials ───────────────────────────────────────────────────────
  const apiKey    = Deno.env.get('BOXY_API_KEY');
  const apiSecret = Deno.env.get('BOXY_API_SECRET');
  if (!apiKey || !apiSecret) {
    return json({
      error: 'BOXY_API_KEY أو BOXY_API_SECRET غير مضبوط في Supabase Secrets',
      setup_needed: true,
    }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const { from, to } = body as { from: string; to: string };
  if (!from || !to) return json({ error: 'from و to مطلوبان بصيغة YYYY-MM-DD' }, 400);

  const allOrders: BoxyOrder[] = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const params = new URLSearchParams({
        page:      String(page),
        perPage:   String(perPage),
        date_from: from,
        date_to:   to,
      });

      const res = await fetch(
        `https://api.tryboxy.com/api/v1/merchants/orders?${params}`,
        {
          headers: {
            'api-key':    apiKey,
            'api-secret': apiSecret,
            'Accept':     'application/json',
          },
        },
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let errMsg = `Boxy API ${res.status}`;
        try { errMsg = (JSON.parse(errBody) as { message?: string }).message ?? errMsg; } catch { /* */ }
        return json({ error: errMsg }, 502);
      }

      const data = await res.json() as BoxyListResponse;
      const batch = data.data ?? [];
      allOrders.push(...batch);

      if (page >= (data.pages ?? 1) || batch.length === 0) break;
      page++;
    }

    // ── Build summary ──────────────────────────────────────────────────────
    const byStatus: Record<string, { count: number; total: number; fees: number }> = {};
    const byPaymentType: Record<string, { count: number; total: number; fees: number }> = {};

    for (const o of allOrders) {
      const slug = o.status?.slug ?? 'unknown';
      const pt   = o.payment_type ?? 'unknown';
      const pv   = o.products_value ?? 0;
      const fee  = o.fee ?? 0;

      if (!byStatus[slug])      byStatus[slug]      = { count: 0, total: 0, fees: 0 };
      if (!byPaymentType[pt])   byPaymentType[pt]   = { count: 0, total: 0, fees: 0 };

      byStatus[slug].count++;
      byStatus[slug].total += pv;
      byStatus[slug].fees  += fee;

      byPaymentType[pt].count++;
      byPaymentType[pt].total += pv;
      byPaymentType[pt].fees  += fee;
    }

    // Round totals
    for (const k of Object.keys(byStatus))      { byStatus[k].total = Math.round(byStatus[k].total); byStatus[k].fees = Math.round(byStatus[k].fees); }
    for (const k of Object.keys(byPaymentType)) { byPaymentType[k].total = Math.round(byPaymentType[k].total); byPaymentType[k].fees = Math.round(byPaymentType[k].fees); }

    return json({
      total_orders: allOrders.length,
      by_status:       byStatus,
      by_payment_type: byPaymentType,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
