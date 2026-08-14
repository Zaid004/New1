const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // Verify user
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json({ error: 'غير مصرح' }, 401);

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId   = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) return json({ error: 'Telegram secrets غير مضبوطة' }, 500);

  const body = await req.json().catch(() => ({})) as Record<string, string>;

  try {
    // ── Photo mode ───────────────────────────────────────────
    if (body.type === 'photo') {
      if (!body.data) return json({ error: 'data مطلوب' }, 400);

      const binary = Uint8Array.from(atob(body.data), c => c.charCodeAt(0));
      const blob   = new Blob([binary], { type: 'image/jpeg' });

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo',   blob, 'store.jpg');
      if (body.caption) {
        form.append('caption',    body.caption);
        form.append('parse_mode', 'HTML');
      }

      const res  = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body:   form,
      });
      const data = await res.json() as { ok: boolean; description?: string };
      if (!data.ok) return json({ error: data.description }, 502);
      return json({ success: true });
    }

    // ── Text mode (default) ──────────────────────────────────
    const { message } = body;
    if (!message) return json({ error: 'message مطلوب' }, 400);

    const res  = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) return json({ error: data.description }, 502);
    return json({ success: true });

  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
