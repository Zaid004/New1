import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    kty: 'EC', crv: 'P-256', d: vpriv,
    x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)),
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
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk1 = await hmacSha256(authBytes, ecdhSecret);
  const ikm  = await hkdfExpand(prk1, cat(enc.encode('WebPush: info\0'), clientPub, serverPub), 32);
  const prk2 = await hmacSha256(salt, ikm);
  const cek   = await hkdfExpand(prk2, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])), 16);
  const nonce = await hkdfExpand(prk2, cat(enc.encode('Content-Encoding: nonce\0'),     new Uint8Array([1])), 12);
  const aesKey     = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, cat(enc.encode(text), new Uint8Array([0x02]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return cat(salt, rs, new Uint8Array([65]), serverPub, ciphertext);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Verify JWT
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return new Response('Unauthorized', { status: 401, headers: CORS });

  const { endpoint, p256dh, auth } = await req.json();
  if (!endpoint || !p256dh || !auth)
    return new Response('Missing fields', { status: 400 });

  const vpub  = 'BMlNdgIZQhNvnAB1xyKLI48nH-fAHNSMUguXJw5mngU3XA_YrY8iy8ZKJ8EsCN-TgCug8QJz8RuGdGRuXg4wVwc';
  const vpriv = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
  if (!vpriv) return new Response('VAPID_PRIVATE_KEY not set', { status: 500, headers: CORS });

  try {
    const [jwt, body] = await Promise.all([
      vapidJwt(vpub, vpriv, endpoint),
      encryptWebPush(JSON.stringify({ title: 'Stacks · اختبار', body: 'الإشعارات تعمل بشكل صحيح ✓' }), p256dh, auth),
    ]);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '60',
        'Authorization': `vapid t=${jwt},k=${vpub}`,
      },
      body,
    });
    return new Response(JSON.stringify({ status: res.status }), {
      status: res.ok || res.status === 201 ? 200 : 502,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
});
