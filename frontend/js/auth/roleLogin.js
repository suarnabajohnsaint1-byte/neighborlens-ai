(function () {
    'use strict';

    const page = document.body;
    const expectedRole = page.dataset.loginRole;
    const rememberKey = `neighborlens:remembered-username:${expectedRole}`;

    const form = document.getElementById('roleLoginForm');
    const username = document.getElementById('roleLoginUser');
    const password = document.getElementById('roleLoginPass');
    const remember = document.getElementById('roleLoginRemember');
    const submit = document.getElementById('roleLoginSubmit');
    const message = document.getElementById('roleLoginMsg');
    const eye = document.getElementById('roleLoginEye');
    const forgot = document.getElementById('roleLoginForgot');
    const help = document.getElementById('roleLoginHelp');
    const controls = window.LoginControls.mount(form, { username, password, remember, toggle: eye, forgot, help, key: rememberKey });
    let busy = false;

    function show(text, type) {
        message.hidden = !text;
        message.textContent = text || '';
        message.className = `rl-message ${type === 'error' ? 'is-error' : 'is-info'}`;
        message.setAttribute('role', type === 'error' ? 'alert' : 'status');
    }

    function resetForm() {
        controls.reset();
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        const user = username.value.trim();
        if (!user || !password.value) {
            show('Enter your username and password.', 'error');
            return;
        }
        busy = true;
        submit.disabled = true;
        show('');
        try {
            const session = await window.AuthClient.login(user, password.value, expectedRole);
            password.value = '';
            controls.rememberUsername();
            window.location.replace(window.portalForRole(session.role));
        } catch (error) {
            password.value = '';
            show(error.message || 'Sign in failed. Please try again.', 'error');
        } finally {
            busy = false;
            submit.disabled = false;
        }
    });

    window.addEventListener('pagehide', () => {
        password.value = '';
    });

    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            busy = false;
            submit.disabled = false;
            resetForm();
            show('');
        }
    });

    resetForm();
    if (new URLSearchParams(window.location.search).get('session') === 'expired') {
        show('Your session has ended. Please sign in again.', 'error');
        history.replaceState(null, '', window.location.pathname.split('/').pop());
    }
})();
