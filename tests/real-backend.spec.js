import { test, expect } from '@playwright/test';

test('real Supabase configuration reaches the pharmacy login', async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_REAL_BACKEND, 'Requires the real Supabase URL and publishable key.');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('.');
  await expect(page.getByText('Acceso de farmacia')).toBeVisible();
  await expect(page.getByLabel('Usuario o correo')).toBeVisible();
  await expect(page.getByText('Acceso seguro para personal autorizado')).toBeVisible();
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
