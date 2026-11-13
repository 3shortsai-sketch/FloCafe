import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import {
  ComboValidationError,
  createCombo,
  deleteCombo,
  getCombo,
  listCombos,
  updateCombo,
} from '../services/combos';

const router = Router();

function handleError(res: Response, error: unknown, context: string): void {
  if (error instanceof ComboValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.locals.postHogError = error;
  console.error(`[Combos] ${context}:`, error);
  res.status(500).json({ error: 'Internal server error' });
}

router.get('/', requirePermission('catalog.view'), (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    res.json({ combos: listCombos(getDatabase(), { includeInactive }) });
  } catch (error) {
    handleError(res, error, 'Error listing combos');
  }
});

router.get('/:id', requirePermission('catalog.view'), (req: Request, res: Response) => {
  try {
    const combo = getCombo(getDatabase(), String(req.params.id));
    if (!combo) return res.status(404).json({ error: 'Combo not found' });
    res.json({ combo });
  } catch (error) {
    handleError(res, error, 'Error fetching combo');
  }
});

router.post('/', requirePermission('catalog.manage'), (req: Request, res: Response) => {
  try {
    res.status(201).json({ combo: createCombo(getDatabase(), req.body || {}) });
  } catch (error) {
    handleError(res, error, 'Error creating combo');
  }
});

router.put('/:id', requirePermission('catalog.manage'), (req: Request, res: Response) => {
  try {
    const combo = updateCombo(getDatabase(), String(req.params.id), req.body || {});
    if (!combo) return res.status(404).json({ error: 'Combo not found' });
    res.json({ combo });
  } catch (error) {
    handleError(res, error, 'Error updating combo');
  }
});

router.delete('/:id', requirePermission('catalog.manage'), (req: Request, res: Response) => {
  try {
    if (!deleteCombo(getDatabase(), String(req.params.id))) {
      return res.status(404).json({ error: 'Combo not found' });
    }
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Error deleting combo');
  }
});

export { router as comboRoutes };
