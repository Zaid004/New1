import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

  const { data: emp } = await supabase
    .from('employees')
    .select('role')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (emp?.role !== 'admin') return json({ error: 'يحتاج صلاحية أدمن' }, 403);

  const { data: secrets } = await supabase
    .from('admin_secrets')
    .select('key, value')
    .in('key', ['BOXY_API_KEY', 'BOXY_API_SECRET']);

  const secretMap: Record<string, string> = {};
  for (const s of secrets ?? []) secretMap[s.key] = s.value;

  const apiKey    = secretMap['BOXY_API_KEY']    ?? Deno.env.get('BOXY_API_KEY');
  const apiSecret = secretMap['BOXY_API_SECRET'] ?? Deno.env.get('BOXY_API_SECRET');

  if (!apiKey || !apiSecret) {
    return json({ error: 'لم يتم ضبط مفاتيح Boxy API بعد', setup_needed: true }, 500);
  }

  const headers = {
    'api-key':    apiKey,
    'api-secret': apiSecret,
    'Accept':     'application/json',
  };

  try {
    // 1. Fetch orders page 1 — extract all unique status slugs
    const ordersRes = await fetch(
      'https://api.tryboxy.com/api/v1/merchants/orders?page=1&perPage=100',
      { headers }
    );
    const ordersRaw = ordersRes.ok ? await ordersRes.json().catch(() => null) : null;
    const orders: {status?:{slug?:string};platform_code?:string}[] =
      ordersRaw?.data ?? ordersRaw?.object?.items ?? [];
    const orderStatusSlugs = [...new Set(orders.map((o) => o.status?.slug).filter(Boolean))];
    const orderStatusCounts: Record<string, number> = {};
    for (const o of orders) {
      const slug = o.status?.slug ?? 'unknown';
      orderStatusCounts[slug] = (orderStatusCounts[slug] ?? 0) + 1;
    }

    // 2. Fetch orders page 2 as well to get more status variety
    const orders2Res = await fetch(
      'https://api.tryboxy.com/api/v1/merchants/orders?page=2&perPage=100',
      { headers }
    );
    const orders2Raw = orders2Res.ok ? await orders2Res.json().catch(() => null) : null;
    const orders2: {status?:{slug?:string}}[] =
      orders2Raw?.data ?? orders2Raw?.object?.items ?? [];
    for (const o of orders2) {
      const slug = o.status?.slug ?? 'unknown';
      orderStatusCounts[slug] = (orderStatusCounts[slug] ?? 0) + 1;
      if (!orderStatusSlugs.includes(slug ?? '')) orderStatusSlugs.push(slug ?? '');
    }

    // 3. Test date filtering on transactions API — try "created_from/created_to"
    const today   = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

    const txDateRes = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/transactions?page=1&perPage=5&created_from=${monthAgo}&created_to=${today}`,
      { headers }
    );
    const txDateRaw = txDateRes.ok ? await txDateRes.json().catch(() => null) : null;

    // 4. Test with "from_date/to_date"
    const txDateRes2 = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/transactions?page=1&perPage=5&from_date=${monthAgo}&to_date=${today}`,
      { headers }
    );
    const txDateRaw2 = txDateRes2.ok ? await txDateRes2.json().catch(() => null) : null;

    // 5. Transactions without date filter — get total pages count
    const txAllRes = await fetch(
      'https://api.tryboxy.com/api/v1/merchants/transactions?page=1&perPage=100',
      { headers }
    );
    const txAllRaw = txAllRes.ok ? await txAllRes.json().catch(() => null) : null;
    const totalTxPages = txAllRaw?.object?.pages ?? null;
    const totalTxCount = txAllRaw?.object?.total ?? null;

    return json({
      // Order status slugs seen across first 200 orders
      order_status_slugs: orderStatusSlugs,
      order_status_counts: orderStatusCounts,

      // Transaction total count
      tx_total_count: totalTxCount,
      tx_total_pages: totalTxPages,

      // Date filter test 1: created_from / created_to
      date_filter_created: {
        status: txDateRes.status,
        total: txDateRaw?.object?.total ?? null,
        pages: txDateRaw?.object?.pages ?? null,
        sample_count: (txDateRaw?.object?.items ?? []).length,
        first_item_date: txDateRaw?.object?.items?.[0]?.created_at ?? null,
        last_item_date: txDateRaw?.object?.items?.at(-1)?.created_at ?? null,
      },

      // Date filter test 2: from_date / to_date
      date_filter_from_date: {
        status: txDateRes2.status,
        total: txDateRaw2?.object?.total ?? null,
        pages: txDateRaw2?.object?.pages ?? null,
        sample_count: (txDateRaw2?.object?.items ?? []).length,
        first_item_date: txDateRaw2?.object?.items?.[0]?.created_at ?? null,
        last_item_date: txDateRaw2?.object?.items?.at(-1)?.created_at ?? null,
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
