/**
 * Combo meals, add-on defaults and quick item notes: catalog API, backend-authoritative
 * combo pricing on create/append/quote, per-component stock, edit guard, settings.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/combo-meals.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-combo-meals-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-combo-meals';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const { allocateMinorUnits } = require('../main/services/combos');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

function seedProduct(db: any, id: string, name: string, price: number, stock: number) {
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, cost, tax_type, is_active, sort_order,
       track_inventory, stock_quantity, created_at, updated_at)
     VALUES (?, 'cat-combo', ?, ?, 0, 'none', 1, 1, 1, ?, ?, ?)`,
  ).run(id, name, price, stock, now(), now());
}

async function main() {
  console.log('Combo meals, add-on defaults and quick notes');
  console.log('='.repeat(60));
  resetCounters();

  console.log('\n--- Allocation ---');
  assertEqualOrThrow(
    allocateMinorUnits(21900, [10000, 8000, 6000]).join(','),
    '9125,7300,5475',
    'the combo total is split in proportion to standalone prices',
  );
  const uneven = allocateMinorUnits(1000, [1, 1, 1]);
  assertEqualOrThrow(
    uneven.reduce((a: number, b: number) => a + b, 0),
    1000,
    'rounded parts add back up to the total',
  );
  assertEqualOrThrow(
    allocateMinorUnits(900, [0, 0, 0]).join(','),
    '300,300,300',
    'zero-priced components share the total evenly',
  );

  const db = initTestDb();
  db.prepare(
    `INSERT INTO categories (id, name, sort_order) VALUES ('cat-combo', 'Meals', 1)`,
  ).run();
  seedProduct(db, 'p-bowl', 'Chicken Rice Bowl', 100, 10);
  seedProduct(db, 'p-fries', 'Flavored Fries', 80, 10);
  seedProduct(db, 'p-slush', 'Fruit Slushie', 60, 10);
  seedProduct(db, 'p-slush-xl', 'Fruit Slushie XL', 75, 10);
  seedProduct(db, 'p-other', 'Bottled Water', 20, 10);
  const ownerAuth = seedUser(db, 'owner-combo', 'owner');
  const cashierAuth = seedUser(db, 'cash-combo', 'cashier');

  const app = createApp({ '/api/orders': orderRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const call = (urlPath: string, method: string, headers: any, body?: unknown) =>
    api(baseUrl, urlPath, {
      method,
      body,
      headers: { ...headers, 'Idempotency-Key': `combo-${Math.random()}` },
    });
  const stock = (id: string) =>
    (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any).stock_quantity;

  try {
    console.log('\n--- Catalog ---');
    const comboBody = {
      name: 'Boom Trio',
      price: 199,
      slots: [
        { name: 'Rice bowl', options: [{ product_id: 'p-bowl' }] },
        { name: 'Fries', options: [{ product_id: 'p-fries' }] },
        {
          name: 'Drink',
          options: [{ product_id: 'p-slush' }, { product_id: 'p-slush-xl', upcharge: 20 }],
        },
      ],
    };
    assertEqualOrThrow(
      (await call('/api/combos', 'POST', cashierAuth, comboBody)).status,
      403,
      'a cashier cannot create a combo',
    );
    assertEqualOrThrow(
      (
        await call('/api/combos', 'POST', ownerAuth, {
          ...comboBody,
          slots: [],
        })
      ).status,
      400,
      'a combo needs at least one slot',
    );
    assertEqualOrThrow(
      (
        await call('/api/combos', 'POST', ownerAuth, {
          ...comboBody,
          slots: [{ name: 'X', options: [{ product_id: 'missing' }] }],
        })
      ).status,
      400,
      'a slot cannot reference an unknown product',
    );
    const created = await call('/api/combos', 'POST', ownerAuth, comboBody);
    assertEqualOrThrow(created.status, 201, 'the owner can create a combo');
    const combo = created.data.combo;
    assertEqualOrThrow(combo.slots.length, 3, 'slots are stored in order');
    assertEqualOrThrow(combo.slots[2].options[1].upcharge, 20, 'option upcharges are stored');
    const [bowlSlot, friesSlot, drinkSlot] = combo.slots.map((slot: any) => slot.id);

    const listed = await call('/api/combos', 'GET', cashierAuth);
    assertEqualOrThrow(listed.status, 200, 'a cashier can list combos');
    assertEqualOrThrow(listed.data.combos.length, 1, 'the active combo is listed');

    const renamed = await call(`/api/combos/${combo.id}`, 'PUT', ownerAuth, {
      ...comboBody,
      name: 'Boom Trio Meal',
      slots: combo.slots.map((slot: any) => ({
        id: slot.id,
        name: slot.name,
        options: slot.options.map((o: any) => ({
          product_id: o.product_id,
          upcharge: o.upcharge,
        })),
      })),
    });
    assertEqualOrThrow(renamed.status, 200, 'the combo can be edited');
    assertEqualOrThrow(
      renamed.data.combo.slots.map((slot: any) => slot.id).join(','),
      [bowlSlot, friesSlot, drinkSlot].join(','),
      'editing keeps slot ids so held carts stay valid',
    );

    const comboItems = (quantity: number, drink = 'p-slush-xl', group = 'g1') => [
      {
        product_id: 'p-bowl',
        quantity,
        combo: { combo_id: combo.id, group_key: group, slot_id: bowlSlot },
      },
      {
        product_id: 'p-fries',
        quantity,
        combo: { combo_id: combo.id, group_key: group, slot_id: friesSlot },
      },
      {
        product_id: drink,
        quantity,
        combo: { combo_id: combo.id, group_key: group, slot_id: drinkSlot },
      },
    ];

    console.log('\n--- Quote and order ---');
    const quote = await call('/api/tax/preview', 'POST', cashierAuth, {
      items: comboItems(2),
    });
    assertEqualOrThrow(quote.status, 200, 'a combo cart can be quoted');
    assertEqualOrThrow(quote.data.summary.subtotal, 438, 'the quote is (199 + 20 upcharge) x 2');

    const order = await call('/api/orders', 'POST', cashierAuth, {
      type: 'takeaway',
      items: comboItems(2),
    });
    assertEqualOrThrow(order.status, 201, 'a combo order is created');
    const orderId = order.data.order.id;
    const rows = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
      .all(orderId) as any[];
    assertEqualOrThrow(rows.length, 3, 'each component is its own order line');
    assertEqualOrThrow(
      rows.map((row) => row.unit_price).join(','),
      '85.88,68.71,64.41',
      'components carry prices allocated by their standalone prices (100 / 80 / 75)',
    );
    assertEqualOrThrow(
      Number(rows.reduce((acc, row) => acc + row.subtotal, 0).toFixed(2)),
      438,
      'component subtotals add up to the combo total',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT total FROM orders WHERE id = ?').get(orderId) as any).total,
      438,
      'the order total matches the quote',
    );
    assertOrThrow(
      rows.every((row) => row.combo_id === combo.id && row.combo_name === 'Boom Trio Meal'),
      'every line records the combo it was sold under',
    );
    assertEqualOrThrow(
      new Set(rows.map((row) => row.combo_group)).size,
      1,
      'lines share one group',
    );
    assertEqualOrThrow(stock('p-bowl'), 8, 'the rice bowl stock drops by two');
    assertEqualOrThrow(stock('p-fries'), 8, 'the fries stock drops by two');
    assertEqualOrThrow(stock('p-slush-xl'), 8, 'the chosen drink stock drops by two');
    assertEqualOrThrow(stock('p-slush'), 10, 'the drink that was not chosen is untouched');

    console.log('\n--- Rejections ---');
    const reject = async (items: any[], label: string) => {
      const res = await call('/api/orders', 'POST', cashierAuth, {
        type: 'takeaway',
        items,
      });
      assertEqualOrThrow(res.status, 400, label);
    };
    await reject(comboItems(1).slice(0, 2), 'a combo with a missing choice is rejected');
    await reject(comboItems(1, 'p-other'), 'a product outside the slot is rejected');
    const mixed = comboItems(1);
    mixed[1].quantity = 2;
    await reject(mixed, 'components with different quantities are rejected');
    const overridden: any[] = comboItems(1);
    overridden[0].price_override = { price: 1, reason: 'x' };
    await reject(overridden, 'a combo line cannot carry a price override');
    const twice = comboItems(1);
    twice[1].combo.slot_id = bowlSlot;
    await reject(twice, 'one slot cannot be filled twice');

    console.log('\n--- Append and edit ---');
    const appended = await call(`/api/orders/${orderId}/items`, 'POST', cashierAuth, {
      items: comboItems(1, 'p-slush', 'g2'),
    });
    assertOrThrow(appended.status < 300, 'a combo can be appended to an open order');
    const appendedRows = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? AND id > ? ORDER BY id')
      .all(orderId, rows[2].id) as any[];
    assertEqualOrThrow(
      Number(appendedRows.reduce((acc, row) => acc + row.subtotal, 0).toFixed(2)),
      199,
      'the appended combo is priced at the combo price',
    );
    assertOrThrow(
      appendedRows[0].combo_group !== rows[0].combo_group,
      'a second combo gets its own group',
    );

    const edit = await call(`/api/orders/${orderId}/items/${rows[0].id}/edit`, 'PATCH', ownerAuth, {
      quantity: 1,
      expected_edit_version: 0,
    });
    assertEqualOrThrow(edit.status, 409, 'a single combo component cannot be edited');

    const deleted = await call(`/api/combos/${combo.id}`, 'DELETE', ownerAuth);
    assertEqualOrThrow(deleted.status, 200, 'a combo can be deleted');
    await reject(comboItems(1, 'p-slush', 'g3'), 'a deleted combo can no longer be sold');

    console.log('\n--- Add-on defaults ---');
    const group = await call('/api/addon-groups', 'POST', ownerAuth, {
      name: 'Sauce',
      is_required: true,
      min_selection: 1,
      max_selection: 1,
      addons: [
        { name: 'Garlic', price: 0, is_default: true },
        { name: 'Spicy', price: 0 },
      ],
    });
    assertEqualOrThrow(group.status, 201, 'an add-on group can be created with a default');
    const addons = group.data.addon_group.addons;
    const garlic = addons.find((a: any) => a.name === 'Garlic');
    const spicy = addons.find((a: any) => a.name === 'Spicy');
    assertEqualOrThrow(garlic.is_default, true, 'the default flag is stored');
    assertEqualOrThrow(spicy.is_default, false, 'other add-ons are not defaults');
    const flipped = await call(
      `/api/addon-groups/${group.data.addon_group.id}/addons/${spicy.id}`,
      'PUT',
      ownerAuth,
      { is_default: true },
    );
    assertEqualOrThrow(flipped.data.addon.is_default, true, 'a single add-on can be made default');
    const untouched = await call(
      `/api/addon-groups/${group.data.addon_group.id}/addons/${spicy.id}`,
      'PUT',
      ownerAuth,
      { price: 5 },
    );
    assertEqualOrThrow(untouched.data.addon.is_default, true, 'an omitted flag keeps its value');

    console.log('\n--- Quick notes ---');
    const empty = await call('/api/settings/quick-notes', 'GET', cashierAuth);
    assertEqualOrThrow(empty.status, 200, 'a cashier can read quick notes');
    assertEqualOrThrow(empty.data.quick_notes.length, 0, 'there are no quick notes by default');
    const notes = [
      { text: 'Less ice', category_ids: ['cat-combo'] },
      { text: 'No sauce', category_ids: [] },
    ];
    assertEqualOrThrow(
      (
        await call('/api/settings/quick-notes', 'PUT', cashierAuth, {
          quick_notes: notes,
        })
      ).status,
      403,
      'a cashier cannot change quick notes',
    );
    assertEqualOrThrow(
      (
        await call('/api/settings/quick-notes', 'PUT', ownerAuth, {
          quick_notes: [{ text: 'x'.repeat(41) }],
        })
      ).status,
      400,
      'an overlong note is rejected',
    );
    assertEqualOrThrow(
      (
        await call('/api/settings/quick-notes', 'PUT', ownerAuth, {
          quick_notes: [{ text: 'No sauce' }, { text: 'no sauce' }],
        })
      ).status,
      400,
      'a duplicate note is rejected',
    );
    const saved = await call('/api/settings/quick-notes', 'PUT', ownerAuth, {
      quick_notes: notes,
    });
    assertEqualOrThrow(saved.status, 200, 'the owner can save quick notes');
    const read = await call('/api/settings/quick-notes', 'GET', cashierAuth);
    assertEqualOrThrow(read.data.quick_notes[0].text, 'Less ice', 'saved notes are read back');
    assertEqualOrThrow(
      read.data.quick_notes[0].category_ids[0],
      'cat-combo',
      'category limits are kept',
    );
  } finally {
    server.close();
    closeDatabase();
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.passed + results.failed} passed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
