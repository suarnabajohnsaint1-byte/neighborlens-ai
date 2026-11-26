const { test, expect } = require('@playwright/test');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');

async function setLandmarkPhoto(page, color = '#64748b') {
    await page.evaluate(async color => {
        const canvas = document.createElement('canvas');

        canvas.width = 320;
        canvas.height = 240;

        const context = canvas.getContext('2d');

        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);

        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, 'image/jpeg', 0.9);
        });

        if (!blob) {
            throw new Error('Failed to generate test image.');
        }

        const photo = new File(
            [blob],
            'landmark.jpg',
            { type: 'image/jpeg' }
        );

        window.landmarkField.setPhoto(photo);
    }, color);
}

test.beforeEach(async ({ page }) => {
    await page.route('http://landmark.test/', route =>
        route.fulfill({
            contentType: 'text/html',
            body: `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport"
                        content="width=device-width, initial-scale=1">

                    <link rel="stylesheet"
                        href="/styles/components/landmark-field.css">
                </head>
                <body>
                    <form id="stepDetailsCard">
                        <div id="landmarkField"
                            class="citizen-landmark-section"></div>
                    </form>

                    <script src="/js/citizen/components/landmarkField.js"></script>
                </body>
                </html>
            `
        })
    );

    await page.route(
        '**/components/citizen/landmark-field.html',
        route => route.fulfill({
            path: path.join(
                frontend,
                'components/citizen/landmark-field.html'
            ),
            contentType: 'text/html'
        })
    );

    await page.route(
        '**/js/citizen/components/landmarkField.js',
        route => route.fulfill({
            path: path.join(
                frontend,
                'js/citizen/components/landmarkField.js'
            ),
            contentType: 'application/javascript'
        })
    );

    await page.route(
        '**/styles/components/landmark-field.css',
        route => route.fulfill({
            path: path.join(
                frontend,
                'styles/components/landmark-field.css'
            ),
            contentType: 'text/css'
        })
    );

    await page.goto('http://landmark.test/');

    await page.evaluate(async () => {
        const field = createCitizenLandmarkField({
            container: document.getElementById('landmarkField')
        });

        await field.mount();

        window.landmarkField = field;
    });
});

test('renders the landmark component', async ({ page }) => {
    await expect(
        page.locator('#landmarkDescription')
    ).toBeVisible();

    await expect(
        page.locator('#landmarkCameraBtn')
    ).toHaveText('Take photo');

    await expect(
        page.locator('#landmarkCharCounter')
    ).toHaveText('0/250');

    await expect(
        page.locator('#landmarkPreviewBtn')
    ).toBeHidden();
});

test('updates the character counter', async ({ page }) => {
    const description = page.locator('#landmarkDescription');

    await description.fill('Near the school');

    await expect(
        page.locator('#landmarkCharCounter')
    ).toHaveText('15/250');

    await description.clear();

    await expect(
        page.locator('#landmarkCharCounter')
    ).toHaveText('0/250');
});

test('enforces the maximum description length', async ({ page }) => {
    const description = page.locator('#landmarkDescription');

    const maxLength = await description.evaluate(
        element => element.maxLength
    );

    expect(maxLength).toBe(250);

    await description.fill('a'.repeat(maxLength));
    await description.press('End');
    await description.press('a');

    await expect(description).toHaveValue(
        'a'.repeat(maxLength)
    );

    await expect(
        page.locator('#landmarkCharCounter')
    ).toHaveText(`${maxLength}/${maxLength}`);
});

test('requires a landmark description', async ({ page }) => {
    const description = page.locator('#landmarkDescription');

    await expect(description).toHaveAttribute('required', '');

    expect(
        await description.evaluate(element => element.checkValidity())
    ).toBe(false);

    await description.fill('Near school');

    expect(
        await description.evaluate(element => element.checkValidity())
    ).toBe(true);
});

test('displays the captured landmark thumbnail', async ({ page }) => {
    await setLandmarkPhoto(page);

    await expect(
        page.locator('#landmarkPreviewBtn')
    ).toBeVisible();

    await expect(
        page.locator('#landmarkCameraLabel')
    ).toHaveText('Retake');

    await expect(
        page.locator('#landmarkField')
    ).toHaveAttribute('data-captured', 'true');

    await expect.poll(async () => {
        return page.locator('#landmarkPreview').evaluate(
            image => image.complete && image.naturalWidth > 0
        );
    }).toBe(true);
});

test('replaces the landmark thumbnail on retake', async ({ page }) => {
    await setLandmarkPhoto(page, '#64748b');

    const preview = page.locator('#landmarkPreview');
    const previousUrl = await preview.getAttribute('src');

    await setLandmarkPhoto(page, '#2563eb');

    const currentUrl = await preview.getAttribute('src');

    expect(previousUrl).toBeTruthy();
    expect(currentUrl).toBeTruthy();
    expect(currentUrl).not.toBe(previousUrl);

    await expect(
        page.locator('#landmarkCameraLabel')
    ).toHaveText('Retake');

    await expect.poll(async () => {
        return preview.evaluate(
            image => image.complete && image.naturalWidth > 0
        );
    }).toBe(true);
});

test('requires both photo and description', async ({ page }) => {
    const description = page.locator('#landmarkDescription');

    await description.fill('Beside the school entrance');

    expect(
        await page.evaluate(() => window.landmarkField.isComplete())
    ).toBe(false);

    await setLandmarkPhoto(page);

    expect(
        await page.evaluate(() => window.landmarkField.isComplete())
    ).toBe(true);

    await description.fill('   ');

    expect(
        await page.evaluate(() => window.landmarkField.isComplete())
    ).toBe(false);

    await description.clear();

    expect(
        await page.evaluate(() => window.landmarkField.isComplete())
    ).toBe(false);
});

test('resets the landmark field', async ({ page }) => {
    await page.locator('#landmarkDescription').fill('Near school');

    await setLandmarkPhoto(page);

    await page.evaluate(() => {
        window.landmarkField.reset();
    });

    await expect(
        page.locator('#landmarkDescription')
    ).toHaveValue('');

    await expect(
        page.locator('#landmarkCharCounter')
    ).toHaveText('0/250');

    await expect(
        page.locator('#landmarkPreviewBtn')
    ).toBeHidden();

    await expect(
        page.locator('#landmarkCameraLabel')
    ).toHaveText('Take photo');

    await expect(
        page.locator('#landmarkField')
    ).toHaveAttribute('data-captured', 'false');

    expect(
        await page.evaluate(() => window.landmarkField.getPhoto())
    ).toBeNull();

    expect(
        await page.evaluate(() => window.landmarkField.isComplete())
    ).toBe(false);
});

test('renders without horizontal overflow', async ({ page }) => {
    for (const width of [320, 360, 375, 390, 768, 1440]) {
        await page.setViewportSize({
            width,
            height: 900
        });

        const hasOverflow = await page.evaluate(() => {
            const container = document.getElementById('landmarkField');

            return container.scrollWidth > container.clientWidth
                || document.documentElement.scrollWidth > window.innerWidth;
        });

        expect(hasOverflow, `Overflow at ${width}px`).toBe(false);
    }

    await setLandmarkPhoto(page);

    for (const width of [320, 360, 375, 390, 768, 1440]) {
        await page.setViewportSize({
            width,
            height: 900
        });

        const hasOverflow = await page.evaluate(() => {
            const container = document.getElementById('landmarkField');

            return container.scrollWidth > container.clientWidth
                || document.documentElement.scrollWidth > window.innerWidth;
        });

        expect(
            hasOverflow,
            `Captured state overflow at ${width}px`
        ).toBe(false);
    }
});