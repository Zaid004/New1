import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type TxItem = {
  uid: string;
  amount: number;
  type: string;
  subject: string;
  order_uid: string;
  order_platform_code: string;
  status: { slug: string };
  item?: { payment_type?: string };
  created_at: string;
};

type TxPage = {
  object?: {
    items: TxItem[];
    pages: number;
    total: number;
  };
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
  const { from, to } = body as { from?: string; to?: string };

  const boxyHeaders = {
    'api-key':    apiKey,
    'api-secret': apiSecret,
    'Accept':     'application/json',
  };

  const perPage = 100;
  const MAX_PAGES = 10; // max 1000 transactions per call

  const fetchPage = async (p: number): Promise<TxItem[]> => {
    const params = new URLSearchParams({ page: String(p), perPage: String(perPage) });
    if (from) params.set('date_from', from);
    if (to)   params.set('date_to',   to);
    const res = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/transactions?${params}`,
      { headers: boxyHeaders }
    );
    if (!res.ok) return [];
    const raw = await res.json() as TxPage;
    return raw.object?.items ?? [];
  };

  try {
    // Fetch page 1 first to learn total pages
    const firstParams = new URLSearchParams({ page: '1', perPage: String(perPage) });
    if (from) firstParams.set('date_from', from);
    if (to)   firstParams.set('date_to',   to);
    const firstRes = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/transactions?${firstParams}`,
      { headers: boxyHeaders }
    );
    if (!firstRes.ok) {
      const errText = await firstRes.text().catch(() => '');
      return json({ error: `Boxy API ${firstRes.status}: ${errText}` }, 502);
    }
    const firstRaw = await firstRes.json() as TxPage;
    const totalPages = Math.min(firstRaw.object?.pages ?? 1, MAX_PAGES);
    const firstItems = firstRaw.object?.items ?? [];

    // Fetch remaining pages in parallel
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const remaining = await Promise.all(remainingPages.map(fetchPage));

    const allTx: TxItem[] = [...firstItems, ...remaining.flat()];

    // Group transactions by order_uid
    type OrderEntry = {
      order_platform_code: string;
      payment_type: string;
      net: number;
      status: string;
      created_at: string;
      tx_count: number;
    };

    const byOrder: Record<string, OrderEntry> = {};

    for (const tx of allTx) {
      const oid = tx.order_uid;
      if (!oid) continue;
      if (!byOrder[oid]) {
        byOrder[oid] = {
          order_platform_code: tx.order_platform_code ?? '',
          payment_type: tx.item?.payment_type ?? 'unknown',
          net: 0,
          status: 'pending',
          created_at: tx.created_at,
          tx_count: 0,
        };
      }
      byOrder[oid].net += tx.amount;
      byOrder[oid].tx_count++;
      if (tx.status?.slug && tx.status.slug !== 'pending') {
        byOrder[oid].status = tx.status.slug;
      }
      if (tx.created_at > byOrder[oid].created_at) {
        byOrder[oid].created_at = tx.created_at;
      }
    }

    const allOrders = Object.values(byOrder).map(o => ({
      ...o,
      net: Math.round(o.net),
    }));

    const pending = allOrders.filter(o => o.status === 'pending');
    const settled = allOrders.filter(o => o.status !== 'pending');

    const realTotal = firstRaw.object?.total ?? allTx.length;
    return json({
      total_transactions: allTx.length,
      real_total: realTotal,
      truncated: (firstRaw.object?.pages ?? 1) > MAX_PAGES,
      pending: {
        count:   pending.length,
        balance: Math.round(pending.reduce((s, o) => s + o.net, 0)),
        orders:  pending.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      },
      settled: {
        count:  settled.length,
        total:  Math.round(settled.reduce((s, o) => s + o.net, 0)),
        orders: settled.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
