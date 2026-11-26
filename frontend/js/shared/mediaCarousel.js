(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MediaCarousel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function mount({ track, slides, previous, next, position, dots = [], initial = 0 }) {
        const removers = [];
        const listen = (node, name, handler, options) => {
            if (!node) return;
            node.addEventListener(name, handler, options);
            removers.push(() => node.removeEventListener(name, handler, options));
        };
        const index = () => slides.length ? Math.min(slides.length - 1, Math.max(0, Math.round(track.scrollLeft / (track.clientWidth || 1)))) : 0;
        function sync() {
            const current = index();
            if (position) position.textContent = slides.length ? `Photo ${current + 1} of ${slides.length}` : 'No photos shared';
            if (previous) previous.disabled = current === 0;
            if (next) next.disabled = current >= slides.length - 1;
            dots.forEach((dot, number) => dot.setAttribute('aria-pressed', String(number === current)));
        }
        function goTo(number) {
            const slide = slides[Math.max(0, Math.min(number, slides.length - 1))];
            if (slide) track.scrollTo({ left: track.scrollLeft + slide.getBoundingClientRect().left - track.getBoundingClientRect().left, behavior: 'auto' });
            sync();
        }
        listen(previous, 'click', () => goTo(index() - 1));
        listen(next, 'click', () => goTo(index() + 1));
        listen(track, 'scroll', sync, { passive: true });
        listen(track, 'keydown', event => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault(); goTo(index() + (event.key === 'ArrowRight' ? 1 : -1));
            }
        });
        dots.forEach((dot, number) => listen(dot, 'click', () => goTo(number)));
        sync();
        const frame = initial ? track.ownerDocument.defaultView.requestAnimationFrame(() => goTo(initial)) : null;
        return { index, goTo, destroy() { if (frame !== null) track.ownerDocument.defaultView.cancelAnimationFrame(frame); removers.splice(0).forEach(remove => remove()); } };
    }
    return { mount };
});
