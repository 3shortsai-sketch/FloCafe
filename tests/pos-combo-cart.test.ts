/**
 * Unit Test: POS combo cart lines, upgrade offers and quick-note chips.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/pos-combo-cart.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
};
const originalResolveFilename = moduleApi._resolveFilename;
const zustandPath = frontendRequire.resolve('zustand');
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
  const resolvedRequest =
    request === 'zustand'
      ? zustandPath
      : request.startsWith('@/')
        ? path.resolve(ROOT, 'frontend/src', request.slice(2))
        : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const {
  allocateMinorUnits,
  buildComboCartLines,
  findComboUpgrade,
  groupCartRows,
  quickNotesForProduct,
  toggleQuickNote,
} = require('../frontend/src/lib/combos');
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { cartLineUnitPrice } = require('../frontend/src/lib/cart-price');
const { useCartStore } = require('../frontend/src/store/cart');

function product(id: string, price: number, categoryId = 'cat-meals') {
  return { id, name: id, price, category_id: categoryId, variants: [], addon_groups: [] } as any;
}

const bowl = product('bowl', 100);
const fries = product('fries', 80);
const slush = product('slush', 60, 'cat-drinks');

const combo = {
  id: 'combo-1',
  name: 'Boom Trio',
  description: null,
  price: 199,
  image_url: null,
  is_active: 1,
  upsell_enabled: 1,
  sort_order: 0,
  slots: [
    { id: 's-bowl', name: 'Bowl', sort_order: 0, options: [{ product_id: 'bowl', upcharge: 0 }] },
    {
      id: 's-fries',
      name: 'Fries',
      sort_order: 1,
      options: [{ product_id: 'fries', upcharge: 0 }],
    },
    {
      id: 's-drink',
      name: 'Drink',
      sort_order: 2,
      options: [{ product_id: 'slush', upcharge: 20 }],
    },
  ],
} as any;

const pick = (p: any) => ({ product: p, variant: null, addons: [], special_instructions: '' });
const picks = { 's-bowl': pick(bowl), 's-fries': pick(fries), 's-drink': pick(slush) };

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('POS combo cart');

check('allocation matches the server split and adds up', () => {
  assert.deepEqual(allocateMinorUnits(21900, [10000, 8000, 6000]), [9125, 7300, 5475]);
  assert.equal(
    allocateMinorUnits(1000, [1, 1, 1]).reduce((a: number, b: number) => a + b, 0),
    1000,
  );
});

const lines = buildComboCartLines(combo, picks, 2, {
  onlinePlatformSelected: false,
  decimalsOrCurrency: 2,
});

check('a combo becomes one cart line per slot sharing a group', () => {
  assert.equal(lines.length, 3);
  assert.equal(new Set(lines.map((line: any) => line.combo.group_key)).size, 1);
  assert.deepEqual(
    lines.map((line: any) => line.combo.unit_price),
    [91.25, 73, 54.75],
  );
  const shown = lines.reduce(
    (sum: number, line: any) => sum + cartLineUnitPrice(line, false) * line.quantity,
    0,
  );
  assert.equal(Number(shown.toFixed(2)), 438);
});

check('the order payload carries the combo reference, not a price', () => {
  const payload = cartItemToOrderItem(lines[0]);
  assert.deepEqual(payload.combo, {
    combo_id: 'combo-1',
    group_key: lines[0].combo.group_key,
    slot_id: 's-bowl',
  });
  assert.equal('unit_price' in payload, false);
});

check('combo lines never merge with standalone lines', () => {
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(bowl, 1);
  useCartStore.getState().addCombo(lines);
  const items = useCartStore.getState().items;
  assert.equal(items.length, 4);
  assert.equal(items.filter((item: any) => item.product.id === 'bowl').length, 2);
});

check('quantity and removal apply to the whole combo', () => {
  const store = useCartStore.getState();
  const comboLine = store.items.find((item: any) => item.combo);
  store.updateQuantity(comboLine.id, 3);
  assert.deepEqual(
    useCartStore
      .getState()
      .items.filter((item: any) => item.combo)
      .map((item: any) => item.quantity),
    [3, 3, 3],
  );
  useCartStore.getState().removeItem(comboLine.id);
  const left = useCartStore.getState().items;
  assert.equal(left.length, 1);
  assert.equal(left[0].combo, undefined);
});

check('a price override cannot be put on a combo line', () => {
  useCartStore.getState().clearCart();
  useCartStore.getState().addCombo(lines);
  const target = useCartStore.getState().items[0];
  useCartStore.getState().setItemPriceOverride(target.id, { price: 1, reason: 'x' });
  assert.equal(useCartStore.getState().items[0].price_override, undefined);
});

check('display rows group combo lines under one header', () => {
  useCartStore.getState().addItem(fries, 1);
  const rows = groupCartRows(useCartStore.getState().items);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'combo');
  assert.equal(rows[0].items.length, 3);
  assert.equal(rows[1].kind, 'item');
});

check('the upgrade offer names the extra the customer pays', () => {
  const offer = findComboUpgrade([combo], bowl, 100);
  assert.equal(offer.combo.id, 'combo-1');
  assert.equal(offer.slot.id, 's-bowl');
  assert.equal(offer.extra, 99);
  assert.equal(findComboUpgrade([{ ...combo, upsell_enabled: 0 }], bowl, 100), null);
  assert.equal(findComboUpgrade([combo], product('water', 20), 20), null);
});

check('quick notes follow category limits and toggle in the instructions', () => {
  const notes = [
    { text: 'Less ice', category_ids: ['cat-drinks'] },
    { text: 'No sauce', category_ids: [] },
  ];
  assert.deepEqual(quickNotesForProduct(notes, slush), ['Less ice', 'No sauce']);
  assert.deepEqual(quickNotesForProduct(notes, bowl), ['No sauce']);
  const once = toggleQuickNote('', 'No sauce');
  assert.equal(once, 'No sauce');
  const twice = toggleQuickNote(once, 'Extra crispy');
  assert.equal(twice, 'No sauce, Extra crispy');
  assert.equal(toggleQuickNote(twice, 'no sauce'), 'Extra crispy');
  assert.equal(toggleQuickNote('x'.repeat(99), 'No sauce'), 'x'.repeat(99));
});

console.log(`\n${passed} passed`);
