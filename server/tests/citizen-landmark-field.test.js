const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');

const source = fs.readFileSync(
    path.resolve(
        __dirname,
        '../../frontend/js/citizen/components/landmarkField.js'
    ),
    'utf8'
);

const template = fs.readFileSync(
    path.resolve(
        __dirname,
        '../../frontend/components/citizen/landmark-field.html'
    ),
    'utf8'
);

function createElement(properties = {}) {
    return Object.assign(new EventTarget(), {
        value: '',
        textContent: '',
        hidden: false,

        removeAttribute(name) {
            delete this[name];
        },

        ...properties
    });
}

function createFixture({
    requestOk = true,
    onChange = () => { },
    onCapture = () => { },
    onPreview = () => { }
} = {}) {
    const composerEl = Object.assign(new EventTarget(), {
        addEventListener(type, handler, options) {
            EventTarget.prototype.addEventListener.call(this, type, handler, options);
        }
    });

    const elements = {
        '#landmarkDescription': createElement({
            maxLength: 250
        }),
        '#landmarkCharCounter': createElement(),
        '#landmarkPreview': createElement(),
        '#landmarkPreviewBtn': createElement({
            hidden: true
        }),
        '#landmarkCameraBtn': createElement(),
        '#landmarkCameraLabel': createElement({
            textContent: 'Take photo'
        }),
        '.citizen-landmark-composer': composerEl
    };

    const revokedUrls = [];
    let nextUrl = 0;

    const container = {
        innerHTML: '',
        dataset: {},

        querySelector(selector) {
            return elements[selector] || null;
        },

        replaceChildren() {
            this.innerHTML = '';
        }
    };

    const context = vm.createContext({
        File,

        fetch: async () => ({
            ok: requestOk,
            status: requestOk ? 200 : 404,
            text: async () => template
        }),

        URL: {
            createObjectURL() {
                return `blob:landmark-${++nextUrl}`;
            },

            revokeObjectURL(url) {
                revokedUrls.push(url);
            }
        }
    });

    const factory = vm.runInContext(
        `${source}\ncreateCitizenLandmarkField;`,
        context
    );

    const field = factory({
        container,
        onChange,
        onCapture,
        onPreview
    });

    return {
        field,
        container,
        elements,
        revokedUrls
    };
}

function createPhoto() {
    return new File(
        ['mock image data'],
        'landmark.jpg',
        { type: 'image/jpeg' }
    );
}

test('mounts the landmark component', async () => {
    const { field, container } = createFixture();

    await field.mount();

    assert.ok(container.innerHTML.includes('landmarkDescription'));
    assert.equal(container.dataset.captured, 'false');
    assert.equal(field.getPhoto(), null);
    assert.equal(field.getDescription(), '');
    assert.equal(field.isComplete(), false);
});

test('updates the character counter', async () => {
    const { field, elements } = createFixture();

    await field.mount();

    const input = elements['#landmarkDescription'];
    const counter = elements['#landmarkCharCounter'];

    input.value = 'Near the school';
    input.dispatchEvent(new Event('input'));

    assert.equal(counter.textContent, '15/250');
});

test('rejects a description without a photo', async () => {
    const { field, elements } = createFixture();

    await field.mount();

    elements['#landmarkDescription'].value =
        'Beside the school entrance';

    assert.equal(field.isComplete(), false);
});

test('rejects a photo without a description', async () => {
    const { field } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    assert.equal(field.isComplete(), false);
});

test('rejects whitespace-only descriptions', async () => {
    const { field, elements } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    elements['#landmarkDescription'].value = '    ';

    assert.equal(field.getDescription(), '');
    assert.equal(field.isComplete(), false);
});

test('accepts a description at the maximum allowed length', async () => {
    const { field, elements } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    const input = elements['#landmarkDescription'];

    input.value = 'a'.repeat(input.maxLength);

    assert.equal(field.isComplete(), true);
});

test('rejects a description exceeding the maximum allowed length', async () => {
    const { field, elements } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    const input = elements['#landmarkDescription'];

    input.value = 'a'.repeat(input.maxLength + 1);

    assert.equal(field.isComplete(), false);
});

