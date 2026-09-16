#!/usr/bin/env node
// Auto-login script for survey platforms using Playwright
// Usage: node auto_login.mjs <port> [platform]

import { chromium } from 'playwright';

const PORT = Number(process.argv[2]);
if (!PORT) {
  console.error('Usage: node auto_login.mjs <port>');
  process.exit(1);
}

// Platform URL mapping
const PLATFORMS = {
  opinionoutpost: 'https://www.opinionoutpost.com',
  swagbucks: 'https://www.swagbucks.com/surveys',
  surveyjunkie: 'https://app.surveyjunkie.com/',
  primeopinion: 'https://app.primeopinion.com/app-login',
  eureka: 'https://eurekapoints.com/'
};

// Port to platform mapping (from fleet config)
const PORT_TO_PLATFORM = {
  3013: 'opinionoutpost',
  3014: 'swagbucks',
  3015: 'eureka',
  3016: 'surveyjunkie',
  3017: 'swagbucks'
};

const platform = PORT_TO_PLATFORM[PORT] || process.argv[3];
if (!platform) {
  console.error(`No platform configured for port ${PORT}`);
  process.exit(1);
}

const url = PLATFORMS[platform];
if (!url) {
  console.error(`Unknown platform: ${platform}`);
  process.exit(1);
}

console.log(`Auto-login for port ${PORT} (${platform}) -> ${url}`);

async function autoLogin() {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();
  
  try {
    console.log(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    
    // Wait for page to fully load
    await page.waitForTimeout(3000);
    
    console.log('Page loaded successfully');
    
    // Platform-specific login logic would go here
    // For now, just navigate and let the user manually log in if needed
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    // Keep browser open after navigation
    console.log('Auto-login complete. Browser will remain open.');
  }
}

autoLogin().catch(console.error);