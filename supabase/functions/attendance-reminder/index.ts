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

  // Load notification settings
  const { data: settings } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (!settings?.reminder_enabled) {
    return json({ message: 'التذكير موقف' });
  }

  // Current Iraq time (UTC+3)
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const currentDay     = now.getUTCDay();   // 0=Sun … 6=Sat
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Check working day
  const reminderDays: number[] = settings.reminder_days ?? [0, 1, 2, 3, 4, 5];
  if (!reminderDays.includes(currentDay)) {
    return json({ message: 'ليس يوم عمل' });
  }

  // Check if current time falls in any 5-minute reminder window
  const reminderTimes: string[] = settings.reminder_times ?? ['12:00'];
  const timeMatched = reminderTimes.some(t => {
    const [h, m] = t.split(':').map(Number);
    const tMin = h * 60 + m;
    return currentMinutes >= tMin && currentMinutes < tMin + 5;
  });

  if (!timeMatched) {
    return json({ message: 'ليس وقت التذكير' });
  }

  // Check attendance threshold
  const today = now.toISOString().slice(0, 10);
  const { data: attendance } = await supabase
    .from('attendance')
    .select('employee_id')
    .eq('date', today);

  const presentCount = (attendance ?? []).length;
  const threshold: number = settings.reminder_threshold ?? 1;

  if (presentCount >= threshold) {
    return json({ message: `${presentCount} موظف سجل، لا داعي للتذكير` });
  }

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId   = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) return json({ error: 'Telegram secrets غير مضبوطة' }, 500);

  const message = settings.reminder_message || 'عيني شباب شوكت تسجلون حضور؟';

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `⏰ ${message}`, parse_mode: 'HTML' }),
    });
    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
