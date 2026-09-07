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
    type LoyVariant = Record<string, unknown> & {
      default_price?: number;
      price?: number;
      option1_value?: string;
      option2_value?: string;
      option3_value?: string;
      sku?: string;
      stores?: { store_id?: string; low_stock?: number | null }[];
    };
    type LoyItem = {
      id: string;
      item_name: string;
      category_id?: string;
      image_url?: string;
      variants: LoyVariant[];
    };

    // 1. Fetch ALL inventory first (no filter → all inventory levels)
    // This avoids needing to know the exact variant ID field name in the items response
    const invMap: Record<string, number> = {};
    try {
      let invCursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: '250' });
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
          if (iv.variant_id) {
            invMap[iv.variant_id] = (invMap[iv.variant_id] ?? 0) + (iv.in_stock ?? 0);
          }
        }
        invCursor = invData.cursor ?? null;
      } while (invCursor);
    } catch { /* ignore */ }

    // 2. Fetch all items (paginated)
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

    // 3. Fetch categories
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

    // 4. Find the variant's ID by scanning ALL its string fields against invMap keys.
    // This is resilient to API field name changes (variant_id, id, item_variant_id, etc.)
    const getVariantId = (v: LoyVariant): string | null => {
      for (const val of Object.values(v)) {
        if (typeof val === 'string' && invMap[val] !== undefined) return val;
      }
      // Fallback: first UUID-shaped string field
      for (const val of Object.values(v)) {
        if (typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
          return val;
        }
      }
      return null;
    };

    const varName = (v: LoyVariant) =>
      [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(' / ') ||
      (v.sku as string | undefined) ||
      null;

    // Build low_stock threshold map from items API (variant.stores[].low_stock)
    const lowMap: Record<string, number> = {};
    for (const item of allItems) {
      for (const v of item.variants) {
        const vid = getVariantId(v);
        if (!vid) continue;
        const threshold = (v.stores ?? [])
          .map(s => s.low_stock ?? 0)
          .find(t => t > 0) ?? 0;
        if (threshold > 0) lowMap[vid] = threshold;
      }
    }

    const now = new Date().toISOString();
    const records = allItems.map(item => {
      const variantsData = item.variants.map(v => {
        const vid = getVariantId(v);
        const stock = vid !== null ? (invMap[vid] ?? 0) : 0;
        const low = vid ? (lowMap[vid] ?? 0) : 0;
        const is_low = stock > 0 && low > 0 && stock <= low;
        return {
          id: vid,
          name: varName(v),
          price: (v.default_price as number | undefined) ?? (v.price as number | undefined) ?? null,
          stock,
          is_low,
        };
      });
      const totalStock = variantsData.reduce((t, v) => t + v.stock, 0);
      const isProductLow = variantsData.some(v => v.is_low);
      return {
        id: item.id,
        name: item.item_name,
        category_id: item.category_id ?? null,
        category_name: item.category_id ? (catMap[item.category_id] ?? null) : null,
        image_url: item.image_url ?? null,
        price: (item.variants[0]?.default_price as number | undefined) ?? (item.variants[0]?.price as number | undefined) ?? null,
        stock: totalStock,
        is_low: isProductLow,
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
