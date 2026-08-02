import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DAYS_AR = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

function taskApplies(task: Record<string,unknown>, dateStr: string): boolean {
  if (!task.is_active) return false;
  const jsDate = new Date(dateStr + 'T00:00:00');
  const d      = jsDate.getDate();
  if (task.recurrence === 'daily')   return true;
  if (task.recurrence === 'weekly')  return task.day_of_week  === jsDate.getDay();
  if (task.recurrence === 'monthly') return task.day_of_month === d;
  if (task.recurrence === 'once')    return task.specific_date === dateStr;
  return false;
}

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

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId   = Deno.env.get('TELEGRAM_CHAT_ID');

  const sendMsg = async (text: string) => {
    if (!botToken || !chatId) return;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  };

  // Load notification settings
  const { data: settings } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  // Current Iraq time (UTC+3)
  const now            = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const currentDay     = now.getUTCDay();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today          = now.toISOString().slice(0, 10);

  const results: string[] = [];

  // ── 1. Attendance reminder ───────────────────────────────────
  if (settings?.reminder_enabled) {
    const reminderDays: number[] = settings.reminder_days ?? [0,1,2,3,4,5];
    if (reminderDays.includes(currentDay)) {
      const reminderTimes: string[] = settings.reminder_times ?? ['12:00'];
      const timeMatched = reminderTimes.some(t => {
        const [h, m] = t.split(':').map(Number);
        const tMin   = h * 60 + m;
        return currentMinutes >= tMin && currentMinutes < tMin + 5;
      });
      if (timeMatched) {
        const { data: attendance } = await supabase
          .from('attendance')
          .select('employee_id')
          .eq('date', today);
        const presentCount = (attendance ?? []).length;
        const threshold: number = settings.reminder_threshold ?? 1;
        if (presentCount < threshold) {
          await sendMsg(`⏰ ${settings.reminder_message || 'عيني شباب شوكت تسجلون حضور؟'}`);
          results.push('attendance reminder sent');
        }
      }
    }
  }

  // ── 2. Task reminders ────────────────────────────────────────
  if (settings?.task_reminder_enabled !== false) {
    const reminderTime: string = settings?.task_reminder_time ?? '08:00';
    const [th, tm] = reminderTime.split(':').map(Number);
    const tMin     = th * 60 + tm;
    const timeMatched = currentMinutes >= tMin && currentMinutes < tMin + 5;

    if (timeMatched) {
      const [{ data: tasks }, { data: employees }] = await Promise.all([
        supabase.from('tasks').select('*').eq('is_active', true),
        supabase.from('employees').select('id, name'),
      ]);

      const todayTasks = (tasks ?? []).filter(t => taskApplies(t, today));

      for (const task of todayTasks) {
        const emp = task.assigned_to
          ? (employees ?? []).find((e: Record<string,unknown>) => e.id === task.assigned_to)
          : null;
        const empLine = emp
          ? `\n👤 ${(emp as Record<string,unknown>).name}`
          : '\n👥 جميع الموظفين';

        // Recurrence label
        let recLabel = '';
        if (task.recurrence === 'weekly')
          recLabel = ` · كل ${DAYS_AR[task.day_of_week as number]}`;
        else if (task.recurrence === 'monthly')
          recLabel = ` · يوم ${task.day_of_month} من كل شهر`;

        await sendMsg(
          `📋 <b>مهمة اليوم</b>${empLine}\n📌 ${task.title}${recLabel}`
        );
      }

      if (todayTasks.length > 0) results.push(`${todayTasks.length} task reminders sent`);
      else results.push('no tasks today');
    }
  }

  return json({ success: true, results });
});
