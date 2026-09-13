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

  // Read credentials from admin_secrets
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
    // Fetch first order to see all available fields
    const orderRes = await fetch(
      'https://api.tryboxy.com/api/v1/merchants/orders?page=1&perPage=1',
      { headers }
    );
    const orderData = orderRes.ok ? await orderRes.json().catch(() => null) : null;
    const firstOrder = orderData?.data?.[0] ?? null;

    // Fetch first few transactions to understand the structure
    const txRes = await fetch(
      'https://api.tryboxy.com/api/v1/merchants/transactions?page=1&perPage=5',
      { headers }
    );
    const txData = txRes.ok ? await txRes.json().catch(() => null) : null;

    // Probe extra financial endpoints
    const probeEndpoints = async (path: string) => {
      const r = await fetch(`https://api.tryboxy.com/api/v1/merchants/${path}`, { headers });
      return { status: r.status };
    };

    const [wallet, balance, payouts, settlements] = await Promise.all([
      probeEndpoints('wallet'),
      probeEndpoints('balance'),
      probeEndpoints('payouts'),
      probeEndpoints('settlements'),
    ]);

    return json({
      first_order: firstOrder,
      transactions: {
        status: txRes.status,
        data: txData,
      },
      extra_endpoints: {
        wallet,
        balance,
        payouts,
        settlements,
        'transactions': { status: txRes.status },
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
