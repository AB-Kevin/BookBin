// The item catalogue and its stock history.
//
// Ported to Supabase. Channel names, arguments and return shapes are unchanged
// from the SQLite version, so no screen changed.
//
// Two conversions matter here and are easy to miss:
//
//   * quantity_on_hand, default_cost and default_price are numeric columns,
//     which PostgREST returns as STRINGS. Left alone, the items table would
//     print "1.0000" instead of "1", and any total built by adding them would
//     concatenate rather than add.
//
//   * is_inventory is a real boolean now, not 0/1. The renderer only ever
//     tests it for truthiness, so true/false works unchanged.

const { getSupabase } = require('../db/supabase');
const { table, unwrap, byName, numericColumns } = require('../db/rest');

const COLUMNS =
  'id, sku, name, description, unit, is_inventory, quantity_on_hand, ' +
  'default_cost, default_price, created_at';

const ADJUSTMENT_COLUMNS = 'id, item_id, delta, reason, source_type, source_id, created_at';

const coerceItem = numericColumns('quantity_on_hand', 'default_cost', 'default_price');
const coerceAdjustment = numericColumns('delta');

// Mirrors the SQLite version exactly, including the parts that look odd:
// a non-inventory item is forced to zero stock, and an update deliberately
// leaves quantity_on_hand alone -- stock moves only through adjustments, so
// that an item's history always explains its current count.
function withDefaults(data) {
  return {
    sku: data.sku || null,
    name: data.name,
    description: data.description || null,
    unit: data.unit || 'ea',
    is_inventory: !!data.is_inventory,
    default_cost: Number(data.default_cost || 0),
    default_price: Number(data.default_price || 0),
  };
}

module.exports = function registerItems(ipcMain) {
  ipcMain.handle('items:list', async () => {
    const rows = unwrap(await table('items').select(COLUMNS));
    return byName(coerceItem(rows));
  });

  ipcMain.handle('items:get', async (_e, id) => {
    return coerceItem(
      unwrap(await table('items').select(COLUMNS).eq('id', id).maybeSingle())
    );
  });

  ipcMain.handle('items:create', async (_e, data) => {
    // Opening stock is written straight onto the row without an adjustment
    // record, which is what the SQLite version did. It is why a handful of
    // items have a quantity that its history does not account for.
    const row = {
      ...withDefaults(data),
      quantity_on_hand: data.is_inventory ? Number(data.quantity_on_hand || 0) : 0,
    };
    return coerceItem(unwrap(await table('items').insert(row).select(COLUMNS).single()));
  });

  ipcMain.handle('items:update', async (_e, id, data) => {
    return coerceItem(
      unwrap(await table('items').update(withDefaults(data)).eq('id', id).select(COLUMNS).single())
    );
  });

  ipcMain.handle('items:delete', async (_e, id) => {
    unwrap(await table('items').delete().eq('id', id));
    return { ok: true };
  });

  ipcMain.handle('items:history', async (_e, id) => {
    // id descending breaks ties within the same second, which matters because
    // an invoice writes several adjustments in one go.
    const rows = unwrap(
      await table('inventory_adjustments')
        .select(ADJUSTMENT_COLUMNS)
        .eq('item_id', id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
    );
    return coerceAdjustment(rows);
  });

  // Manual stock correction (e.g. physical count reconciliation), not tied to
  // any invoice. Goes through a database function because adjusting the count
  // and recording why must not come apart; see the migration for why that
  // cannot be done from here.
  ipcMain.handle('items:adjustStock', async (_e, id, delta, reason) => {
    const { data, error } = await getSupabase().rpc('adjust_item_stock', {
      p_item_id: id,
      p_delta: Number(delta),
      p_reason: reason || null,
    });
    return coerceItem(unwrap({ data, error }));
  });
};
