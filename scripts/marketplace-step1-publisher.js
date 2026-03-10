/**
 * Step 1: Create the "aimax" publisher on VS Code Marketplace
 *
 * Usage: node scripts/marketplace-step1-publisher.js
 *
 * This script opens the VS Code Marketplace publisher creation page.
 * YOU need to log in with your Microsoft account.
 * Then the script fills in the form and waits for you to confirm.
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Opening VS Code Marketplace publisher creation page...');
  console.log('Please log in with your Microsoft account when prompted.\n');

  await page.goto('https://marketplace.visualstudio.com/manage/createpublisher');

  // Wait for the user to log in — the page will redirect after login
  console.log('Waiting for you to complete Microsoft login...');
  await page.waitForURL('**/manage/createpublisher**', { timeout: 120000 });

  // Fill in the publisher form
  console.log('Filling in publisher form...');

  try {
    // Publisher ID
    const publisherIdInput = await page.waitForSelector('input[name="PublisherName"], input[id*="publisher"], input[placeholder*="publisher" i]', { timeout: 15000 });
    await publisherIdInput.fill('aimax');

    // Display Name
    const displayNameInput = await page.waitForSelector('input[name="DisplayName"], input[placeholder*="display" i], input[placeholder*="name" i]', { timeout: 5000 });
    await displayNameInput.fill('AIMax');

    // Description (optional)
    try {
      const descInput = await page.waitForSelector('textarea[name="Description"], textarea[placeholder*="description" i]', { timeout: 3000 });
      await descInput.fill('AI-powered viewer for HTML/Markdown artifacts in VS Code');
    } catch (_) {
      console.log('(No description field found, skipping)');
    }

    console.log('\n✅ Form filled. Review the form in the browser and click "Create publisher".');
    console.log('The browser will stay open until you close it.\n');
  } catch (err) {
    console.log('\nCould not auto-fill the form (page structure may have changed).');
    console.log('Please fill in manually:');
    console.log('  Publisher ID: aimax');
    console.log('  Display Name: AIMax');
    console.log('  Description: AI-powered viewer for HTML/Markdown artifacts in VS Code');
  }

  // Keep browser open until user closes it
  await page.waitForTimeout(300000); // 5 minutes max
  await browser.close();
})();
