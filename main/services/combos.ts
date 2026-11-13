import { randomUUID } from 'node:crypto';
import { getDatabase, now } from '../db';
import { resolveOrderItemVariant, variantUnitPrice } from './product-variants';

type Db = ReturnType<typeof getDatabase>;

export const MAX_COMBO_SLOTS = 10;
export const MAX_COMBO_SLOT_OPTIONS = 50;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_GROUP_KEY_LENGTH = 64;

export interface ComboSlotOption {
  product_id: string;
  product_name: string;
  product_price: number;
  upcharge: number;
  sort_order: number;
}

export interface ComboSlot {
  id: string;
  name: string;
  sort_order: number;
  options: ComboSlotOption[];
}

export interface Combo {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  is_active: number;
  upsell_enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  slots: ComboSlot[];
}

interface ComboRow extends Omit<Combo, 'slots'> {
  deleted_at: string | null;
}

export class ComboValidationError extends Error {
  readonly statusCode = 400;
}

function fail(message: string): never {
  throw new ComboValidationError(message);
}

function loadSlots(db: Db, comboId: string): ComboSlot[] {
  const slots = db
    .prepare(
      'SELECT id, name, sort_order FROM combo_slots WHERE combo_id = ? ORDER BY sort_order, rowid',
    )
    .all(comboId) as Omit<ComboSlot, 'options'>[];
  const optionsStmt = db.prepare(`
    SELECT o.product_id, p.name AS product_name, p.price AS product_price, o.upcharge, o.sort_order
    FROM combo_slot_options o
    JOIN products p ON p.id = o.product_id
    WHERE o.slot_id = ? AND p.deleted_at IS NULL AND p.is_active = 1
    ORDER BY o.sort_order, p.name
  `);
  return slots.map((slot) => ({
    ...slot,
    options: (optionsStmt.all(slot.id) as ComboSlotOption[]).map((option) => ({
      ...option,
      product_price: Number(option.product_price) || 0,
      upcharge: Number(option.upcharge) || 0,
    })),
  }));
}

function toCombo(db: Db, row: ComboRow): Combo {
  const combo: Omit<Combo, 'slots'> & { deleted_at?: string | null } = { ...row };
  delete combo.deleted_at;
  return {
    ...combo,
    price: Number(combo.price) || 0,
    slots: loadSlots(db, row.id),
  };
}

export function listCombos(db: Db, options: { includeInactive?: boolean } = {}): Combo[] {
  const rows = db
    .prepare(
      `SELECT * FROM combos WHERE deleted_at IS NULL ${options.includeInactive ? '' : 'AND is_active = 1'}
       ORDER BY sort_order, name`,
    )
    .all() as ComboRow[];
  return rows.map((row) => toCombo(db, row));
}

export function getCombo(db: Db, id: string): Combo | null {
  const row = db.prepare('SELECT * FROM combos WHERE id = ? AND deleted_at IS NULL').get(id) as
    | ComboRow
    | undefined;
  return row ? toCombo(db, row) : null;
}

