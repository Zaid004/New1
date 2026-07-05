import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Verify caller is an admin
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'غير مصرح' }), { status: 401, headers: corsHeaders });
  }
  const { data: caller } = await supabaseAdmin
    .from('employees').select('role').eq('auth_user_id', user.id).maybeSingle();
  if (caller?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'للمدير فقط' }), { status: 403, headers: corsHeaders });
  }

  const body = await req.json();
  const { action } = body;

  // ── CREATE ────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const { name, username, password, color_hex, role, loyverse_pos_name } = body;
    if (!name || !username || !password) {
      return new Response(JSON.stringify({ error: 'الاسم واسم المستخدم وكلمة المرور مطلوبة' }), { status: 400, headers: corsHeaders });
    }

    const email = `${username.trim().toLowerCase()}@stacks-internal.app`;

    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      const msg = createErr.message.includes('already registered')
        ? 'اسم المستخدم مستخدم مسبقاً'
        : createErr.message;
      return new Response(JSON.stringify({ error: msg }), { status: 400, headers: corsHeaders });
    }

    const { error: empErr } = await supabaseAdmin.from('employees').insert({
      name,
      username: username.trim().toLowerCase(),
      color_hex: color_hex || '#A8825B',
      auth_user_id: newUser.user.id,
      role: role || 'employee',
      loyverse_pos_name: loyverse_pos_name?.trim() || null,
    });
    if (empErr) {
      await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
      return new Response(JSON.stringify({ error: empErr.message }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const { employee_id } = body;
    const { data: emp } = await supabaseAdmin
      .from('employees').select('auth_user_id').eq('id', employee_id).maybeSingle();
    if (!emp) return new Response(JSON.stringify({ error: 'موظف غير موجود' }), { status: 404, headers: corsHeaders });

    await supabaseAdmin.from('employees').delete().eq('id', employee_id);
    if (emp.auth_user_id) await supabaseAdmin.auth.admin.deleteUser(emp.auth_user_id);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── UPDATE PASSWORD ───────────────────────────────────────────────────────
  if (action === 'reset_password') {
    const { employee_id, new_password } = body;
    const { data: emp } = await supabaseAdmin
      .from('employees').select('auth_user_id').eq('id', employee_id).maybeSingle();
    if (!emp?.auth_user_id) return new Response(JSON.stringify({ error: 'موظف غير موجود' }), { status: 404, headers: corsHeaders });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(emp.auth_user_id, { password: new_password });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── UPDATE EMPLOYEE ───────────────────────────────────────────────────────────
  if (action === 'update') {
    const { employee_id, name, username, color_hex, role, loyverse_pos_name } = body;
    if (!employee_id) return new Response(JSON.stringify({ error: 'employee_id مطلوب' }), { status: 400, headers: corsHeaders });

    const { data: emp } = await supabaseAdmin
      .from('employees').select('auth_user_id, username').eq('id', employee_id).maybeSingle();
    if (!emp) return new Response(JSON.stringify({ error: 'موظف غير موجود' }), { status: 404, headers: corsHeaders });

    const updates: Record<string, unknown> = {};
    if (name) updates.name = name.trim();
    if (color_hex) updates.color_hex = color_hex;
    if (role) updates.role = role;
    updates.loyverse_pos_name = loyverse_pos_name?.trim() || null;

    if (username && username.trim().toLowerCase() !== emp.username) {
      const newUsername = username.trim().toLowerCase();
      updates.username = newUsername;
      if (emp.auth_user_id) {
        const newEmail = `${newUsername}@stacks-internal.app`;
        const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(emp.auth_user_id, { email: newEmail });
        if (authErr) return new Response(JSON.stringify({ error: authErr.message }), { status: 400, headers: corsHeaders });
      }
    }

    const { error: empErr } = await supabaseAdmin.from('employees').update(updates).eq('id', employee_id);
    if (empErr) return new Response(JSON.stringify({ error: empErr.message }), { status: 400, headers: corsHeaders });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'action غير معروف' }), { status: 400, headers: corsHeaders });
});
