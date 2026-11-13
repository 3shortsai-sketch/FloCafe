'use client';

import { useCallback, useEffect, useState } from 'react';
import { Layers, Pencil, Plus, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/settings/Toggle';
import { useConfirm } from '@/hooks/use-confirm';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Combo, Product } from '@/lib/types';

interface SlotDraft {
  id?: string;
  name: string;
  options: { product_id: string; upcharge: string }[];
}

interface ComboDraft {
  id?: string;
  name: string;
  description: string;
  price: string;
  is_active: boolean;
  upsell_enabled: boolean;
  slots: SlotDraft[];
}

const emptyDraft = (): ComboDraft => ({
  name: '',
  description: '',
  price: '',
  is_active: true,
  upsell_enabled: true,
  slots: [{ name: '', options: [] }],
});

function toDraft(combo: Combo): ComboDraft {
  return {
    id: combo.id,
    name: combo.name,
    description: combo.description ?? '',
    price: String(combo.price),
    is_active: Boolean(combo.is_active),
    upsell_enabled: Boolean(combo.upsell_enabled),
    slots: combo.slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      options: slot.options.map((option) => ({
        product_id: String(option.product_id),
        upcharge: option.upcharge ? String(option.upcharge) : '',
      })),
    })),
  };
}

function apiError(error: unknown): string | null {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : null;
}

