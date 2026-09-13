import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DELIVERED = new Set(['delivered', 'partially-delivered']);
const RETURNED  = new Set(['returned', 'partially-returned', 'returned-warehouse', 'returning-origin']);

type BoxyOrder = {
  uid: string;
  platform_code: string;
  payment_type: string;
  products_value: number;
  fee: number;
  status: { slug: string };
  created_at: string;
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json({ error: 'غير مصرح' }, 401);

  const { data: secrets } = await supabase
    .from('admin_secrets')
    .select('key, value')
    .in('key', ['BOXY_API_KEY', 'BOXY_API_SECRET']);

  const secretMap: Record<string, string> = {};
  for (const s of secrets ?? []) secretMap[s.key] = s.value;

  const apiKey    = secretMap['BOXY_API_KEY']    ?? Deno.env.get('BOXY_API_KEY');
  const apiSecret = secretMap['BOXY_API_SECRET'] ?? Deno.env.get('BOXY_API_SECRET');

  if (!apiKey || !apiSecret) {
    return json({ error: 'مفاتيح Boxy غير مضبوطة', setup_needed: true }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const { from, to } = body as { from: string; to: string };
  if (!from || !to) return json({ error: 'from و to مطلوبان' }, 400);

  const boxyHeaders = {
    'api-key':    apiKey,
    'api-secret': apiSecret,
    'Accept':     'application/json',
  };

  const allOrders: BoxyOrder[] = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const params = new URLSearchParams({
        page: String(page), perPage: String(perPage),
        date_from: from, date_to: to,
      });
      const res = await fetch(
        `https://api.tryboxy.com/api/v1/merchants/orders?${params}`,
        { headers: boxyHeaders }
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return json({ error: `Boxy API ${res.status}: ${errText}` }, 502);
      }
      const raw = await res.json() as BoxyListResponse;
      const batch = raw.data ?? [];
      allOrders.push(...batch);
      if (page >= (raw.pages ?? 1) || batch.length === 0) break;
      page++;
    }

    // Group by Iraq day (UTC+3)
    type DayEntry = {
      date: string;
      total: number;
      delivered_count: number;
      active_count: number;
      returned_count: number;
      delivered_net: number;   // actual net from delivered orders
      theoretical_net: number; // net if ALL orders were delivered
    };

    const byDay: Record<string, DayEntry> = {};

    for (const o of allOrders) {
      // Shift to Iraq UTC+3
      const iqDate = new Date(new Date(o.created_at).getTime() + 3 * 3600 * 1000);
      const date = iqDate.toISOString().slice(0, 10);

      if (!byDay[date]) {
        byDay[date] = { date, total: 0, delivered_count: 0, active_count: 0, returned_count: 0, delivered_net: 0, theoretical_net: 0 };
      }

      const slug = o.status?.slug ?? '';
      const net  = (o.products_value ?? 0) - (o.fee ?? 0);

      byDay[date].total++;
      byDay[date].theoretical_net += net;

      if (DELIVERED.has(slug)) {
        byDay[date].delivered_count++;
        byDay[date].delivered_net += net;
      } else if (RETURNED.has(slug)) {
        byDay[date].returned_count++;
      } else {
        byDay[date].active_count++;
      }
    }

    const days = Object.values(byDay)
      .map(d => ({
        ...d,
        delivered_net:   Math.round(d.delivered_net),
        theoretical_net: Math.round(d.theoretical_net),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return json({ days, total_orders: allOrders.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
