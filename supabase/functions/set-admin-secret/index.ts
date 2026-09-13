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

  const body = await req.json().catch(() => ({}));
  const { key, value } = body as { key?: string; value?: string };
  if (!key || value === undefined) return json({ error: 'key و value مطلوبان' }, 400);

  const { error } = await supabase
    .from('admin_secrets')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
});
