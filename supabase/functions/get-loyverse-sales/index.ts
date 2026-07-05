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

  // ── Verify user ────────────────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json({ error: 'غير مصرح' }, 401);

  // ── Loyverse token ─────────────────────────────────────────────────────────
  const loyToken = Deno.env.get('LOYVERSE_TOKEN');
  if (!loyToken) return json({ error: 'LOYVERSE_TOKEN غير مضبوط في Supabase Secrets' }, 500);

  const body = await req.json().catch(() => ({}));
  const { mode } = body;

  // ── MODE: delivery reconciliation (custom range) ───────────────────────────
  if (mode === 'delivery') {
    const { from, to } = body;
    if (!from || !to) return json({ error: 'from و to مطلوبان' }, 400);

    let deliveryTotal = 0;
    let deliveryOrders = 0;
    let cursor: string | null = null;

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
          receipts: {
            total_money: number;
            receipt_type: string;
            payments: { name: string; money_amount: number }[];
          }[];
          cursor?: string;
        };

        for (const r of data.receipts ?? []) {
          const isDelivery = r.payments?.some(p => p.name?.includes('توصيل'));
          if (!isDelivery) continue;
          if (r.receipt_type === 'SALE') {
            deliveryTotal += r.total_money ?? 0;
            deliveryOrders++;
          } else if (r.receipt_type === 'REFUND') {
            deliveryTotal -= Math.abs(r.total_money ?? 0);
          }
        }
        cursor = data.cursor ?? null;
      } while (cursor);

      return json({ total: Math.round(deliveryTotal), orders: deliveryOrders });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // ── MODE: delivery bonus stats per POS device ─────────────────────────────
  if (mode === 'delivery_stats') {
    const { from, to, payment_filters = [] } = body as {
      from: string; to: string; payment_filters: string[];
    };
    if (!from || !to) return json({ error: 'from و to مطلوبان' }, 400);

    const DEVICE_EMP: Record<string, string> = {
      'Mustafa': 'مصطفى هشام',
      'Janah': 'محمد جناح',
    };
    const BONUS_PER_ORDER = 400;

    // 1. Resolve POS device IDs → employee display names
    const deviceNameMap: Record<string, string> = {};
    try {
      const devRes = await fetch('https://api.loyverse.com/v1.0/pos_devices?limit=50', {
        headers: { Authorization: `Bearer ${loyToken}` },
      });
      if (devRes.ok) {
        const devData = await devRes.json() as { pos_devices?: { id: string; name: string }[] };
        for (const d of devData.pos_devices ?? []) {
          deviceNameMap[d.id] = DEVICE_EMP[d.name] ?? d.name;
        }
      }
    } catch { /* will fall back to raw device IDs */ }

    // 2. Fetch receipts and aggregate
    type DevStat = { employee: string; orders: number; sales_total: number };
    const stats: Record<string, DevStat> = {};
    let cursor: string | null = null;

    try {
      do {
        const params = new URLSearchParams({ created_at_min: from, created_at_max: to, limit: '250' });
        if (cursor) params.set('cursor', cursor);

        const res = await fetch(`https://api.loyverse.com/v1.0/receipts?${params}`, {
          headers: { Authorization: `Bearer ${loyToken}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return json({ error: (err as { errors?: { message: string }[] })?.errors?.[0]?.message ?? `Loyverse ${res.status}` }, 502);
        }

        const data = await res.json() as {
          receipts: {
            total_money: number;
            receipt_type: string;
            pos_device_id: string;
            payments: { name: string; money_amount: number }[];
          }[];
          cursor?: string;
        };

        for (const r of data.receipts ?? []) {
          if (r.receipt_type !== 'SALE') continue;
          const filters = payment_filters as string[];
          const matched = filters.length === 0
            || r.payments?.some(p => filters.some(f => p.name?.includes(f)));
          if (!matched) continue;

          const devId = r.pos_device_id ?? 'unknown';
          if (!stats[devId]) {
            stats[devId] = {
              employee: deviceNameMap[devId] ?? devId,
              orders: 0,
              sales_total: 0,
            };
          }
          stats[devId].orders++;
          stats[devId].sales_total += r.total_money ?? 0;
        }
        cursor = data.cursor ?? null;
      } while (cursor);

      const result = Object.values(stats).map(s => ({
        employee: s.employee,
        orders: s.orders,
        sales_total: Math.round(s.sales_total),
        bonus: s.orders * BONUS_PER_ORDER,
      }));
      const totalOrders = result.reduce((s, r) => s + r.orders, 0);
      const totalBonus  = result.reduce((s, r) => s + r.bonus,  0);

      return json({ stats: result, total_orders: totalOrders, total_bonus: totalBonus, bonus_per_order: BONUS_PER_ORDER });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // ── MODE: monthly sales (default) ──────────────────────────────────────────
  const { month } = body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return json({ error: 'month مطلوب بصيغة YYYY-MM' }, 400);
  }

  const [y, m] = month.split('-');
  const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();

  // Iraq is UTC+3 — boundaries in local Iraq time so no sales are missed
  const from = new Date(`${y}-${m}-01T00:00:00.000+03:00`).toISOString();
  const to   = new Date(`${y}-${m}-${String(lastDay).padStart(2, '0')}T23:59:59.999+03:00`).toISOString();

  // total_money on each SALE receipt = what the customer actually paid (already net of any
  // discount, whether stored as an explicit discount or a price override).
  let salesTotal  = 0;
  let refundTotal = 0;
  let cursor: string | null = null;

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
        receipts: { total_money: number; receipt_type: string }[];
        cursor?: string;
      };

      for (const r of data.receipts ?? []) {
        if (r.receipt_type === 'SALE')        salesTotal  += r.total_money ?? 0;
        else if (r.receipt_type === 'REFUND') refundTotal += Math.abs(r.total_money ?? 0);
      }
      cursor = data.cursor ?? null;
    } while (cursor);

    return json({ total: Math.round(salesTotal - refundTotal) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