test('accepts a landmark with a photo and description', async () => {
    const { field, elements } = createFixture();

    await field.mount();

    const photo = createPhoto();

    field.setPhoto(photo);

    elements['#landmarkDescription'].value =
        'Beside the school entrance';

    assert.equal(field.getPhoto(), photo);
    assert.equal(field.getDescription(), 'Beside the school entrance');
    assert.equal(field.isComplete(), true);
});

test('rejects a null photo', async () => {
    const { field } = createFixture();

    await field.mount();

    assert.throws(
        () => field.setPhoto(null),
        /Invalid landmark photo/
    );
});

test('rejects an empty photo file', async () => {
    const { field } = createFixture();

    await field.mount();

    const emptyPhoto = new File(
        [],
        'empty.jpg',
        { type: 'image/jpeg' }
    );

    assert.throws(
        () => field.setPhoto(emptyPhoto),
        /Invalid landmark photo/
    );
});

test('updates the preview after photo capture', async () => {
    const { field, elements, container } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    assert.equal(elements['#landmarkPreview'].src, 'blob:landmark-1');
    assert.equal(elements['#landmarkPreviewBtn'].hidden, false);
    assert.equal(elements['#landmarkCameraLabel'].textContent, 'Retake');
    assert.equal(container.dataset.captured, 'true');
});

test('replaces the previous photo on retake', async () => {
    const { field, elements, revokedUrls } = createFixture();

    await field.mount();

    const firstPhoto = createPhoto();
    const secondPhoto = createPhoto();

    field.setPhoto(firstPhoto);
    field.setPhoto(secondPhoto);

    assert.equal(field.getPhoto(), secondPhoto);
    assert.equal(elements['#landmarkPreview'].src, 'blob:landmark-2');
    assert.deepEqual(revokedUrls, ['blob:landmark-1']);
});

test('calls onCapture when the camera button is clicked', async () => {
    let captureCalls = 0;

    const { field, elements } = createFixture({
        onCapture: () => {
            captureCalls++;
        }
    });

    await field.mount();

    elements['#landmarkCameraBtn']
        .dispatchEvent(new Event('click'));

    assert.equal(captureCalls, 1);
});

test('calls onPreview with the captured photo URL', async () => {
    let receivedUrl = null;

    const { field, elements } = createFixture({
        onPreview: url => {
            receivedUrl = url;
        }
    });

    await field.mount();

    field.setPhoto(createPhoto());

    elements['#landmarkPreviewBtn']
        .dispatchEvent(new Event('click'));

    assert.equal(receivedUrl, 'blob:landmark-1');
});

test('calls onChange when the description or photo changes', async () => {
    let changeCalls = 0;

    const { field, elements } = createFixture({
        onChange: () => {
            changeCalls++;
        }
    });

    await field.mount();

    const input = elements['#landmarkDescription'];

    input.value = 'Near school';
    input.dispatchEvent(new Event('input'));

    assert.equal(changeCalls, 1);

    field.setPhoto(createPhoto());

    assert.equal(changeCalls, 2);
});

test('resets the landmark component', async () => {
    const {
        field,
        elements,
        container,
        revokedUrls
    } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    elements['#landmarkDescription'].value = 'Near school';

    field.reset();

    assert.equal(field.getPhoto(), null);
    assert.equal(field.getDescription(), '');
    assert.equal(field.isComplete(), false);
    assert.equal(elements['#landmarkCharCounter'].textContent, '0/250');
    assert.equal(elements['#landmarkCameraLabel'].textContent, 'Take photo');
    assert.equal(elements['#landmarkPreviewBtn'].hidden, true);
    assert.equal(elements['#landmarkPreview'].src, undefined);
    assert.equal(container.dataset.captured, 'false');
    assert.deepEqual(revokedUrls, ['blob:landmark-1']);
});

test('destroys the component and releases the preview URL', async () => {
    const { field, container, revokedUrls } = createFixture();

    await field.mount();

    field.setPhoto(createPhoto());

    field.destroy();

    assert.equal(container.innerHTML, '');
    assert.equal(field.getPhoto(), null);
    assert.equal(field.isComplete(), false);
    assert.equal(container.dataset.captured, undefined);
    assert.deepEqual(revokedUrls, ['blob:landmark-1']);
});

test('rejects mounting when the HTML request fails', async () => {
    const { field } = createFixture({
        requestOk: false
    });

    await assert.rejects(
        () => field.mount(),
        /Failed to load landmark field: 404/
    );

    assert.equal(field.isComplete(), false);
});