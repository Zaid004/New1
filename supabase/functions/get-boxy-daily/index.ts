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
  'rto-delivered', 'rto-out-for-delivery', 'rto-scheduled', 'rto-warehouse',
]);
const isReturned = (slug: string) => RETURNED.has(slug) || slug.startsWith('rto-');
const IS_FINAL  = (slug: string) => DELIVERED.has(slug) || isReturned(slug);

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

  // Recent days always re-fetched from Boxy
  const mustFetch = (date: string) => date >= yesterday;

  // ── 1. Load ALL cached orders (final + non-final) ────────────────────────────
  const { data: cachedRows } = await supabase
    .from('boxy_orders')
    .select('uid,platform_code,payment_type,products_value,fee,status_slug,iraq_date,net,is_final')
    .gte('iraq_date', from)
    .lte('iraq_date', to);

  // Build per-date map and track dates with any non-final orders
  const cachedByDate: Record<string, typeof cachedRows> = {};
  const hasNonFinal: Record<string, boolean> = {};
  for (const r of cachedRows ?? []) {
    const d = (r.iraq_date as string).slice(0, 10);
    if (!cachedByDate[d]) cachedByDate[d] = [];
    cachedByDate[d].push(r);
    if (!r.is_final) hasNonFinal[d] = true;
  }

  // A date needs Boxy fetch if: recent, OR no cache, OR has non-final cached orders
  const needsBoxy = (date: string) => mustFetch(date) || !cachedByDate[date] || hasNonFinal[date];

  // ── 2. Fetch from Boxy — only recent days (yesterday → tomorrow) for speed ────
  // Older dates are served from cache; non-final old orders show stale status.
  const tomorrow    = toIraqDate(new Date(Date.now() + 86400 * 1000).toISOString());
  const boxyFrom    = yesterday;   // 2 days window: yesterday + today
  const boxyTo      = tomorrow;    // use tomorrow so today's late orders are included

  const boxyHeaders = {
    'api-key':    apiKey,
    'api-secret': apiSecret,
    'Accept':     'application/json',
  };

  const perPage    = 5;
  const SAFETY_CAP = 200; // 200 × 5 = 1000 orders for ~2 days is more than enough

  const dateParams = `&created_from=${boxyFrom}&created_to=${boxyTo}`;
  const baseUrl = `https://api.tryboxy.com/api/v1/merchants/orders?perPage=${perPage}${dateParams}`;

  const fetchPage = async (p: number): Promise<BoxyOrder[]> => {
    const res = await fetch(`${baseUrl}&page=${p}`, { headers: boxyHeaders });
    if (!res.ok) return [];
    const raw = await res.json() as BoxyListResponse;
    return extractOrders(raw);
  };

  let freshOrders: BoxyOrder[] = [];
  try {
    const firstRes = await fetch(`${baseUrl}&page=1`, { headers: boxyHeaders });
    if (!firstRes.ok) {
      const errText = await firstRes.text().catch(() => '');
      // Fall back to cache if available
      if (Object.keys(cachedByDate).length === 0) {
        return json({ error: `Boxy API ${firstRes.status}: ${errText}` }, 502);
      }
    } else {
      const firstRaw   = await firstRes.json() as BoxyListResponse;
      const totalPages = Math.min(extractPages(firstRaw), SAFETY_CAP);
      const firstBatch = extractOrders(firstRaw);

      // Fetch remaining pages in batches of 100
      const remainingNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const allFromBoxy: BoxyOrder[] = [...firstBatch];
      const BATCH = 100;
      for (let i = 0; i < remainingNums.length; i += BATCH) {
        const batch = remainingNums.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(fetchPage));
        allFromBoxy.push(...results.flat());
      }

      // Keep only orders that need fresh data
      freshOrders = allFromBoxy.filter(o => {
        const d = toIraqDate(o.created_at);
        return d >= from && d <= to && needsBoxy(d);
      });

      // ── 3. Upsert fresh orders to cache ───────────────────────────────────────
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
            // Final = terminal status AND day is fully past
            is_final: IS_FINAL(slug) && d < yesterday,
            synced_at: new Date().toISOString(),
          };
        });
        await supabase.from('boxy_orders').upsert(rows, { onConflict: 'uid' });
      }
    }
  } catch (e) {
    if (Object.keys(cachedByDate).length === 0) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // ── 4. Merge cached + fresh orders into day buckets ──────────────────────────
  type OrderSummary = {
    uid: string;
    platform_code: string;
    status_slug: string;
    net: number;
    fee: number;
    payment_type: string;
  };

  type DayEntry = {
    date: string;
    total: number;
    delivered_count: number;
    active_count: number;
    returned_count: number;
    delivered_net: number;
    active_net: number;      // current financial position of active orders
    theoretical_net: number; // if all active orders are delivered
    orders: OrderSummary[];
  };

  const byDay: Record<string, DayEntry> = {};
  const seenUids = new Set<string>();

  const processOrder = (
    uid: string, platform_code: string, payment_type: string,
    status_slug: string, net: number, fee: number, date: string
  ) => {
    if (seenUids.has(uid)) return;
    seenUids.add(uid);

    if (!byDay[date]) {
      byDay[date] = { date, total: 0, delivered_count: 0, active_count: 0, returned_count: 0, delivered_net: 0, active_net: 0, theoretical_net: 0, orders: [] };
    }
    byDay[date].total++;
    byDay[date].orders.push({ uid, platform_code, status_slug, net, fee, payment_type });

    if (DELIVERED.has(status_slug)) {
      byDay[date].delivered_count++;
      byDay[date].delivered_net   += net;
      byDay[date].theoretical_net += net;
    } else if (isReturned(status_slug)) {
      byDay[date].returned_count++;
    } else {
      byDay[date].active_count++;
      byDay[date].theoretical_net += net;
      const isCod = payment_type.toLowerCase() !== 'prepaid';
      byDay[date].active_net += isCod ? net : -fee;
    }
  };

  // Fresh orders first (most up-to-date)
  for (const o of freshOrders) {
    const date = toIraqDate(o.created_at);
    const slug = o.status?.slug ?? '';
    const fee  = Math.round(o.fee ?? 0);
    const net  = Math.round((o.products_value ?? 0) - fee);
    processOrder(o.uid, o.platform_code ?? '', o.payment_type ?? '', slug, net, fee, date);
  }

  // Cached orders for days outside the Boxy fetch window (older dates)
  for (const [date, rows] of Object.entries(cachedByDate)) {
    if (date >= boxyFrom) continue; // covered by fresh Boxy data
    for (const r of rows ?? []) {
      processOrder(r.uid, r.platform_code, r.payment_type, r.status_slug, r.net, r.fee ?? 0, date);
    }
  }

  const days = Object.values(byDay)
    .map(d => ({
      ...d,
      delivered_net:   Math.round(d.delivered_net),
      active_net:      Math.round(d.active_net),
      theoretical_net: Math.round(d.theoretical_net),
      orders: d.orders.sort((a, b) => {
        const rank = (s: string) => DELIVERED.has(s) ? 0 : isReturned(s) ? 2 : 1;
        return rank(a.status_slug) - rank(b.status_slug);
      }),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return json({
    days,
    total_orders: days.reduce((s, d) => s + d.total, 0),
    from_cache: Object.keys(cachedByDate).filter(d => !needsBoxy(d)).length,
    today,
  });
});
