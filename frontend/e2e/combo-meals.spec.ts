import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

const MANAGER_TOKEN = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
const headers = { Authorization: `Bearer ${MANAGER_TOKEN}` };

async function loginAndOpenPos(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
}

test.describe('combo meals at the till', () => {
  const created: { products: string[]; combo?: string; group?: string } = { products: [] };
  let originalBusiness: Record<string, unknown> | null = null;
  let originalNotes: unknown[] | null = null;

  test.afterEach(async ({ request }) => {
    if (created.combo) await request.delete(`${BASE}/api/combos/${created.combo}`, { headers });
    for (const id of created.products) {
      await request.delete(`${BASE}/api/products/${id}`, { headers });
    }
    if (created.group)
      await request.delete(`${BASE}/api/addon-groups/${created.group}`, { headers });
    if (originalNotes) {
      await request.put(`${BASE}/api/settings/quick-notes`, {
        headers,
        data: { quick_notes: originalNotes },
      });
    }
    if (originalBusiness) {
      await request.put(`${BASE}/api/settings/business`, { headers, data: originalBusiness });
    }
    created.products = [];
    created.combo = undefined;
    created.group = undefined;
    originalNotes = null;
    originalBusiness = null;
  });

  test('a combo is picked, priced as one bundle and placed as real items', async ({ page }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const business = await page.request.get(`${BASE}/api/settings/business`, { headers });
    originalBusiness = await business.json();
    const postpaid = await page.request.put(`${BASE}/api/settings/business`, {
      headers,
      data: { ...originalBusiness, billing_type: 'postpaid' },
    });
    expect(postpaid.ok()).toBeTruthy();
    originalNotes = (
      await (await page.request.get(`${BASE}/api/settings/quick-notes`, { headers })).json()
    ).quick_notes;
    const notes = await page.request.put(`${BASE}/api/settings/quick-notes`, {
      headers,
      data: { quick_notes: [{ text: 'Extra crispy', category_ids: [] }] },
    });
    expect(notes.ok(), 'quick notes are saved').toBeTruthy();

    const group = await page.request.post(`${BASE}/api/addon-groups`, {
      headers,
      data: {
        name: `Sauce ${suffix}`,
        is_required: true,
        min_selection: 1,
        max_selection: 1,
        addons: [
          { name: `Garlic ${suffix}`, price: 0, is_default: true },
          { name: `Spicy ${suffix}`, price: 0 },
        ],
      },
    });
    expect(group.status()).toBe(201);
    created.group = (await group.json()).addon_group.id;

    const makeProduct = async (name: string, price: number, withSauce = false) => {
      const response = await page.request.post(`${BASE}/api/products`, {
        headers,
        data: {
          name,
          category_id: 'e2e-category',
          price,
          ...(withSauce ? { addon_group_ids: [created.group] } : {}),
        },
      });
      expect(response.status(), `${name} is created`).toBe(201);
      const id = (await response.json()).product.id as string;
      created.products.push(id);
      return id;
    };
    const bowlName = `Rice Bowl ${suffix}`;
    const friesName = `Fries ${suffix}`;
    const drinkName = `Slushie ${suffix}`;
    const bowl = await makeProduct(bowlName, 100, true);
    const fries = await makeProduct(friesName, 80);
    const drink = await makeProduct(drinkName, 60);
    const comboName = `Boom Trio ${suffix}`;
    const combo = await page.request.post(`${BASE}/api/combos`, {
      headers,
      data: {
        name: comboName,
        price: 199,
        slots: [
          { name: 'Rice bowl', options: [{ product_id: bowl }] },
          { name: 'Fries', options: [{ product_id: fries }] },
          { name: 'Drink', options: [{ product_id: drink }] },
        ],
      },
    });
    expect(combo.status()).toBe(201);
    created.combo = (await combo.json()).combo.id;

    await loginAndOpenPos(page);

    await page.getByTestId('pos-product-card').filter({ hasText: friesName }).click();
    const banner = page.getByTestId('combo-upgrade-banner');
    await expect(banner, 'adding a combo item alone offers the combo').toContainText(comboName);
    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toHaveCount(0);
    await page
      .getByTestId('cart-item')
      .filter({ hasText: friesName })
      .getByTestId('cart-item-remove-btn')
      .click();

    await page
      .getByTestId('pos-combo-strip')
      .getByRole('button', { name: new RegExp(comboName) })
      .click();
    const modal = page.getByTestId('combo-modal');
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole('button', { name: 'Pick an item for every choice' }),
      'the combo cannot be added before the rice bowl is chosen',
    ).toBeDisabled();
    await modal.getByRole('button', { name: new RegExp(bowlName) }).click();
    await expect(
      page.getByText('Selection complete', { exact: true }),
      'the default sauce is preselected',
    ).toBeVisible();
    await page
      .getByTestId('quick-note-chips')
      .getByRole('button', { name: 'Extra crispy' })
      .click();
    await page.getByRole('button', { name: 'Use this choice' }).click();
    await expect(modal.getByText(`Garlic ${suffix} · Extra crispy`)).toBeVisible();
    await modal.getByRole('button', { name: /Add to Cart/ }).click();

    const comboRow = page.getByTestId('cart-combo');
    await expect(comboRow).toContainText(comboName);
    await expect(comboRow.getByTestId('cart-item')).toHaveCount(3);

    const orderResponse = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/orders' && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Place Order', exact: true }).click();
    const placed = await orderResponse;
    expect(placed.status(), 'the combo order is accepted').toBe(201);
    const order = (await placed.json()).order;
    const lines = order.items.filter(
      (item: { combo_name?: string }) => item.combo_name === comboName,
    );
    expect(lines, 'every component is a real order line under the combo').toHaveLength(3);
    const subtotal = lines.reduce(
      (sum: number, item: { subtotal: number }) => sum + item.subtotal,
      0,
    );
    expect(Number(subtotal.toFixed(2)), 'the components add up to the combo price').toBe(199);
    const bowlLine = lines.find((item: { product_id: string }) => item.product_id === bowl);
    expect(bowlLine.special_instructions).toBe('Extra crispy');
  });
});

