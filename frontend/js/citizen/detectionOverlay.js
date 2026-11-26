(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectionOverlay = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const observers = new WeakMap();
    const pendingLoads = new WeakMap();

    function projectBox(bbox, imageSize, natural, rendered, fit = 'cover') {
        if (!bbox || Array.isArray(bbox)) return null;
        const values = ['x', 'y', 'width', 'height'].map(key => Number(bbox[key]));
        if (values.some(value => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) return null;
        const naturalWidth = Number(natural?.width);
        const naturalHeight = Number(natural?.height);
        const renderedWidth = Number(rendered?.width);
        const renderedHeight = Number(rendered?.height);
        if (![naturalWidth, naturalHeight, renderedWidth, renderedHeight].every(value => Number.isFinite(value) && value > 0)) return null;
        const sourceWidth = Number(imageSize?.width) > 0 ? Number(imageSize.width) : naturalWidth;
        const sourceHeight = Number(imageSize?.height) > 0 ? Number(imageSize.height) : naturalHeight;
        const scaleX = renderedWidth / naturalWidth;
        const scaleY = renderedHeight / naturalHeight;
        const scale = fit === 'contain' ? Math.min(scaleX, scaleY) : fit === 'fill' ? null : Math.max(scaleX, scaleY);
        const fx = (scale === null ? scaleX : scale) * naturalWidth / sourceWidth;
        const fy = (scale === null ? scaleY : scale) * naturalHeight / sourceHeight;
        const offsetX = scale === null ? 0 : (renderedWidth - naturalWidth * scale) / 2;
        const offsetY = scale === null ? 0 : (renderedHeight - naturalHeight * scale) / 2;
        const [x, y, width, height] = values;
        const left = Math.max(0, offsetX + x * fx);
        const top = Math.max(0, offsetY + y * fy);
        const right = Math.min(renderedWidth, offsetX + (x + width) * fx);
        const bottom = Math.min(renderedHeight, offsetY + (y + height) * fy);
        if (right <= left || bottom <= top) return null;
        return { left, top, width: right - left, height: bottom - top };
    }

    function overlayFor(img) {
        const host = img.parentElement;
        if (!host) return null;
        let layer = host.querySelector(':scope > .detection-overlay');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'detection-overlay';
            layer.setAttribute('aria-hidden', 'true');
            layer.style.cssText = 'position:absolute; left:0; top:0; pointer-events:none; overflow:hidden;';
            host.appendChild(layer);
        }
        return layer;
    }

    function draw(img, detections, imageSize) {
        const layer = overlayFor(img);
        if (!layer) return;
        layer.replaceChildren();
        if (img.style.display === 'none' || !img.naturalWidth) return;
        layer.style.left = `${img.offsetLeft + img.clientLeft}px`;
        layer.style.top = `${img.offsetTop + img.clientTop}px`;
        layer.style.width = `${img.clientWidth}px`;
        layer.style.height = `${img.clientHeight}px`;
        const fit = getComputedStyle(img).objectFit || 'fill';
        const natural = { width: img.naturalWidth, height: img.naturalHeight };
        const rendered = { width: img.clientWidth, height: img.clientHeight };
        for (const detection of detections) {
            const rect = projectBox(detection.bbox, imageSize, natural, rendered, fit);
            if (!rect) continue;
            const color = { High: '#00e676', Moderate: '#f5a623' }[detection.confidenceLevel] || '#cbd5e1';
            const box = document.createElement('div');
            box.style.cssText = `position:absolute; left:${rect.left}px; top:${rect.top}px; width:${rect.width}px; height:${rect.height}px; border:2px solid ${color}; border-radius:3px; box-sizing:border-box;`;
            const label = document.createElement('span');
            label.textContent = `${detection.displayName} ${Math.round(detection.confidence * 1000) / 10}%`;
            label.style.cssText = `position:absolute; background:${color}; color:#000; font-size:0.62rem; font-weight:700; line-height:1.4; padding:0 4px; border-radius:2px; width:max-content; max-width:${rendered.width}px; box-sizing:border-box;`;
            box.appendChild(label);
            layer.appendChild(box);
            // Keep the complete class and score inside the photo for right-edge boxes.
            label.style.left = `${Math.min(0, rendered.width - rect.left - label.offsetWidth) - 2}px`;
            if (rect.top >= label.offsetHeight) label.style.bottom = '100%';
            else label.style.top = '0';
        }
    }

    function clear(img) {
        if (!img) return;
        const pendingLoad = pendingLoads.get(img);
        if (pendingLoad) img.removeEventListener('load', pendingLoad);
        pendingLoads.delete(img);
        const observer = observers.get(img);
        if (observer) observer.disconnect();
        observers.delete(img);
        const layer = img.parentElement?.querySelector(':scope > .detection-overlay');
        if (layer) layer.replaceChildren();
    }

    function render(img, detections, imageSize) {
        if (!img) return;
        clear(img);
        const list = Array.isArray(detections) ? detections : [];
        if (!list.length) return;
        const redraw = () => draw(img, list, imageSize);
        if (img.complete && img.naturalWidth) {
            redraw();
        } else {
            const onLoad = () => {
                pendingLoads.delete(img);
                redraw();
            };
            pendingLoads.set(img, onLoad);
            img.addEventListener('load', onLoad, { once: true });
        }
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(redraw);
            observer.observe(img);
            observers.set(img, observer);
        }
    }

    return { projectBox, render, clear };
});
