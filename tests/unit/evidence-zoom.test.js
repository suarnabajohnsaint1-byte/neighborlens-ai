
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const EvidenceZoom = require(
    '../../frontend/js/shared/evidenceZoom.js'
);

function createElement() {
    const element = new EventTarget();

    element.style = {};
    element.disabled = false;
    element.textContent = '';
    element.clientWidth = 400;
    element.clientHeight = 300;
    element.setPointerCapture = () => { };

    return element;
}

function createFixture() {
    const dialog = createElement();
    dialog.open = true;
    dialog.ownerDocument = createElement();

    const image = createElement();
    const zoomIn = createElement();
    const zoomOut = createElement();
    const reset = createElement();

    const zoom = new EvidenceZoom({
        dialog,
        image,
        zoomIn,
        zoomOut,
        reset
    });

    return {
        zoom,
        dialog,
        image,
        zoomIn,
        zoomOut,
        reset
    };
}

function withFixture(callback) {
    const fixture = createFixture();

    try {
        callback(fixture);
    } finally {
        fixture.zoom.destroy();
    }
}

test('bubbling photo gestures apply once when the image is inside a viewport', () => {
    const dialog = createElement(), viewport = createElement(), image = createElement();
    dialog.open = true;
    dialog.ownerDocument = createElement();
    dialog.querySelector = () => viewport;
    const zoom = new EvidenceZoom({ dialog, image });
    try {
        const wheel = new Event('wheel', { cancelable: true, bubbles: true });
        Object.defineProperty(wheel, 'deltaY', { value: -100 });
        image.dispatchEvent(wheel);
        viewport.dispatchEvent(wheel);
        assert.equal(zoom.scale, 1.25);
        const double = new Event('dblclick', { cancelable: true, bubbles: true });
        image.dispatchEvent(double);
        viewport.dispatchEvent(double);
        assert.equal(zoom.scale, 1);
    } finally { zoom.destroy(); }
});

test('initializes at 100% zoom', () => {
    withFixture(({ zoom, image, zoomIn, zoomOut, reset }) => {
        assert.equal(zoom.scale, 1);
        assert.equal(reset.textContent, '100%');
        assert.equal(zoomIn.disabled, false);
        assert.equal(zoomOut.disabled, true);
        assert.equal(
            image.style.transform,
            'translate(0px, 0px) scale(1)'
        );
    });
});

test('increases zoom by 25%', () => {
    withFixture(({ zoom, reset }) => {
        zoom.zoom(0.25);

        assert.equal(zoom.scale, 1.25);
        assert.equal(reset.textContent, '125%');
    });
});

test('enforces maximum zoom of 500%', () => {
    withFixture(({ zoom, zoomIn, reset }) => {
        zoom.setScale(10);

        assert.equal(zoom.scale, 5);
        assert.equal(reset.textContent, '500%');
        assert.equal(zoomIn.disabled, true);
    });
});

test('enforces minimum zoom of 100%', () => {
    withFixture(({ zoom, zoomOut, reset }) => {
        zoom.setScale(-10);

        assert.equal(zoom.scale, 1);
        assert.equal(reset.textContent, '100%');
        assert.equal(zoomOut.disabled, true);
    });
});

test('resets zoom and translation', () => {
    withFixture(({ zoom, image }) => {
        zoom.setScale(3);
        zoom.reset();

        assert.equal(zoom.scale, 1);
        assert.equal(
            image.style.transform,
            'translate(0px, 0px) scale(1)'
        );
        assert.equal(image.style.cursor, 'zoom-in');
    });
});

test('zoom-in button increases scale', () => {
    withFixture(({ zoom, zoomIn }) => {
        zoomIn.dispatchEvent(new Event('click'));

        assert.equal(zoom.scale, 1.25);
    });
});

test('zoom-out button decreases scale', () => {
    withFixture(({ zoom, zoomOut }) => {
        zoom.setScale(2);

        zoomOut.dispatchEvent(new Event('click'));

        assert.equal(zoom.scale, 1.75);
    });
});

