import { armKillSwitch, disarmKillSwitch } from './utils/timeoutManager.js';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'dentist', 
        location = 'Sydney', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL']
    });

    log.info(`Searching HealthEngine Australia for "${keyword}" in "${location}"`);
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            // Wait for main container
            await page.waitForSelector('main, .practice-card, .search-results', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM'));

            // Check if blocked
            const title = await page.title();
            if (title.includes('403') || title.includes('Forbidden') || title.includes('Attention Required')) {
                throw new Error('Blocked by Cloudflare/AWS WAF. Retrying with residential proxy...');
            }

            // Extract from standard HTML tags often used in HealthEngine
            const clinicItems = await page.$$('.practice-card, [data-testid="practice-card"], article, .search-result-item');
            
            for (const item of clinicItems) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, h3, .practice-name, [data-testid="practice-name"]');
                if (!nameElement) continue;
                const clinicName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.practice-address, .address, [data-testid="practice-address"]');
                const address = addressElement ? (await addressElement.innerText()).trim() : '';

                // Ratings (e.g. "4.8 (120 reviews)")
                const ratingElement = await item.$('.rating, [data-testid="rating-score"], .review-score');
                const rating = ratingElement ? (await ratingElement.innerText()).trim() : '';
                
                // Phones are sometimes hidden behind a "Show Number" button or on the detail page
                const phoneBtn = await item.$('button:has-text("Phone"), .phone-button, a[href^="tel:"]');
                let phone = '';
                if (phoneBtn) {
                    try {
                        const href = await phoneBtn.getAttribute('href');
                        if (href && href.startsWith('tel:')) {
                            phone = href.replace('tel:', '');
                        } else {
                            // It's a button, click it to reveal
                            await phoneBtn.click();
                            await page.waitForTimeout(500);
                            const updatedPhone = await item.$('a[href^="tel:"]');
                            phone = updatedPhone ? (await updatedPhone.getAttribute('href')).replace('tel:', '') : (await phoneBtn.innerText());
                        }
                    } catch (e) {}
                }

                // If HealthEngine doesn't show phone directly, they usually have "Book Now" links,
                // but the clinic name and address is the primary B2B lead info.
                
                const urlElement = await item.$('a[href^="/dentist/"], a[href^="/clinic/"], a.practice-link');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://healthengine.com.au').toString() : listingUrl;

                if (clinicName && clinicName.length > 2) {
                    const record = {
                        clinicName,
                        specialty: keyword,
                        address,
                        phone,
                        rating,
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${clinicName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('a[aria-label="Next page"], a:has-text("Next"), .pagination-next');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://healthengine.com.au').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const startUrl = `https://healthengine.com.au/find/${encodeURIComponent(keyword.toLowerCase())}/${encodeURIComponent(location)}`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Done! Extracted ${extractedCount} dental leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
