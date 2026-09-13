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
  const MAX_PAGES = 50;

  const fetchPage = async (p: number): Promise<TxItem[]> => {
    const res = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/transactions?page=${p}&perPage=${perPage}`,
      { headers: boxyHeaders }
    );
    if (!res.ok) return [];
    const raw = await res.json() as TxPage;
    return raw.object?.items ?? [];
  };

  try {
    const firstRes = await fetch(
      `https://api.tryboxy.com/api/v1/merchants/transactions?page=1&perPage=${perPage}`,
      { headers: boxyHeaders }
    );
    if (!firstRes.ok) {
      const errText = await firstRes.text().catch(() => '');
      return json({ error: `Boxy API ${firstRes.status}: ${errText}` }, 502);
    }
    const firstRaw = await firstRes.json() as TxPage;
    const totalPages = Math.min(firstRaw.object?.pages ?? 1, MAX_PAGES);
    const firstItems = firstRaw.object?.items ?? [];

    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const remaining = await Promise.all(remainingPages.map(fetchPage));

    const allTxRaw: TxItem[] = [...firstItems, ...remaining.flat()];
    const allTx = (from || to)
      ? allTxRaw.filter(tx => {
          if (!tx.created_at) return true;
          const d = tx.created_at.slice(0, 10);
          return (!from || d >= from) && (!to || d <= to);
        })
      : allTxRaw;

    type TxSummary = {
      uid: string;
      amount: number;
      type: string;
      subject: string;
      created_at: string;
    };

    type OrderEntry = {
      uid: string;
      order_platform_code: string;
      payment_type: string;
      net: number;
      status: string;
      created_at: string;
      tx_count: number;
      transactions: TxSummary[];
    };

    const byOrder: Record<string, OrderEntry> = {};

    for (const tx of allTx) {
      const oid = tx.order_uid;
      if (!oid) continue;
      if (!byOrder[oid]) {
        byOrder[oid] = {
          uid: oid,
          order_platform_code: tx.order_platform_code ?? '',
          payment_type: tx.item?.payment_type ?? 'unknown',
          net: 0,
          status: 'pending',
          created_at: tx.created_at,
          tx_count: 0,
          transactions: [],
        };
      }
      byOrder[oid].net += tx.amount;
      byOrder[oid].tx_count++;
      byOrder[oid].transactions.push({
        uid:        tx.uid,
        amount:     tx.amount,
        type:       tx.type    ?? '',
        subject:    tx.subject ?? '',
        created_at: tx.created_at,
      });
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

    // Boxy transaction statuses: pending=قيد التدقيق, available=متوفرة للسحب, paid=مدفوعة
    const sortDesc = (arr: typeof allOrders) => arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const pending   = allOrders.filter(o => o.status === 'pending');
    const available = allOrders.filter(o => o.status === 'available');
    const paid      = allOrders.filter(o => o.status === 'paid');
    const other     = allOrders.filter(o => !['pending','available','paid'].includes(o.status));

    const realTotal = firstRaw.object?.total ?? allTxRaw.length;
    return json({
      total_transactions: allTx.length,
      real_total: realTotal,
      truncated: (firstRaw.object?.pages ?? 1) > MAX_PAGES,
      pending: {
        count:   pending.length,
        balance: Math.round(pending.reduce((s, o) => s + o.net, 0)),
        orders:  sortDesc(pending),
      },
      available: {
        count:   available.length,
        balance: Math.round(available.reduce((s, o) => s + o.net, 0)),
        orders:  sortDesc(available),
      },
      paid: {
        count:  paid.length,
        total:  Math.round(paid.reduce((s, o) => s + o.net, 0)),
        orders: sortDesc(paid),
      },
      other: {
        count:  other.length,
        total:  Math.round(other.reduce((s, o) => s + o.net, 0)),
        statuses: [...new Set(other.map(o => o.status))],
        orders: sortDesc(other),
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