test.describe('combo and quick note setup', () => {
  let comboId: string | undefined;
  let productId: string | undefined;
  let originalNotes: unknown[] | null = null;

  test.afterEach(async ({ request }) => {
    if (comboId) await request.delete(`${BASE}/api/combos/${comboId}`, { headers });
    if (productId) await request.delete(`${BASE}/api/products/${productId}`, { headers });
    if (originalNotes) {
      await request.put(`${BASE}/api/settings/quick-notes`, {
        headers,
        data: { quick_notes: originalNotes },
      });
    }
    comboId = undefined;
    productId = undefined;
    originalNotes = null;
  });

  test('a manager builds a combo and a quick note from the screens', async ({ page }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const productName = `Combo Part ${suffix}`;
    const product = await page.request.post(`${BASE}/api/products`, {
      headers,
      data: { name: productName, category_id: 'e2e-category', price: 50 },
    });
    expect(product.status()).toBe(201);
    productId = (await product.json()).product.id;
    originalNotes = (
      await (await page.request.get(`${BASE}/api/settings/quick-notes`, { headers })).json()
    ).quick_notes;

    await loginAndOpenPos(page);
    await page.goto(`${BASE}/products?tab=combos`);
    await page.getByRole('button', { name: 'Add combo' }).click();
    await page.getByLabel('Combo name').fill(`Lunch Set ${suffix}`);
    await page.getByLabel('Combo price').fill('120');
    await page.getByLabel('Choice name').fill('Main');
    await page.getByLabel('Search products to add').fill(productName);
    await page.getByRole('button', { name: productName, exact: true }).click();
    const save = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/combos' && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await save;
    expect(saved.status(), 'the combo is saved').toBe(201);
    comboId = (await saved.json()).combo.id;
    await expect(page.getByText(`Lunch Set ${suffix}`)).toBeVisible();

    await page.goto(`${BASE}/settings?tab=pos`);
    const section = page.locator('[data-setting-section="pos-quick-notes"]');
    await section.getByLabel('New note, e.g. Extra crispy').fill(`No ice ${suffix}`);
    const notes = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/settings/quick-notes' &&
        res.request().method() === 'PUT',
    );
    await section.getByRole('button', { name: 'Add' }).click();
    expect((await notes).status(), 'the quick note is saved').toBe(200);
    await expect(section.getByText(`No ice ${suffix}`)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'One-tap add' })).toBeVisible();
  });
});
