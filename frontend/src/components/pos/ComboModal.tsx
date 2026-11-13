'use client';

import { useState } from 'react';
import { Check, Minus, Plus, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { productNeedsCustomizer } from '@/lib/product-variants';
import {
  buildComboCartLines,
  comboUnitTotal,
  quickNotesForProduct,
  type ComboPick,
} from '@/lib/combos';
import type { Addon, CartItem, Combo, Product, ProductVariant, QuickNote } from '@/lib/types';
import AddonModal from './AddonModal';

interface Props {
  combo: Combo;
  products: Product[];
  currency: string;
  quickNotes: QuickNote[];
  oneTap: boolean;
  onlinePlatformSelected: boolean;
  /** A pick carried over from the item the cashier is upgrading. */
  initialPick?: { slotId: string; pick: ComboPick } | null;
  onAdd: (lines: CartItem[]) => void;
  onClose: () => void;
}

function initialPicks(
  combo: Combo,
  productById: Map<string, Product>,
  initialPick: Props['initialPick'],
): Record<string, ComboPick | undefined> {
  const picks: Record<string, ComboPick | undefined> = {};
  for (const slot of combo.slots) {
    const only =
      slot.options.length === 1 ? productById.get(String(slot.options[0].product_id)) : null;
    if (only && !productNeedsCustomizer(only)) {
      picks[slot.id] = {
        product: only,
        variant: null,
        addons: [],
        special_instructions: '',
      };
    }
  }
  if (initialPick) picks[initialPick.slotId] = initialPick.pick;
  return picks;
}

export default function ComboModal({
  combo,
  products,
  currency,
  quickNotes,
  oneTap,
  onlinePlatformSelected,
  initialPick = null,
  onAdd,
  onClose,
}: Props) {
  const t = useTranslations('pos');
  const fmt = useFormatCurrency();
  const productById = new Map(products.map((product) => [String(product.id), product]));
  const [picks, setPicks] = useState(() => initialPicks(combo, productById, initialPick));
  const [quantity, setQuantity] = useState(1);
  const [configuring, setConfiguring] = useState<{
    slotId: string;
    product: Product;
  } | null>(null);

  const choose = (slotId: string, product: Product) => {
    if (productNeedsCustomizer(product)) {
      setConfiguring({ slotId, product });
      return;
    }
    setPicks((current) => ({
      ...current,
      [slotId]: {
        product,
        variant: null,
        addons: [],
        special_instructions: '',
      },
    }));
  };

  const complete = combo.slots.every((slot) => picks[slot.id]);
  const unitTotal = comboUnitTotal(combo, picks);
  const addonTotal = Object.values(picks).reduce(
    (sum, pick) =>
      sum + (pick?.addons ?? []).reduce((acc, a) => acc + Number(a.price) * (a.quantity || 1), 0),
    0,
  );

  const handleAdd = () => {
    if (!complete) return;
    onAdd(buildComboCartLines(combo, picks, quantity, { onlinePlatformSelected }));
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        data-testid="combo-modal"
        className="bg-card rounded-2xl w-full max-w-lg max-h-[92vh] flex flex-col"
      >
        <div className="flex justify-between items-center p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-foreground">{combo.name}</h2>
            <p className="text-brand font-semibold">{fmt(Number(combo.price))}</p>
            {combo.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{combo.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground active:bg-muted"
            aria-label={t('close')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {combo.slots.map((slot) => {
            const pick = picks[slot.id];
            return (
              <div key={slot.id}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-sm text-foreground">{slot.name}</h3>
                  {!pick && (
                    <span className="text-xs font-medium text-red-500 dark:text-red-400">
                      {t('required')}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {slot.options.map((option) => {
                    const product = productById.get(String(option.product_id));
                    if (!product) return null;
                    const isSel = pick && String(pick.product.id) === String(option.product_id);
                    return (
                      <button
                        key={option.product_id}
                        type="button"
                        aria-pressed={Boolean(isSel)}
                        onClick={() => choose(slot.id, product)}
                        className={`touch-target min-h-14 rounded-lg border px-3 py-2 text-start text-sm transition-colors ${
                          isSel
                            ? 'border-brand bg-[var(--color-brand-light)]'
                            : 'border-border hover:border-brand/40'
                        }`}
                      >
                        <span className="flex items-center gap-1.5 font-medium text-foreground">
                          {isSel && <Check size={14} className="text-brand shrink-0" />}
                          {product.name}
                        </span>
                        {option.upcharge > 0 && (
                          <span className="text-xs text-muted-foreground">
                            +{fmt(option.upcharge)}
                          </span>
                        )}
                        {isSel &&
                          (pick.variant || pick.addons.length > 0 || pick.special_instructions) && (
                            <span className="block text-xs text-muted-foreground mt-0.5 break-words">
                              {[
                                pick.variant?.name,
                                ...pick.addons.map((a) => a.name),
                                pick.special_instructions,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-5 border-t border-border">
          <div className="flex items-center justify-center gap-4 mb-4">
            <button
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              className="touch-target rounded-full bg-muted flex items-center justify-center"
              aria-label={t('remove')}
            >
              <Minus size={18} />
            </button>
            <span className="text-lg font-bold w-10 text-center tabular-nums">{quantity}</span>
            <button
              onClick={() => setQuantity(quantity + 1)}
              className="touch-target rounded-full bg-muted flex items-center justify-center"
              aria-label={t('addItems')}
            >
              <Plus size={18} />
            </button>
          </div>
          <Button onClick={handleAdd} disabled={!complete} className="w-full" size="lg">
            {complete
              ? t('addToCart', {
                  total: fmt((unitTotal + addonTotal) * quantity),
                })
              : t('comboChooseEverySlot')}
          </Button>
        </div>
      </div>

      {configuring && (
        <AddonModal
          product={configuring.product}
          currency={currency}
          comboSlot
          oneTap={oneTap}
          quickNotes={quickNotesForProduct(quickNotes, configuring.product)}
          onlinePlatformSelected={onlinePlatformSelected}
          initialAddons={
            picks[configuring.slotId] &&
            String(picks[configuring.slotId]?.product.id) === String(configuring.product.id)
              ? picks[configuring.slotId]?.addons
              : undefined
          }
          initialInstructions={
            String(picks[configuring.slotId]?.product.id) === String(configuring.product.id)
              ? picks[configuring.slotId]?.special_instructions
              : undefined
          }
          initialVariant={
            String(picks[configuring.slotId]?.product.id) === String(configuring.product.id)
              ? picks[configuring.slotId]?.variant
              : undefined
          }
          onAdd={(
            product: Product,
            _quantity: number,
            addons: Addon[],
            specialInstructions: string,
            variant: ProductVariant | null,
          ) => {
            setPicks((current) => ({
              ...current,
              [configuring.slotId]: {
                product,
                variant,
                addons,
                special_instructions: specialInstructions,
              },
            }));
          }}
          onClose={() => setConfiguring(null)}
        />
      )}
    </div>
  );
}
