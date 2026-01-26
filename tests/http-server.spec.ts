import { test, expect } from '@playwright/test';

test.describe('HTTP Server', () => {
  test('root path redirects to /Artifacts/index.html', async ({ page }) => {
    const response = await page.goto('/');

    // Should redirect to /Artifacts/index.html
    expect(page.url()).toContain('/Artifacts/index.html');
    expect(response?.status()).toBe(200);
  });

  test('serves Artifacts/index.html directly', async ({ page }) => {
    const response = await page.goto('/Artifacts/index.html');

    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
  });

  test('returns 404 for non-existent files', async ({ page }) => {
    const response = await page.goto('/non-existent-file.html');

    expect(response?.status()).toBe(404);
  });

  test('serves markdown files as HTML', async ({ page }) => {
    const response = await page.goto('/Artifacts/guide_en.md');

    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
  });
});