test('reset button restores 100%', () => {
    withFixture(({ zoom, reset }) => {
        zoom.setScale(4);

        reset.dispatchEvent(new Event('click'));

        assert.equal(zoom.scale, 1);
        assert.equal(reset.textContent, '100%');
    });
});

test('throws when required elements are missing', () => {
    assert.throws(
        () => new EvidenceZoom({
            dialog: null,
            image: null
        }),
        /requires a dialog and image/
    );
});

test('mouse wheel zooms in when dialog is open', () => {
    withFixture(({ zoom, image }) => {
        const event = new Event('wheel', {
            cancelable: true
        });

        Object.defineProperty(event, 'deltaY', {
            value: -100
        });

        image.dispatchEvent(event);

        assert.equal(zoom.scale, 1.25);
        assert.equal(event.defaultPrevented, true);
    });
});

test('mouse wheel does not zoom when dialog is closed', () => {
    withFixture(({ zoom, image, dialog }) => {
        dialog.open = false;

        const event = new Event('wheel', {
            cancelable: true
        });

        Object.defineProperty(event, 'deltaY', {
            value: -100
        });

        image.dispatchEvent(event);

        assert.equal(zoom.scale, 1);
        assert.equal(event.defaultPrevented, false);
    });
});

test('double-click toggles zoom', () => {
    withFixture(({ zoom, image }) => {
        image.dispatchEvent(new Event('dblclick'));

        assert.equal(zoom.scale, 2);

        image.dispatchEvent(new Event('dblclick'));

        assert.equal(zoom.scale, 1);
    });
});

test('dialog close resets zoom', () => {
    withFixture(({ zoom, dialog }) => {
        zoom.setScale(3);

        dialog.dispatchEvent(new Event('close'));

        assert.equal(zoom.scale, 1);
    });
});

test('keyboard shortcuts control zoom', () => {
    withFixture(({ zoom, dialog }) => {
        const document = dialog.ownerDocument;

        function keydown(key) {
            const event = new Event('keydown', {
                cancelable: true
            });

            Object.defineProperty(event, 'key', {
                value: key
            });

            document.dispatchEvent(event);
        }

        keydown('+');
        assert.equal(zoom.scale, 1.25);

        keydown('-');
        assert.equal(zoom.scale, 1);

        zoom.setScale(3);
        keydown('0');

        assert.equal(zoom.scale, 1);
    });
});

test('destroy removes registered event listeners', () => {
    const fixture = createFixture();

    fixture.zoom.destroy();

    fixture.zoomIn.dispatchEvent(new Event('click'));

    assert.equal(fixture.zoom.scale, 1);
});

test('requires valid zoom controls to receive events', () => {
    const element = createElement();

    assert.equal(
        typeof element.addEventListener,
        'function'
    );

    assert.equal(
        typeof element.dispatchEvent,
        'function'
    );
});

test('pointer dragging updates translation when zoomed', () => {
    withFixture(({ zoom, image }) => {
        zoom.setScale(2);
        const down = new Event('pointerdown');
        Object.assign(down, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true, pointerType: 'mouse', button: 0 });
        image.dispatchEvent(down);
        assert.equal(image.style.cursor, 'grabbing');

        const move = new Event('pointermove');
        Object.assign(move, { pointerId: 1, clientX: 150, clientY: 130 });
        image.dispatchEvent(move);

        assert.equal(zoom.offsetX, 50);
        assert.equal(zoom.offsetY, 30);
        assert.equal(image.style.transform, 'translate(50px, 30px) scale(2)');

        const up = new Event('pointerup');
        Object.assign(up, { pointerId: 1 });
        image.dispatchEvent(up);
        assert.equal(image.style.cursor, 'grab');
    });
});

