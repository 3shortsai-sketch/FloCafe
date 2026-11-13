/**
 * Combo and quick-note helpers for the POS. The server prices every combo; the
 * allocation here only shows the cashier the same split the order will carry.
 */

import type {
  Addon,
  CartItem,
  Combo,
  ComboSlot,
  ComboSlotOption,
  Product,
  ProductVariant,
  QuickNote,
} from './types';
import { generateCartItemId } from './cart-identity';
import { cartVariantUnitPrice, resolveActiveCurrencyDecimals } from './cart-price';

export const MAX_ITEM_NOTE_LENGTH = 100;

export interface ComboPick {
  product: Product;
  variant: ProductVariant | null;
  addons: Addon[];
  special_instructions: string;
}

/** Largest-remainder split of `total` minor units, matching the server's allocation. */
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

export function slotOption(slot: ComboSlot, productId: string): ComboSlotOption | undefined {
  return slot.options.find((option) => String(option.product_id) === String(productId));
}

/** Combo price for one unit including the upcharges of the chosen options. */
export function comboUnitTotal(combo: Combo, picks: Record<string, ComboPick | undefined>): number {
  return combo.slots.reduce(
    (sum, slot) => {
      const pick = picks[slot.id];
      const option = pick ? slotOption(slot, String(pick.product.id)) : undefined;
      return sum + (option?.upcharge ?? 0);
    },
    Number(combo.price) || 0,
  );
}

function newGroupKey(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `combo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Turns a fully picked combo into cart lines, one per slot, sharing one group key. */
export function buildComboCartLines(
  combo: Combo,
  picks: Record<string, ComboPick | undefined>,
  quantity: number,
  options: {
    onlinePlatformSelected: boolean;
    decimalsOrCurrency?: number | string;
  },
): CartItem[] {
  const chosen = combo.slots.map((slot) => {
    const pick = picks[slot.id];
    if (!pick) throw new Error(`Combo slot ${slot.name} has no pick`);
    return { slot, pick };
  });
  const factor = 10 ** resolveActiveCurrencyDecimals(options.decimalsOrCurrency);
  const weights = chosen.map(({ pick }) =>
    Math.max(0, cartVariantUnitPrice(pick, options.onlinePlatformSelected)),
  );
  const parts = allocateMinorUnits(Math.round(comboUnitTotal(combo, picks) * factor), weights);
  const groupKey = newGroupKey();
  return chosen.map(({ slot, pick }, index) => {
    const combo_ref = {
      combo_id: combo.id,
      combo_name: combo.name,
      group_key: groupKey,
      slot_id: slot.id,
      slot_name: slot.name,
      unit_price: parts[index] / factor,
    };
    return {
      id: generateCartItemId(
        pick.product.id,
        pick.variant?.id ?? null,
        pick.addons,
        pick.special_instructions,
        null,
        combo_ref,
      ),
      product: pick.product,
      quantity,
      addons: pick.addons,
      special_instructions: pick.special_instructions,
      variant: pick.variant,
      combo: combo_ref,
    };
  });
}

export interface ComboUpgradeOffer {
  combo: Combo;
  slot: ComboSlot;
  /** What the customer pays on top of the item they already ordered. */
  extra: number;
}

/** The cheapest upsell-enabled combo whose slot offers this product, if any. */
export function findComboUpgrade(
  combos: Combo[],
  product: Product,
  standaloneUnitPrice: number,
): ComboUpgradeOffer | null {
  let best: ComboUpgradeOffer | null = null;
  for (const combo of combos) {
    if (!combo.is_active || !combo.upsell_enabled || combo.slots.length < 2) continue;
    for (const slot of combo.slots) {
      const option = slotOption(slot, String(product.id));
      if (!option) continue;
      const extra = Number(combo.price) + option.upcharge - standaloneUnitPrice;
      if (extra > 0 && (!best || extra < best.extra)) best = { combo, slot, extra };
    }
  }
  return best;
}

/** Notes offered for one product: global notes plus those limited to its category. */
export function quickNotesForProduct(notes: QuickNote[], product: Product): string[] {
  const categoryId = product.category_id ?? product.category?.id;
  return notes
    .filter(
      (note) =>
        note.category_ids.length === 0 ||
        (categoryId != null && note.category_ids.includes(String(categoryId))),
    )
    .map((note) => note.text);
}

const NOTE_SEPARATOR = ', ';

export function noteSegments(instructions: string): string[] {
  return instructions
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Adds the note to the instructions, or removes it when it is already there. */
export function toggleQuickNote(instructions: string, note: string): string {
  const segments = noteSegments(instructions);
  const index = segments.findIndex(
    (segment) => segment.toLocaleLowerCase() === note.toLocaleLowerCase(),
  );
  if (index >= 0) {
    segments.splice(index, 1);
    return segments.join(NOTE_SEPARATOR);
  }
  const next = [...segments, note].join(NOTE_SEPARATOR);
  return next.length > MAX_ITEM_NOTE_LENGTH ? instructions : next;
}

/** Cart lines grouped for display: standalone lines alone, combo lines under their combo. */
export type CartDisplayRow =
  | { kind: 'item'; item: CartItem }
  | {
      kind: 'combo';
      groupKey: string;
      name: string;
      quantity: number;
      items: CartItem[];
    };

export function groupCartRows(items: CartItem[]): CartDisplayRow[] {
  const rows: CartDisplayRow[] = [];
  const byGroup = new Map<string, Extract<CartDisplayRow, { kind: 'combo' }>>();
  for (const item of items) {
    if (!item.combo) {
      rows.push({ kind: 'item', item });
      continue;
    }
    const existing = byGroup.get(item.combo.group_key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const row = {
      kind: 'combo' as const,
      groupKey: item.combo.group_key,
      name: item.combo.combo_name,
      quantity: item.quantity,
      items: [item],
    };
    byGroup.set(item.combo.group_key, row);
    rows.push(row);
  }
  return rows;
}
