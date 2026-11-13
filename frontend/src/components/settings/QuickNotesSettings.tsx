'use client';

import { useEffect, useState } from 'react';
import { MessageSquareText, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import type { Category, QuickNote } from '@/lib/types';

const MAX_NOTES = 40;
const MAX_NOTE_LENGTH = 40;

function flattenCategories(list: Category[]): Category[] {
  return list.flatMap((category) => [
    category,
    ...flattenCategories((category as Category & { children?: Category[] }).children ?? []),
  ]);
}

/** Owner-managed one-tap item notes, optionally limited to some categories. */
export default function QuickNotesSettings({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.get('/settings/quick-notes', { signal: controller.signal }),
      api.get('/categories', { signal: controller.signal }),
    ])
      .then(([notesResponse, categoriesResponse]) => {
        setNotes(notesResponse.data?.quick_notes ?? []);
        const list = categoriesResponse.data?.categories ?? categoriesResponse.data;
        setCategories(flattenCategories(Array.isArray(list) ? list : []));
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const save = async (next: QuickNote[]) => {
    setSaving(true);
    try {
      const response = await api.put('/settings/quick-notes', {
        quick_notes: next,
      });
      setNotes(response.data?.quick_notes ?? next);
      toast.success(t('quickNotesSaved'), { id: 'quick-notes' });
    } catch {
      toast.error(t('quickNotesSaveFailed'), { id: 'quick-notes' });
    } finally {
      setSaving(false);
    }
  };

  const addNote = () => {
    const text = draft.trim();
    if (!text) return;
    if (notes.some((note) => note.text.toLocaleLowerCase() === text.toLocaleLowerCase())) {
      setDraft('');
      return;
    }
    setDraft('');
    void save([...notes, { text, category_ids: [] }]);
  };

  const toggleCategory = (index: number, categoryId: string) => {
    const next = notes.map((note, i) => {
      if (i !== index) return note;
      const has = note.category_ids.includes(categoryId);
      return {
        ...note,
        category_ids: has
          ? note.category_ids.filter((id) => id !== categoryId)
          : [...note.category_ids, categoryId],
      };
    });
    void save(next);
  };

  return (
    <div
      data-setting-section="pos-quick-notes"
      className="bg-card rounded-xl border border-border p-6"
    >
      <div className="flex items-center gap-2 mb-1">
        <MessageSquareText size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t('quickNotesTitle')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">{t('quickNotesHint')}</p>

      <div className="space-y-3">
        {notes.map((note, index) => (
          <div key={note.text} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm text-foreground">{note.text}</span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={tCommon('remove')}
                  disabled={saving}
                  onClick={() => void save(notes.filter((_, i) => i !== index))}
                  className="touch-target rounded-md text-muted-foreground hover:text-red-500"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {categories.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="text-xs text-muted-foreground self-center me-1">
                  {note.category_ids.length === 0 ? t('quickNotesAllItems') : t('quickNotesOnlyIn')}
                </span>
                {categories.map((category) => {
                  const active = note.category_ids.includes(String(category.id));
                  return (
                    <button
                      key={category.id}
                      type="button"
                      disabled={!canEdit || saving}
                      aria-pressed={active}
                      onClick={() => toggleCategory(index, String(category.id))}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
                        active
                          ? 'border-brand bg-[var(--color-brand-light)] text-brand'
                          : 'border-border text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {category.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {notes.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('quickNotesEmpty')}</p>
        )}
      </div>

      {canEdit && notes.length < MAX_NOTES && (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addNote();
          }}
        >
          <input
            type="text"
            value={draft}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('quickNotesPlaceholder')}
            aria-label={t('quickNotesPlaceholder')}
            className="flex-1 min-h-10 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          />
          <Button type="submit" disabled={saving || !draft.trim()}>
            <Plus size={16} className="me-1" /> {tCommon('add')}
          </Button>
        </form>
      )}
    </div>
  );
}
