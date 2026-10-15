import { test, expect } from '@playwright/test';

async function requireRealLogin(page) {
  await page.goto('.');
  const configurationRequired = page.getByText('Configuración requerida');
  test.skip(await configurationRequired.isVisible().catch(() => false), 'Requires the real Supabase URL and publishable key.');
}

test.describe('real pharmacy login interactions', () => {
  test('conserva el login dividido anterior de la farmacia', async ({ page }) => {
    await requireRealLogin(page);

    await expect(page.locator('.auth-page')).toBeVisible();
    await expect(page.locator('.auth-aside')).toBeVisible();
    await expect(page.locator('.auth-main')).toBeVisible();
    await expect(page.locator('.pharmacy-login-page')).toHaveCount(0);
    await expect(page.locator('.login-delivery-scene')).toHaveCount(0);
    await expect(page.locator('.hero-route')).toHaveCount(0);
    await expect(page.locator('.hero-copy-animated')).toBeVisible();
  });

  test('mantiene los campos simples del login anterior', async ({ page }) => {
    await requireRealLogin(page);

    await expect(page.getByLabel('Usuario o correo')).toHaveAttribute('placeholder', 'juan.perez');
    await expect(page.getByLabel('Contraseña')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Entrar al panel' })).toBeVisible();
  });

  test('returns a generic error for invalid credentials through Supabase Auth', async ({ page }) => {
    await requireRealLogin(page);

    await page.getByLabel('Usuario o correo').fill('login-test-user@example.invalid');
    await page.getByLabel('Contraseña').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Entrar al panel' }).click();

    await expect(page.getByRole('alert')).toContainText('Correo o contraseña incorrectos');
    await expect(page.getByRole('button', { name: 'Entrar al panel' })).toBeEnabled();
  });

  test('keeps the login within the viewport on mobile', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await requireRealLogin(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await page.locator('.auth-form-wrap').boundingBox()).not.toBeNull();
    await context.close();
  });

  test('writes the hero copy and falls back to the complete copy with reduced motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await requireRealLogin(page);
    await page.waitForTimeout(850);
    const partialTitle = await page.locator('.hero-copy-animated h1').textContent();
    expect(partialTitle?.trim().length).toBeGreaterThan(0);
    expect(partialTitle?.trim().length).toBeLessThan('Cada entrega, siempre registrada.'.length + 1);
    await context.close();

    const reducedContext = await browser.newContext({ reducedMotion: 'reduce' });
    const reducedPage = await reducedContext.newPage();
    await requireRealLogin(reducedPage);
    await expect(reducedPage.locator('.hero-copy-animated h1')).toContainText('Cada entrega, siempre registrada.');
    await expect(reducedPage.locator('.hero-copy-animated p')).toContainText('Publica, sigue y deja registrado cada domicilio desde el punto de farmacia.');
    await reducedContext.close();
  });
});