/** Owner and manager editor for combo meals: a bundle price over slots of real products. */
export default function CombosTab({ products }: { products: Product[] }) {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { confirm, ConfirmDialog } = useConfirm();
  const [combos, setCombos] = useState<Combo[]>([]);
  const [draft, setDraft] = useState<ComboDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [productFilter, setProductFilter] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    api
      .get('/combos?include_inactive=true')
      .then((res) => setCombos(res.data?.combos ?? []))
      .catch(() => toast.error(t('combosLoadFailed')));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const sellable = products.filter(
    (product) => product.is_active !== false && !product.allow_fractional_quantity,
  );
  const productName = (id: string) =>
    products.find((product) => String(product.id) === id)?.name ?? id;

  const updateSlot = (index: number, patch: Partial<SlotDraft>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            slots: current.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)),
          }
        : current,
    );

  const toggleOption = (index: number, productId: string) => {
    const slot = draft?.slots[index];
    if (!slot) return;
    const has = slot.options.some((option) => option.product_id === productId);
    updateSlot(index, {
      options: has
        ? slot.options.filter((option) => option.product_id !== productId)
        : [...slot.options, { product_id: productId, upcharge: '' }],
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const payload = {
      name: draft.name,
      description: draft.description || null,
      price: Number(draft.price),
      is_active: draft.is_active,
      upsell_enabled: draft.upsell_enabled,
      slots: draft.slots.map((slot) => ({
        id: slot.id,
        name: slot.name,
        options: slot.options.map((option) => ({
          product_id: option.product_id,
          upcharge: Number(option.upcharge) || 0,
        })),
      })),
    };
    try {
      if (draft.id) await api.put(`/combos/${draft.id}`, payload);
      else await api.post('/combos', payload);
      toast.success(t('comboSaved'));
      setDraft(null);
      load();
    } catch (error) {
      toast.error(apiError(error) ?? t('comboSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (combo: Combo) => {
    if (
      !(await confirm(t('comboDeleteConfirm', { name: combo.name }), {
        destructive: true,
        confirmLabel: tCommon('delete'),
      }))
    )
      return;
    try {
      await api.delete(`/combos/${combo.id}`);
      load();
    } catch {
      toast.error(tCommon('failedToDelete'));
    }
  };

  const canSave =
    draft !== null &&
    draft.name.trim() !== '' &&
    draft.price.trim() !== '' &&
    Number(draft.price) >= 0 &&
    draft.slots.length > 0 &&
    draft.slots.every((slot) => slot.name.trim() !== '' && slot.options.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground max-w-2xl">{t('combosIntro')}</p>
        <Button onClick={() => setDraft(emptyDraft())}>
          <Plus size={16} className="me-1" /> {t('addCombo')}
        </Button>
      </div>

      {combos.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-muted-foreground">
          <Layers size={32} />
          <p className="mt-2 text-sm">{t('combosEmpty')}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {combos.map((combo) => (
            <div key={combo.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{combo.name}</p>
                  <p className="text-sm font-medium text-brand">{fmt(Number(combo.price))}</p>
                </div>
                <div className="flex items-center gap-1">
                  {!combo.is_active && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {tCommon('inactive')}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={tCommon('edit')}
                    onClick={() => setDraft(toDraft(combo))}
                    className="touch-target rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={tCommon('delete')}
                    onClick={() => void remove(combo)}
                    className="touch-target rounded-md text-muted-foreground hover:text-red-500"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {combo.slots.map((slot) => (
                  <li key={slot.id}>
                    <span className="font-medium text-foreground">{slot.name}:</span>{' '}
                    {slot.options
                      .map((option) =>
                        option.upcharge > 0
                          ? `${option.product_name} (+${fmt(option.upcharge)})`
                          : option.product_name,
                      )
                      .join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl bg-card">
            <div className="flex items-center justify-between border-b border-border p-5">
              <h2 className="text-lg font-bold text-foreground">
                {draft.id ? t('editCombo') : t('addCombo')}
              </h2>
              <button
                type="button"
                aria-label={tCommon('cancel')}
                onClick={() => setDraft(null)}
                className="touch-target rounded-full text-muted-foreground hover:text-foreground"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-foreground">
                    {t('comboName')}
                  </span>
                  <input
                    value={draft.name}
                    maxLength={100}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-foreground">
                    {t('comboPrice')}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={draft.price}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-foreground">
                  {t('comboDescription')}
                </span>
                <input
                  value={draft.description}
                  maxLength={500}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                />
              </label>
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-2">
                  <Toggle
                    value={draft.is_active}
                    label={tCommon('active')}
                    onChange={(v) => setDraft({ ...draft, is_active: v })}
                  />
                  <span className="text-sm text-foreground">{tCommon('active')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    value={draft.upsell_enabled}
                    label={t('comboUpsell')}
                    onChange={(v) => setDraft({ ...draft, upsell_enabled: v })}
                  />
                  <span className="text-sm text-foreground">{t('comboUpsell')}</span>
                </div>
              </div>

              {draft.slots.map((slot, index) => {
                const filter = (productFilter[index] ?? '').trim().toLowerCase();
                const candidates = sellable.filter(
                  (product) => !filter || product.name.toLowerCase().includes(filter),
                );
                return (
                  <div
                    key={slot.id ?? `new-${index}`}
                    className="rounded-xl border border-border p-4"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={slot.name}
                        maxLength={100}
                        placeholder={t('comboSlotNamePlaceholder')}
                        aria-label={t('comboSlotName')}
                        onChange={(e) => updateSlot(index, { name: e.target.value })}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium outline-none focus:ring-2 focus:ring-brand"
                      />
                      {draft.slots.length > 1 && (
                        <button
                          type="button"
                          aria-label={tCommon('remove')}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              slots: draft.slots.filter((_, i) => i !== index),
                            })
                          }
                          className="touch-target rounded-md text-muted-foreground hover:text-red-500"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>

                    {slot.options.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {slot.options.map((option) => (
                          <div
                            key={option.product_id}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {productName(option.product_id)}
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={option.upcharge}
                              placeholder={t('comboUpchargePlaceholder')}
                              aria-label={t('comboUpcharge')}
                              onChange={(e) =>
                                updateSlot(index, {
                                  options: slot.options.map((o) =>
                                    o.product_id === option.product_id
                                      ? { ...o, upcharge: e.target.value }
                                      : o,
                                  ),
                                })
                              }
                              className="w-28 rounded-lg border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-brand"
                            />
                            <button
                              type="button"
                              aria-label={tCommon('remove')}
                              onClick={() => toggleOption(index, option.product_id)}
                              className="text-muted-foreground hover:text-red-500"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <input
                      value={productFilter[index] ?? ''}
                      placeholder={t('comboSearchProducts')}
                      aria-label={t('comboSearchProducts')}
                      onChange={(e) =>
                        setProductFilter((current) => ({
                          ...current,
                          [index]: e.target.value,
                        }))
                      }
                      className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand"
                    />
                    <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                      {candidates.map((product) => {
                        const selected = slot.options.some(
                          (option) => option.product_id === String(product.id),
                        );
                        return (
                          <button
                            key={product.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => toggleOption(index, String(product.id))}
                            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                              selected
                                ? 'border-brand bg-[var(--color-brand-light)] text-brand'
                                : 'border-border text-muted-foreground hover:bg-muted'
                            }`}
                          >
                            {product.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {draft.slots.length < 10 && (
                <Button
                  variant="outline"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      slots: [...draft.slots, { name: '', options: [] }],
                    })
                  }
                >
                  <Plus size={16} className="me-1" /> {t('addComboSlot')}
                </Button>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border p-5">
              <Button variant="outline" onClick={() => setDraft(null)}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={() => void save()} disabled={!canSave || saving}>
                {tCommon('save')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
