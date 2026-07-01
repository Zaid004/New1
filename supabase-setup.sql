-- ════════════════════════════════════════════════════════════
-- STACKS STATIONERY — Supabase Database Setup
-- Run this in your Supabase SQL Editor
-- ════════════════════════════════════════════════════════════

-- 1. EMPLOYEES
create table if not exists employees (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  username      text unique,                                   -- اسم الدخول (بدون إيميل)
  color_hex     text not null default '#6B5876',
  auth_user_id  uuid references auth.users(id) on delete cascade,
  role          text not null default 'employee' check (role in ('admin','employee')),
  created_at    timestamptz default now()
);

-- 2. ATTENDANCE RECORDS
create table if not exists attendance_records (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references employees(id) on delete cascade,
  date              date not null,
  shift_type        text not null check (shift_type in ('full','half')),
  is_auto_generated boolean not null default false,
  note              text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique (employee_id, date)
);

-- Migration (run if table already exists):
-- alter table attendance_records add column if not exists note text;

-- 3. SALARY INPUTS (employee personal calc persistence)
create table if not exists salary_inputs (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  month       date not null,
  sales_amount  numeric default 0,
  extra_amount  numeric default 0,
  updated_at  timestamptz default now(),
  unique (employee_id, month)
);

-- 4. PAYSLIPS (admin only)
create table if not exists payslips (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        uuid not null references employees(id) on delete cascade,
  month              date not null,
  fixed_amount       numeric default 0,
  percentage_amount  numeric default 0,
  sales_amount       numeric default 0,
  bonus              numeric default 0,
  extra_amount       numeric default 0,
  notes              text default '',
  created_at         timestamptz default now(),
  created_by         uuid references employees(id)
);

-- 5. SETTINGS
create table if not exists settings (
  id                   uuid primary key default gen_random_uuid(),
  monthly_pool_amount  numeric not null default 525000,
  monthly_percentage   numeric not null default 3.2,
  effective_from       date not null default current_date
);

-- Insert default settings row
insert into settings (monthly_pool_amount, monthly_percentage, effective_from)
values (525000, 3.2, current_date)
on conflict do nothing;

-- ════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════

alter table employees          enable row level security;
alter table attendance_records enable row level security;
alter table salary_inputs      enable row level security;
alter table payslips           enable row level security;
alter table settings           enable row level security;

-- Helper: get current employee's role
create or replace function current_employee_role()
returns text language sql stable security definer as $$
  select role from employees where auth_user_id = auth.uid() limit 1;
$$;

-- Helper: get current employee's id
create or replace function current_employee_id()
returns uuid language sql stable security definer as $$
  select id from employees where auth_user_id = auth.uid() limit 1;
$$;

-- ── employees: all logged-in users can read; only admin can write ──
create policy "emp_read" on employees for select
  using (auth.uid() is not null);

create policy "emp_admin_write" on employees for all
  using (current_employee_role() = 'admin');

-- ── attendance_records: all read; employee writes own today only; admin writes all ──
create policy "att_read" on attendance_records for select
  using (auth.uid() is not null);

create policy "att_employee_write" on attendance_records for insert
  with check (
    employee_id = current_employee_id()
    and date = current_date
  );

create policy "att_employee_update" on attendance_records for update
  using (
    employee_id = current_employee_id()
    and date = current_date
  );

create policy "att_admin_all" on attendance_records for all
  using (current_employee_role() = 'admin');

-- ── salary_inputs: employee manages own rows ──
create policy "si_own" on salary_inputs for all
  using (employee_id = current_employee_id());

create policy "si_admin" on salary_inputs for all
  using (current_employee_role() = 'admin');

-- ── payslips: admin only ──
create policy "pay_admin" on payslips for all
  using (current_employee_role() = 'admin');

-- ── settings: all read; admin write ──
create policy "set_read" on settings for select
  using (auth.uid() is not null);

create policy "set_admin" on settings for all
  using (current_employee_role() = 'admin');

-- ════════════════════════════════════════════════════════════
-- 6. AUDIT LOG
-- ════════════════════════════════════════════════════════════
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  action      text not null check (action in ('add','update','delete')),
  employee_id uuid references employees(id) on delete set null,
  changed_by  uuid references employees(id) on delete set null,
  record_date date,
  old_shift   text,
  new_shift   text,
  is_auto     boolean default false,
  created_at  timestamptz default now()
);

alter table audit_log enable row level security;

create policy "audit_admin_read" on audit_log for select
  using (current_employee_role() = 'admin');

-- ════════════════════════════════════════════════════════════
-- AUDIT TRIGGER (SECURITY DEFINER — بدونها سجلات الموظفين لا تظهر)
-- ════════════════════════════════════════════════════════════
create or replace function log_attendance_change()
returns trigger language plpgsql security definer as $$
begin
  if (TG_OP = 'INSERT') then
    insert into audit_log (action, employee_id, changed_by, record_date, new_shift, is_auto)
    values ('add', NEW.employee_id, current_employee_id(), NEW.date, NEW.shift_type, NEW.is_auto_generated);

  elsif (TG_OP = 'UPDATE') then
    if OLD.shift_type <> NEW.shift_type or OLD.is_auto_generated <> NEW.is_auto_generated then
      insert into audit_log (action, employee_id, changed_by, record_date, old_shift, new_shift, is_auto)
      values ('update', NEW.employee_id, current_employee_id(), NEW.date, OLD.shift_type, NEW.shift_type, NEW.is_auto_generated);
    end if;

  elsif (TG_OP = 'DELETE') then
    insert into audit_log (action, employee_id, changed_by, record_date, old_shift, is_auto)
    values ('delete', OLD.employee_id, current_employee_id(), OLD.date, OLD.shift_type, OLD.is_auto_generated);
  end if;
  return null;
end;
$$;

drop trigger if exists attendance_audit on attendance_records;
create trigger attendance_audit
  after insert or update or delete on attendance_records
  for each row execute function log_attendance_change();

-- ════════════════════════════════════════════════════════════
-- IF YOU ALREADY RAN THIS SCRIPT BEFORE — run only this:
-- ════════════════════════════════════════════════════════════
-- alter table employees add column if not exists username text unique;
-- alter table attendance_records add column if not exists note text;

-- ════════════════════════════════════════════════════════════
-- SAMPLE DATA
-- الإضافة تتم من داخل التطبيق (شاشة الموظفون) بعد نشر Edge Function
-- أو يدوياً عبر Supabase Auth + employees table
-- ════════════════════════════════════════════════════════════

-- لإضافة المدير يدوياً (مرة واحدة فقط):
-- 1. أنشئ المستخدم في Supabase → Authentication → Users
--    البريد: admin@stacks-internal.app  |  كلمة المرور: تختارها
-- 2. ثم شغّل:
-- insert into employees (name, username, color_hex, auth_user_id, role)
-- values ('اسم المدير', 'admin', '#6B5876', 'AUTH_USER_ID_FROM_SUPABASE_AUTH', 'admin');