function parseName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    fail(`${label} must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function parseMoney(value: unknown, label: string): number {
  const amount = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    fail(`${label} must be a non-negative number`);
  }
  return amount;
}

function parseFlag(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function parseSortOrder(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

interface ParsedSlot {
  id: string | null;
  name: string;
  options: { product_id: string; upcharge: number }[];
}

function parseSlots(db: Db, value: unknown): ParsedSlot[] {
  if (!Array.isArray(value) || value.length === 0) fail('A combo needs at least one slot');
  if (value.length > MAX_COMBO_SLOTS) fail(`A combo can have at most ${MAX_COMBO_SLOTS} slots`);
  const productExists = db.prepare(
    'SELECT allow_fractional_quantity FROM products WHERE id = ? AND deleted_at IS NULL',
  );
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') fail(`Slot ${index + 1} is invalid`);
    const slot = raw as Record<string, unknown>;
    const name = parseName(slot.name, `Slot ${index + 1} name`);
    if (!Array.isArray(slot.options) || slot.options.length === 0) {
      fail(`Slot "${name}" needs at least one product`);
    }
    if (slot.options.length > MAX_COMBO_SLOT_OPTIONS) {
      fail(`Slot "${name}" can have at most ${MAX_COMBO_SLOT_OPTIONS} products`);
    }
    const seen = new Set<string>();
    const options = slot.options.map((rawOption) => {
      const option = (rawOption ?? {}) as Record<string, unknown>;
      const productId = typeof option.product_id === 'string' ? option.product_id : '';
      const product = productId
        ? (productExists.get(productId) as { allow_fractional_quantity: number } | undefined)
        : undefined;
      if (!product) fail(`Slot "${name}" references a product that does not exist`);
      if (Number(product.allow_fractional_quantity) === 1) {
        fail(`Slot "${name}" cannot include a product sold by weight`);
      }
      if (seen.has(productId)) fail(`Slot "${name}" lists the same product twice`);
      seen.add(productId);
      return {
        product_id: productId,
        upcharge:
          option.upcharge === undefined ? 0 : parseMoney(option.upcharge, 'Option upcharge'),
      };
    });
    return {
      id: typeof slot.id === 'string' && slot.id ? slot.id : null,
      name,
      options,
    };
  });
}

function writeSlots(db: Db, comboId: string, slots: ParsedSlot[]): void {
  const existingIds = new Set(
    (
      db.prepare('SELECT id FROM combo_slots WHERE combo_id = ?').all(comboId) as { id: string }[]
    ).map((row) => row.id),
  );
  const keptIds = new Set<string>();
  const insertSlot = db.prepare(
    'INSERT INTO combo_slots (id, combo_id, name, sort_order) VALUES (?, ?, ?, ?)',
  );
  const updateSlot = db.prepare('UPDATE combo_slots SET name = ?, sort_order = ? WHERE id = ?');
  const insertOption = db.prepare(
    'INSERT INTO combo_slot_options (slot_id, product_id, upcharge, sort_order) VALUES (?, ?, ?, ?)',
  );
  slots.forEach((slot, index) => {
    // Keeping a slot id lets held carts that name it stay valid across edits.
    const slotId =
      slot.id && existingIds.has(slot.id) && !keptIds.has(slot.id) ? slot.id : randomUUID();
    if (existingIds.has(slotId)) {
      updateSlot.run(slot.name, index, slotId);
      db.prepare('DELETE FROM combo_slot_options WHERE slot_id = ?').run(slotId);
    } else {
      insertSlot.run(slotId, comboId, slot.name, index);
    }
    keptIds.add(slotId);
    slot.options.forEach((option, optionIndex) => {
      insertOption.run(slotId, option.product_id, option.upcharge, optionIndex);
    });
  });
  for (const id of existingIds) {
    if (!keptIds.has(id)) db.prepare('DELETE FROM combo_slots WHERE id = ?').run(id);
  }
}

export function createCombo(db: Db, input: Record<string, unknown>): Combo {
  const name = parseName(input.name, 'Combo name');
  const price = parseMoney(input.price, 'Combo price');
  const slots = parseSlots(db, input.slots);
  const description = parseDescription(input.description);
  const id = randomUUID();
  const timestamp = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO combos (id, name, description, price, image_url, is_active, upsell_enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      description,
      price,
      parseImageUrl(input.image_url),
      parseFlag(input.is_active, 1),
      parseFlag(input.upsell_enabled, 1),
      parseSortOrder(input.sort_order),
      timestamp,
      timestamp,
    );
    writeSlots(db, id, slots);
  })();
  return getCombo(db, id) as Combo;
}

export function updateCombo(db: Db, id: string, input: Record<string, unknown>): Combo | null {
  const existing = getCombo(db, id);
  if (!existing) return null;
  const name = input.name === undefined ? existing.name : parseName(input.name, 'Combo name');
  const price = input.price === undefined ? existing.price : parseMoney(input.price, 'Combo price');
  const slots = input.slots === undefined ? null : parseSlots(db, input.slots);
  const description =
    input.description === undefined ? existing.description : parseDescription(input.description);
  db.transaction(() => {
    db.prepare(
      `UPDATE combos SET name = ?, description = ?, price = ?, image_url = ?, is_active = ?,
         upsell_enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
    ).run(
      name,
      description,
      price,
      input.image_url === undefined ? existing.image_url : parseImageUrl(input.image_url),
      parseFlag(input.is_active, existing.is_active),
      parseFlag(input.upsell_enabled, existing.upsell_enabled),
      input.sort_order === undefined ? existing.sort_order : parseSortOrder(input.sort_order),
      now(),
      id,
    );
    if (slots) writeSlots(db, id, slots);
  })();
  return getCombo(db, id);
}

/** Soft delete: sold order lines keep naming the combo they were sold under. */
export function deleteCombo(db: Db, id: string): boolean {
  const timestamp = now();
  const result = db
    .prepare(
      'UPDATE combos SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(timestamp, timestamp, id);
  return result.changes > 0;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('Description must be text');
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    fail(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return trimmed || null;
}

function parseImageUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('Image must be a URL or data URI');
  return value;
}

// ─── Order pricing ───────────────────────────────────────────────────────────

export interface ComboLineInput {
  product_id: string;
  quantity: unknown;
  variant_id?: unknown;
  price_override?: unknown;
  combo?: unknown;
}

export interface ComboLinePrice {
  unitPrice: number;
  comboId: string;
  comboName: string;
  comboGroup: string;
}

/**
 * Splits `total` (minor units) across lines in proportion to `weights` using the
 * largest-remainder method, so the parts always add back up to the total.
 */
export function allocateMinorUnits(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const shares = weights.map((weight) =>
    sum > 0 ? (total * weight) / sum : total / weights.length,
  );
  const parts = shares.map((share) => Math.floor(share));
  let remainder = total - parts.reduce((acc, part) => acc + part, 0);
  const byFraction = shares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; remainder > 0; i = (i + 1) % byFraction.length) {
    parts[byFraction[i].index] += 1;
    remainder -= 1;
  }
  return parts;
}

