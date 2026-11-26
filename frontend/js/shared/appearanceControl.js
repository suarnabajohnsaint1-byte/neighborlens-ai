(function (root) {
    'use strict';

    const instances = new WeakMap();

    function mount(container, manager = root.PortalTheme) {
        if (instances.has(container)) return instances.get(container);
        if (!manager?.getEffectiveTheme()) return null;

        const wrapper = document.createElement('div');
        wrapper.className = 'appearance-control';
        wrapper.setAttribute('role', 'group');
        wrapper.setAttribute('aria-label', 'Appearance');

        const info = document.createElement('div');
        info.className = 'appearance-info';

        const icon = document.createElement('i');
        icon.className = 'bx bx-moon';
        icon.setAttribute('aria-hidden', 'true');

        const labelText = document.createElement('span');
        labelText.className = 'appearance-mode-text';
        labelText.textContent = 'Dark Mode';

        info.append(icon, labelText);

        const switchLabel = document.createElement('label');
        switchLabel.className = 'theme-switch';
        switchLabel.setAttribute('title', 'Toggle dark / light mode');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('role', 'switch');
        input.setAttribute('aria-label', 'Dark mode');

        const slider = document.createElement('span');
        slider.className = 'theme-switch-slider';

        switchLabel.append(input, slider);
        wrapper.append(info, switchLabel);
        container.append(wrapper);

        function render() {
            const isDark = manager.getEffectiveTheme() === 'dark';
            input.checked = isDark;
            input.setAttribute('aria-checked', isDark ? 'true' : 'false');
            labelText.textContent = isDark ? 'Dark Mode' : 'Light Mode';
            icon.className = isDark ? 'bx bx-moon' : 'bx bx-sun';
            icon.style.color = isDark ? 'var(--accent-blue)' : '#f59e0b';
        }

        function toggle() {
            const nextTheme = input.checked ? 'dark' : 'light';
            manager.setPreference(nextTheme);
        }

        info.style.cursor = 'pointer';
        function onInfoClick(e) {
            e.preventDefault();
            input.checked = !input.checked;
            toggle();
        }
        info.addEventListener('click', onInfoClick);

        input.addEventListener('change', toggle);
        const unsubscribe = manager.subscribe(render);
        render();

        const instance = {
            destroy() {
                input.removeEventListener('change', toggle);
                info.removeEventListener('click', onInfoClick);
                unsubscribe();
                wrapper.remove();
                instances.delete(container);
            }
        };
        instances.set(container, instance);
        return instance;
    }

    root.PortalAppearance = { mount };
})(typeof self !== 'undefined' ? self : this);