test('pointer cancellation stops dragging', () => {
    withFixture(({ zoom, image }) => {
        zoom.setScale(2);
        const down = new Event('pointerdown');
        Object.assign(down, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true, pointerType: 'mouse', button: 0 });
        image.dispatchEvent(down);

        const cancel = new Event('pointercancel');
        Object.assign(cancel, { pointerId: 1 });
        image.dispatchEvent(cancel);
        assert.equal(image.style.cursor, 'grab');

        const move = new Event('pointermove');
        Object.assign(move, { pointerId: 1, clientX: 200, clientY: 200 });
        image.dispatchEvent(move);

        assert.equal(zoom.offsetX, 0);
        assert.equal(zoom.offsetY, 0);
    });
});

test('constrains pan translation within image boundaries', () => {
    withFixture(({ zoom, image }) => {
        zoom.setScale(2);
        const down = new Event('pointerdown');
        Object.assign(down, { pointerId: 1, clientX: 0, clientY: 0, isPrimary: true, pointerType: 'mouse', button: 0 });
        image.dispatchEvent(down);

        const moveOver = new Event('pointermove');
        Object.assign(moveOver, { pointerId: 1, clientX: 800, clientY: 600 });
        image.dispatchEvent(moveOver);

        assert.equal(zoom.offsetX, 200);
        assert.equal(zoom.offsetY, 150);

        const moveUnder = new Event('pointermove');
        Object.assign(moveUnder, { pointerId: 1, clientX: -800, clientY: -600 });
        image.dispatchEvent(moveUnder);

        assert.equal(zoom.offsetX, -200);
        assert.equal(zoom.offsetY, -150);
    });
});

test('safely handles invalid, nonnumeric, NaN, and infinite scale values', () => {
    withFixture(({ zoom, image }) => {
        zoom.setScale(NaN);
        assert.equal(zoom.scale, 1);

        zoom.setScale(Infinity);
        assert.equal(zoom.scale, 1);

        zoom.setScale(-Infinity);
        assert.equal(zoom.scale, 1);

        zoom.setScale('not-a-number');
        assert.equal(zoom.scale, 1);

        zoom.zoom(NaN);
        assert.equal(zoom.scale, 1);

        zoom.zoom(Infinity);
        assert.equal(zoom.scale, 1);

        assert.equal(image.style.transform, 'translate(0px, 0px) scale(1)');
    });
});

test('handles repeated zoom operations accurately', () => {
    withFixture(({ zoom, reset }) => {
        zoom.zoom(0.25);
        zoom.zoom(0.25);
        zoom.zoom(0.25);
        assert.equal(zoom.scale, 1.75);
        assert.equal(reset.textContent, '175%');

        zoom.zoom(-0.25);
        zoom.zoom(-0.25);
        assert.equal(zoom.scale, 1.25);
        assert.equal(reset.textContent, '125%');
    });
});

test('disposes listeners completely on destroy', () => {
    const fixture = createFixture();
    fixture.zoom.destroy();

    const down = new Event('pointerdown');
    Object.assign(down, { pointerId: 1, clientX: 10, clientY: 10, isPrimary: true, pointerType: 'mouse', button: 0 });
    fixture.image.dispatchEvent(down);

    const wheel = new Event('wheel', { cancelable: true });
    Object.defineProperty(wheel, 'deltaY', { value: -100 });
    fixture.image.dispatchEvent(wheel);

    const key = new Event('keydown', { cancelable: true });
    Object.defineProperty(key, 'key', { value: '+' });
    fixture.dialog.ownerDocument.dispatchEvent(key);

    assert.equal(fixture.zoom.scale, 1);
});

test('ignores keyboard events when dialog is closed', () => {
    withFixture(({ zoom, dialog }) => {
        dialog.open = false;
        const key = new Event('keydown', { cancelable: true });
        Object.defineProperty(key, 'key', { value: '+' });
        dialog.ownerDocument.dispatchEvent(key);

        assert.equal(zoom.scale, 1);
        assert.equal(key.defaultPrevented, false);
    });
});
