'use client';

import { Layers, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Combo } from '@/lib/types';

/** Combo tiles above the product grid; hidden when the store sells no combos. */
export function ComboStrip({
  combos,
  onSelect,
}: {
  combos: Combo[];
  onSelect: (combo: Combo) => void;
}) {
  const t = useTranslations('pos');
  const fmt = useFormatCurrency();
  if (combos.length === 0) return null;
  return (
    <div
      data-testid="pos-combo-strip"
      className="mb-2 flex shrink-0 gap-2 overflow-x-auto pb-1"
      aria-label={t('combos')}
    >
      {combos.map((combo) => (
        <button
          key={combo.id}
          type="button"
          onClick={() => onSelect(combo)}
          className="touch-target flex min-w-40 shrink-0 items-center gap-2 rounded-xl border border-brand/40 bg-[var(--color-brand-light)] px-3 py-2 text-start transition-colors hover:border-brand"
        >
          <Layers size={18} className="shrink-0 text-brand" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">
              {combo.name}
            </span>
            <span className="block text-xs font-medium text-brand">{fmt(Number(combo.price))}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** A dismissible nudge to turn the item just added into a combo. */
export function ComboUpgradeBanner({
  comboName,
  extra,
  onAccept,
  onDismiss,
}: {
  comboName: string;
  extra: number;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('pos');
  const fmt = useFormatCurrency();
  return (
    <div
      role="status"
      data-testid="combo-upgrade-banner"
      className="mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950/40"
    >
      <Sparkles size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        {t('comboUpgradePrompt', { combo: comboName, extra: fmt(extra) })}
      </p>
      <button
        type="button"
        onClick={onAccept}
        className="touch-target shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-hover"
      >
        {t('comboUpgradeAccept')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('close')}
        className="touch-target shrink-0 rounded-md text-muted-foreground hover:text-foreground"
      >
        <X size={16} />
      </button>
    </div>
  );
}
