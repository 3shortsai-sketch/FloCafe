export const MAX_QUICK_NOTES = 40;
export const MAX_QUICK_NOTE_LENGTH = 40;
const MAX_QUICK_NOTE_CATEGORIES = 100;

/** A one-tap item note; an empty `category_ids` offers it on every item. */
export interface QuickNote {
  text: string;
  category_ids: string[];
}

export class QuickNotesValidationError extends Error {
  readonly statusCode = 400;
}

export function parseQuickNotes(value: unknown): QuickNote[] {
  if (!Array.isArray(value)) throw new QuickNotesValidationError('quick_notes must be an array');
  if (value.length > MAX_QUICK_NOTES) {
    throw new QuickNotesValidationError(`At most ${MAX_QUICK_NOTES} quick notes are allowed`);
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text) throw new QuickNotesValidationError('Every quick note needs text');
    if (text.length > MAX_QUICK_NOTE_LENGTH) {
      throw new QuickNotesValidationError(
        `Quick notes must be at most ${MAX_QUICK_NOTE_LENGTH} characters`,
      );
    }
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) throw new QuickNotesValidationError(`"${text}" is listed twice`);
    seen.add(key);
    const categories = entry.category_ids ?? [];
    if (
      !Array.isArray(categories) ||
      categories.length > MAX_QUICK_NOTE_CATEGORIES ||
      categories.some((id) => typeof id !== 'string' || !id)
    ) {
      throw new QuickNotesValidationError('category_ids must be a list of category ids');
    }
    return { text, category_ids: Array.from(new Set(categories as string[])) };
  });
}

/** A stored value that no longer parses reads as no notes rather than breaking the POS. */
export function readQuickNotes(stored: string | null | undefined): QuickNote[] {
  if (!stored) return [];
  try {
    return parseQuickNotes(JSON.parse(stored));
  } catch {
    return [];
  }
}
