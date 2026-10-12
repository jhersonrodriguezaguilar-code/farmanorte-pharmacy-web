import { test, expect } from '@playwright/test';

async function requireRealLogin(page) {
  await page.goto('.');
  const configurationRequired = page.getByText('Configuración requerida');
  test.skip(await configurationRequired.isVisible().catch(() => false), 'Requires the real Supabase URL and publishable key.');
}

test.describe('real pharmacy login interactions', () => {
  test('toggles password visibility without losing the value', async ({ page }) => {
    await requireRealLogin(page);

    const password = page.locator('#login-password');
    await password.fill('temporary-password');
    await page.getByRole('button', { name: 'Mostrar contraseña' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(password).toHaveValue('temporary-password');
    await page.getByRole('button', { name: 'Ocultar contraseña' }).click();
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveValue('temporary-password');
  });

  test('focuses the username field when password recovery starts empty', async ({ page }) => {
    await requireRealLogin(page);

    await page.getByRole('button', { name: '¿Olvidaste tu contraseña?' }).click();
    await expect(page.getByRole('alert')).toContainText('Escribe tu usuario o correo');
    await expect(page.getByLabel('Usuario o correo')).toBeFocused();
  });

  test('returns a generic error for invalid credentials through Supabase Auth', async ({ page }) => {
    await requireRealLogin(page);

    await page.getByLabel('Usuario o correo').fill('login-test-user@example.invalid');
    await page.locator('#login-password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Entrar al panel' }).click();

    await expect(page.getByRole('alert')).toContainText('No se pudo iniciar sesión');
    await expect(page.getByRole('button', { name: 'Entrar al panel' })).toBeEnabled();
  });

  test('keeps the login within the viewport on mobile', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await requireRealLogin(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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
