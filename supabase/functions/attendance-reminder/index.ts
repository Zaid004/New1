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

// ── Web Push helpers (RFC 8291 / RFC 8292) ───────────────────────────

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function u8b64(s: string): Uint8Array {
  const b = s.replace(/-/g,'+').replace(/_/g,'/');
  const p = b + '='.repeat((4 - b.length % 4) % 4);
  return Uint8Array.from(atob(p), c => c.charCodeAt(0));
}
function cat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let T = new Uint8Array(0);
  for (let i = 1; i <= Math.ceil(len / 32); i++) {
    T = await hmacSha256(prk, cat(T, info, new Uint8Array([i])));
    chunks.push(T);
  }
  return cat(...chunks).slice(0, len);
}

async function vapidJwt(vpub: string, vpriv: string, endpoint: string): Promise<string> {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const enc = new TextEncoder();
  const hdr = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pld = b64u(enc.encode(JSON.stringify({ iss: 'mailto:admin@stacks-internal.app', aud, exp })));
  const msg = `${hdr}.${pld}`;
  const pub = u8b64(vpub);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: vpriv,
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(msg)));
  return `${msg}.${b64u(sig)}`;
}

async function encryptWebPush(text: string, p256dh: string, auth: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const clientPub  = u8b64(p256dh);
  const authBytes  = u8b64(auth);
  const serverKP   = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPub  = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey));
  const clientKey  = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKP.privateKey, 256));
  const salt       = crypto.getRandomValues(new Uint8Array(16));
  // IKM
  const prk1   = await hmacSha256(authBytes, ecdhSecret);
  const keyInfo = cat(enc.encode('WebPush: info\0'), clientPub, serverPub);
  const ikm     = await hkdfExpand(prk1, keyInfo, 32);
  // CEK + nonce
  const prk2  = await hmacSha256(salt, ikm);
  const cek   = await hkdfExpand(prk2, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])), 16);
  const nonce = await hkdfExpand(prk2, cat(enc.encode('Content-Encoding: nonce\0'),     new Uint8Array([1])), 12);
  // Encrypt
  const aesKey     = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, cat(enc.encode(text), new Uint8Array([0x02]))));
  // Build RFC 8188 body
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return cat(salt, rs, new Uint8Array([65]), serverPub, ciphertext);
}

async function sendOnePush(
  endpoint: string, p256dh: string, auth: string,
  payload: object, vpub: string, vpriv: string,
): Promise<number> {
  const [jwt, body] = await Promise.all([
    vapidJwt(vpub, vpriv, endpoint),
    encryptWebPush(JSON.stringify(payload), p256dh, auth),
  ]);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': `vapid t=${jwt},k=${vpub}`,
    },
    body,
  });
  return res.status;
}

// ── Main handler ─────────────────────────────────────────────────────

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

  const botToken  = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId    = Deno.env.get('TELEGRAM_CHAT_ID');
  const vpub      = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
  const vpriv     = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';

  const sendMsg = async (text: string) => {
    if (!botToken || !chatId) return;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  };

  const sendPushAll = async (payload: object) => {
    if (!vpub || !vpriv) return;
    const { data: subs } = await supabase.from('push_subscriptions').select('endpoint, p256dh, auth');
    for (const sub of subs ?? []) {
      try {
        const status = await sendOnePush(sub.endpoint, sub.p256dh, sub.auth, payload, vpub, vpriv);
        if (status === 410 || status === 404) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      } catch (_) { /* ignore individual failures */ }
    }
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
          .from('attendance_records')
          .select('employee_id')
          .eq('date', today);
        const presentCount = (attendance ?? []).length;
        const threshold: number = settings.reminder_threshold ?? 1;
        if (presentCount < threshold) {
          const msg = settings.reminder_message || 'عيني شباب شوكت تسجلون حضور؟';
          // Telegram
          if (settings.telegram_enabled !== false) await sendMsg(`⏰ ${msg}`);
          // Web Push
          if (settings.webpush_enabled !== false) {
            await sendPushAll({ title: 'Stacks · تذكير', body: msg });
          }
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

        let recLabel = '';
        if (task.recurrence === 'weekly')
          recLabel = ` · كل ${DAYS_AR[task.day_of_week as number]}`;
        else if (task.recurrence === 'monthly')
          recLabel = ` · يوم ${task.day_of_month} من كل شهر`;

        const taskMsg = `${(emp as Record<string,unknown>|null)?.name ?? 'الجميع'}: ${task.title}${recLabel}`;
        if (settings?.telegram_enabled !== false) {
          await sendMsg(`📋 <b>مهمة اليوم</b>${empLine}\n📌 ${task.title}${recLabel}`);
        }
        if (settings?.webpush_enabled !== false) {
          await sendPushAll({ title: 'Stacks · مهمة اليوم', body: taskMsg });
        }
      }

      if (todayTasks.length > 0) results.push(`${todayTasks.length} task reminders sent`);
      else results.push('no tasks today');
    }
  }

  return json({ success: true, results });
});
