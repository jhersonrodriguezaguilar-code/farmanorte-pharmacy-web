import { test, expect } from '@playwright/test';

test('renders the explicit configuration state without fake data', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('.');
  const configurationRequired = page.getByText('Configuración requerida');
  if (await configurationRequired.isVisible().catch(() => false)) {
    await expect(page.getByText('Conecta el panel con Supabase')).toBeVisible();
  } else {
    await expect(page.getByText('Acceso de farmacia')).toBeVisible();
    await expect(page.getByText('Autenticación protegida por Supabase Auth')).toBeVisible();
  }
  await expect(page.getByText('No hay domicilios')).not.toBeVisible();
  expect(pageErrors, `Page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