interface ParsedComboRef {
  comboId: string;
  groupKey: string;
  slotId: string;
}

function parseComboRef(value: unknown): ParsedComboRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('combo must be an object');
  const ref = value as Record<string, unknown>;
  const comboId = typeof ref.combo_id === 'string' ? ref.combo_id.trim() : '';
  const groupKey = typeof ref.group_key === 'string' ? ref.group_key.trim() : '';
  const slotId = typeof ref.slot_id === 'string' ? ref.slot_id.trim() : '';
  if (!comboId || !groupKey || !slotId) {
    fail('combo requires combo_id, group_key and slot_id');
  }
  if (groupKey.length > MAX_GROUP_KEY_LENGTH) {
    fail(`combo group_key must be at most ${MAX_GROUP_KEY_LENGTH} characters`);
  }
  return { comboId, groupKey, slotId };
}

/**
 * Backend-authoritative combo pricing. Lines that name a combo are grouped by
 * `group_key`; each group must fill every slot of an active combo exactly once
 * with one of that slot's products at one shared quantity. The combo price plus
 * the chosen options' upcharges is split across the components in proportion to
 * their standalone prices, so revenue, cost and tax stay on the real products.
 * Add-ons are charged on top of the allocated price as usual.
 */
export function resolveComboLinePrices(
  db: Db,
  items: ComboLineInput[],
  options: { isOnlineOrder: boolean; minorFactor: number },
): (ComboLinePrice | null)[] {
  const result: (ComboLinePrice | null)[] = items.map(() => null);
  const groups = new Map<string, { ref: ParsedComboRef; index: number }[]>();
  items.forEach((item, index) => {
    if (item.combo === undefined || item.combo === null) return;
    const ref = parseComboRef(item.combo);
    if (item.price_override !== undefined && item.price_override !== null) {
      fail('A combo item cannot also carry a price override');
    }
    const group = groups.get(ref.groupKey) ?? [];
    group.push({ ref, index });
    groups.set(ref.groupKey, group);
  });

  for (const members of groups.values()) {
    const comboId = members[0].ref.comboId;
    if (members.some((member) => member.ref.comboId !== comboId)) {
      fail('Every item in a combo must name the same combo');
    }
    const combo = getCombo(db, comboId);
    if (!combo || Number(combo.is_active) !== 1) fail('This combo is no longer available');
    if (members.length !== combo.slots.length) {
      fail(`"${combo.name}" needs exactly one item for each of its ${combo.slots.length} choices`);
    }

    const quantity = Number(items[members[0].index].quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      fail(`"${combo.name}" quantity must be a positive whole number`);
    }

    const usedSlots = new Set<string>();
    let upchargeTotal = 0;
    const weights: number[] = [];
    for (const member of members) {
      const item = items[member.index];
      if (Number(item.quantity) !== quantity) {
        fail(`Every item in "${combo.name}" must have the same quantity`);
      }
      const slot = combo.slots.find((candidate) => candidate.id === member.ref.slotId);
      if (!slot) fail(`"${combo.name}" has no such choice`);
      if (usedSlots.has(slot.id)) fail(`"${combo.name}" has more than one item for "${slot.name}"`);
      usedSlots.add(slot.id);
      const option = slot.options.find((candidate) => candidate.product_id === item.product_id);
      if (!option) fail(`That product is not a choice for "${slot.name}" in "${combo.name}"`);
      upchargeTotal += option.upcharge;

      const product = db
        .prepare('SELECT id, name, price FROM products WHERE id = ?')
        .get(item.product_id) as { id: string; name: string; price: number };
      const variant = resolveOrderItemVariant(db, product, item, options.isOnlineOrder);
      weights.push(
        Math.max(
          0,
          variant ? variantUnitPrice(variant, options.isOnlineOrder) : Number(product.price) || 0,
        ),
      );
    }

    const totalMinor = Math.round((combo.price + upchargeTotal) * options.minorFactor);
    const parts = allocateMinorUnits(totalMinor, weights);
    const comboGroup = randomUUID();
    members.forEach((member, position) => {
      result[member.index] = {
        unitPrice: parts[position] / options.minorFactor,
        comboId: combo.id,
        comboName: combo.name,
        comboGroup,
      };
    });
  }
  return result;
}

export function markOrderItemCombo(
  db: Db,
  orderItemId: number | bigint,
  price: ComboLinePrice,
): void {
  db.prepare(
    'UPDATE order_items SET combo_id = ?, combo_name = ?, combo_group = ? WHERE id = ?',
  ).run(price.comboId, price.comboName, price.comboGroup, orderItemId);
}
