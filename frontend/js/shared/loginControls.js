(function (root) {
    'use strict';
    const instances = new WeakMap();

    function mount(form, { username, password, remember, toggle, forgot, help, key }) {
        if (instances.has(form)) return instances.get(form);
        function store(value) {
            try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {}
        }
        function conceal() {
            password.type = 'password';
            toggle.setAttribute('aria-label', 'Show password');
            toggle.setAttribute('aria-pressed', 'false');
            toggle.querySelector('i').className = 'bx bx-show';
        }
        function reset() {
            let stored = '';
            try { stored = localStorage.getItem(key) || ''; } catch {}
            username.value = stored;
            remember.checked = Boolean(stored);
            password.value = '';
            conceal();
        }
        toggle.addEventListener('click', () => {
            const reveal = password.type === 'password';
            if (!reveal) return conceal();
            password.type = 'text';
            toggle.setAttribute('aria-label', 'Hide password');
            toggle.setAttribute('aria-pressed', 'true');
            toggle.querySelector('i').className = 'bx bx-hide';
        });
        forgot.addEventListener('click', () => {
            help.hidden = !help.hidden;
            forgot.setAttribute('aria-expanded', String(!help.hidden));
        });
        remember.addEventListener('change', () => { if (!remember.checked) store(''); });
        root.addEventListener('pagehide', () => { password.value = ''; conceal(); });
        root.addEventListener('pageshow', event => { if (event.persisted) reset(); });
        const instance = { reset, rememberUsername: () => store(remember.checked ? username.value.trim() : '') };
        instances.set(form, instance);
        reset();
        return instance;
    }
    root.LoginControls = { mount, get: form => instances.get(form) };
})(window);
