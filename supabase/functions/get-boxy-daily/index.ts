import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DELIVERED = new Set(['delivered', 'partially-delivered']);
const RETURNED  = new Set([
  'returned', 'partially-returned', 'returned-warehouse',
  'returning-origin', 'returning', 'return-requested',
  'cancelled', 'cancel',
]);
// Orders whose status is final and won't change
const IS_FINAL  = new Set([...DELIVERED, ...RETURNED]);

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
  data?: BoxyOrder[];
  object?: { items: BoxyOrder[]; pages: number; total: number };
  pages?: number;
};

function extractOrders(raw: BoxyListResponse): BoxyOrder[] {
  return raw.data ?? raw.object?.items ?? [];
}
function extractPages(raw: BoxyListResponse): number {
  return raw.pages ?? raw.object?.pages ?? 1;
}

function toIraqDate(isoStr: string): string {
  return new Date(new Date(isoStr).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function iraqToday(): string {
  return toIraqDate(new Date().toISOString());
}

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

  const today     = iraqToday();
  const yesterday = toIraqDate(new Date(Date.now() - 86400 * 1000).toISOString());

  // Days that MUST be re-fetched from Boxy (today + yesterday + any day with active orders)
  const mustFetch = (date: string) => date >= yesterday;

  // ── 1. Load cached (final) orders for "old" days ─────────────────────────
  const { data: cachedRows } = await supabase
    .from('boxy_orders')
    .select('uid,platform_code,payment_type,products_value,fee,status_slug,iraq_date,net')
    .gte('iraq_date', from)
    .lte('iraq_date', to)
    .eq('is_final', true);

  // Build set of days fully served from cache (old days that have cached data)
  const cachedByDate: Record<string, typeof cachedRows> = {};
  for (const r of cachedRows ?? []) {
    const d = (r.iraq_date as string).slice(0, 10);
    if (!cachedByDate[d]) cachedByDate[d] = [];
    cachedByDate[d].push(r);
  }

  // ── 2. Determine which days still need Boxy fetch ─────────────────────────
  // Fetch from Boxy if: day is recent (today/yesterday) OR no cache for that day
  // We'll fetch all Boxy pages and filter to only uncached/recent days
  const boxyHeaders = {
    'api-key':    apiKey,
    'api-secret': apiSecret,
    'Accept':     'application/json',
  };

  const MAX_PAGES = 50;
  const perPage   = 100;

  const fetchPage = async (p: number): Promise<BoxyOrder[]> => {
    const res = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/orders?page=${p}&perPage=${perPage}`,
      { headers: boxyHeaders }
    );
    if (!res.ok) return [];
    const raw = await res.json() as BoxyListResponse;
    return extractOrders(raw);
  };

  let freshOrders: BoxyOrder[] = [];
  try {
    const firstRes = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/orders?page=1&perPage=${perPage}`,
      { headers: boxyHeaders }
    );
    if (!firstRes.ok) {
      const errText = await firstRes.text().catch(() => '');
      return json({ error: `Boxy API ${firstRes.status}: ${errText}` }, 502);
    }
    const firstRaw    = await firstRes.json() as BoxyListResponse;
    const totalPages  = Math.min(extractPages(firstRaw), MAX_PAGES);
    const firstBatch  = extractOrders(firstRaw);

    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const remaining = await Promise.all(remainingPages.map(fetchPage));
    const allFromBoxy: BoxyOrder[] = [...firstBatch, ...remaining.flat()];

    // Only keep orders in the requested range that need fresh data
    freshOrders = allFromBoxy.filter(o => {
      const d = toIraqDate(o.created_at);
      return d >= from && d <= to && (mustFetch(d) || !cachedByDate[d]);
    });

    // ── 3. Upsert fresh orders to cache ─────────────────────────────────────
    if (freshOrders.length > 0) {
      const rows = freshOrders.map(o => {
        const d    = toIraqDate(o.created_at);
        const slug = o.status?.slug ?? '';
        const net  = Math.round((o.products_value ?? 0) - (o.fee ?? 0));
        return {
          uid:           o.uid,
          platform_code: o.platform_code ?? '',
          payment_type:  o.payment_type  ?? '',
          products_value: Math.round(o.products_value ?? 0),
          fee:           Math.round(o.fee ?? 0),
          status_slug:   slug,
          iraq_date:     d,
          net,
          // Mark as final if the status is terminal AND the day is fully past
          is_final: IS_FINAL.has(slug) && d < yesterday,
          synced_at: new Date().toISOString(),
        };
      });
      await supabase.from('boxy_orders').upsert(rows, { onConflict: 'uid' });
    }
  } catch (e) {
    // If Boxy fetch fails but we have cache, continue with cached data only
    if (Object.keys(cachedByDate).length === 0) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // ── 4. Merge cached + fresh orders into day buckets ──────────────────────
  type OrderSummary = {
    uid: string;
    platform_code: string;
    status_slug: string;
    net: number;
    payment_type: string;
  };

  type DayEntry = {
    date: string;
    total: number;
    delivered_count: number;
    active_count: number;
    returned_count: number;
    delivered_net: number;
    theoretical_net: number;
    orders: OrderSummary[];
  };

  const byDay: Record<string, DayEntry> = {};

  const processOrder = (
    uid: string, platform_code: string, payment_type: string,
    status_slug: string, net: number, date: string
  ) => {
    if (!byDay[date]) {
      byDay[date] = { date, total: 0, delivered_count: 0, active_count: 0, returned_count: 0, delivered_net: 0, theoretical_net: 0, orders: [] };
    }
    byDay[date].total++;
    byDay[date].orders.push({ uid, platform_code, status_slug, net, payment_type });

    if (DELIVERED.has(status_slug)) {
      byDay[date].delivered_count++;
      byDay[date].delivered_net   += net;
      byDay[date].theoretical_net += net;
    } else if (RETURNED.has(status_slug)) {
      byDay[date].returned_count++;
    } else {
      byDay[date].active_count++;
      byDay[date].theoretical_net += net;
    }
  };

  // Cached old days
  for (const [date, rows] of Object.entries(cachedByDate)) {
    if (mustFetch(date)) continue; // will be covered by fresh data
    for (const r of rows ?? []) {
      processOrder(r.uid, r.platform_code, r.payment_type, r.status_slug, r.net, date);
    }
  }

  // Fresh orders from Boxy
  for (const o of freshOrders) {
    const date = toIraqDate(o.created_at);
    const slug = o.status?.slug ?? '';
    const net  = Math.round((o.products_value ?? 0) - (o.fee ?? 0));
    processOrder(o.uid, o.platform_code ?? '', o.payment_type ?? '', slug, net, date);
  }

  const days = Object.values(byDay)
    .map(d => ({
      ...d,
      delivered_net:   Math.round(d.delivered_net),
      theoretical_net: Math.round(d.theoretical_net),
      orders: d.orders.sort((a, b) => {
        const rank = (s: string) => DELIVERED.has(s) ? 0 : RETURNED.has(s) ? 2 : 1;
        return rank(a.status_slug) - rank(b.status_slug);
      }),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return json({
    days,
    total_orders: days.reduce((s, d) => s + d.total, 0),
    from_cache: Object.keys(cachedByDate).filter(d => !mustFetch(d)).length,
    today,
  });
});
