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

  const loyToken = Deno.env.get('LOYVERSE_TOKEN');
  if (!loyToken) return json({ error: 'LOYVERSE_TOKEN غير مضبوط في Supabase Secrets' }, 500);

  const body = await req.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  // Cache freshness: 5 minutes
  if (!forceRefresh) {
    const { data: latest } = await supabase
      .from('products')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1);
    if (latest && latest.length > 0) {
      const ageMin = (Date.now() - new Date(latest[0].synced_at).getTime()) / 60000;
      if (ageMin < 5) {
        const { data: cached } = await supabase.from('products').select('*').order('name');
        return json({ products: cached ?? [], cached: true });
      }
    }
  }

  try {
    // NOTE: Loyverse items API uses "variant_id" (not "id") for variant identifiers
    type LoyVariant = {
      variant_id?: string; // actual field name in Loyverse items response
      id?: string;         // fallback just in case
      default_price?: number;
      price?: number;
      option1_value?: string;
      option2_value?: string;
      option3_value?: string;
      sku?: string;
      stores?: { store_id: string; in_stock?: number }[];
    };
    type LoyItem = {
      id: string;
      item_name: string;
      category_id?: string;
      image_url?: string;
      variants: LoyVariant[];
    };

    // 1. Fetch all items (paginated)
    const allItems: LoyItem[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: '250' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`https://api.loyverse.com/v1.0/items?${params}`, {
        headers: { Authorization: `Bearer ${loyToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return json({
          error: (err as { errors?: { message: string }[] })?.errors?.[0]?.message ?? `Loyverse items ${res.status}`,
        }, 502);
      }
      const data = await res.json() as { items: LoyItem[]; cursor?: string };
      allItems.push(...(data.items ?? []));
      cursor = data.cursor ?? null;
    } while (cursor);

    // 2. Fetch categories
    const catMap: Record<string, string> = {};
    try {
      const catRes = await fetch('https://api.loyverse.com/v1.0/categories?limit=250', {
        headers: { Authorization: `Bearer ${loyToken}` },
      });
      if (catRes.ok) {
        const catData = await catRes.json() as { categories: { id: string; name: string }[] };
        for (const c of catData.categories ?? []) catMap[c.id] = c.name;
      }
    } catch { /* ignore */ }

    // 3. Fetch inventory by explicit variant_ids (batches of 100)
    // Key fix: use v.variant_id (Loyverse items API field name) not v.id
    const invMap: Record<string, number> = {};
    try {
      const allVarIds = allItems
        .flatMap(item => item.variants.map(v => v.variant_id ?? v.id))
        .filter((id): id is string => !!id);

      for (let i = 0; i < allVarIds.length; i += 100) {
        const batch = allVarIds.slice(i, i + 100).join(',');
        let invCursor: string | null = null;
        do {
          const params = new URLSearchParams({ variant_ids: batch, limit: '250' });
          if (invCursor) params.set('cursor', invCursor);
          const invRes = await fetch(`https://api.loyverse.com/v1.0/inventory?${params}`, {
            headers: { Authorization: `Bearer ${loyToken}` },
          });
          if (!invRes.ok) break;
          const invData = await invRes.json() as {
            inventory_levels?: { variant_id: string; in_stock: number }[];
            cursor?: string;
          };
          for (const iv of invData.inventory_levels ?? []) {
            invMap[iv.variant_id] = (invMap[iv.variant_id] ?? 0) + (iv.in_stock ?? 0);
          }
          invCursor = invData.cursor ?? null;
        } while (invCursor);
      }
    } catch { /* ignore */ }

    // 4. Build records
    const varName = (v: LoyVariant) =>
      [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(' / ') || v.sku || null;

    const now = new Date().toISOString();
    const records = allItems.map(item => {
      const variantStock = (v: LoyVariant) => {
        const vid = v.variant_id ?? v.id;
        if (vid && invMap[vid] !== undefined) return invMap[vid];
        return (v.stores ?? []).reduce((s, store) => s + (store.in_stock ?? 0), 0);
      };
      const variantsData = item.variants.map(v => ({
        id: v.variant_id ?? v.id,
        name: varName(v),
        price: v.default_price ?? v.price ?? null,
        stock: variantStock(v),
      }));
      return {
        id: item.id,
        name: item.item_name,
        category_id: item.category_id ?? null,
        category_name: item.category_id ? (catMap[item.category_id] ?? null) : null,
        image_url: item.image_url ?? null,
        price: item.variants[0]?.default_price ?? item.variants[0]?.price ?? null,
        stock: variantsData.reduce((t, v) => t + v.stock, 0),
        variants: JSON.stringify(variantsData),
        synced_at: now,
      };
    });

    for (let i = 0; i < records.length; i += 100) {
      await supabase.from('products').upsert(records.slice(i, i + 100), { onConflict: 'id' });
    }

    return json({ products: records, cached: false, total: records.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
