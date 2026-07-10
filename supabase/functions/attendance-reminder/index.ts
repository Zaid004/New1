import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Today in Iraq time (UTC+3)
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [{ data: employees }, { data: attendance }] = await Promise.all([
    supabase.from('employees').select('id, name').order('name'),
    supabase.from('attendance').select('employee_id').eq('date', today),
  ]);

  const presentIds = new Set((attendance ?? []).map((a: { employee_id: string }) => a.employee_id));
  const absent = (employees ?? []).filter((e: { id: string; name: string }) => !presentIds.has(e.id));

  if (absent.length === 0) {
    return json({ message: 'جميع الموظفين سجلوا حضورهم' });
  }

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId   = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) return json({ error: 'Telegram secrets غير مضبوطة' }, 500);

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⏰ عيني شباب شوكت تسجلون حضور؟`,
        parse_mode: 'HTML',
      }),
    });
    return json({ success: true, absent: absent.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
