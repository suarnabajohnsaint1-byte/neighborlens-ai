(function () {
    'use strict';

    const form = document.getElementById('adminSignupForm');
    const username = document.getElementById('signupUser');
    const fullName = document.getElementById('signupFullName');
    const password = document.getElementById('signupPass');
    const confirm = document.getElementById('signupConfirm');
    const reason = document.getElementById('signupReason');
    const submit = document.getElementById('signupSubmit');
    const message = document.getElementById('signupMsg');
    const eye = document.getElementById('signupEye');
    let busy = false;

    function show(text, type) {
        message.hidden = !text;
        message.textContent = text || '';
        message.className = `rl-message ${type === 'error' ? 'is-error' : 'is-info'}`;
        message.setAttribute('role', type === 'error' ? 'alert' : 'status');
    }

    function validate() {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username.value.trim())) {
            return 'Username must be 3 to 64 characters using letters, numbers, dots, dashes, or underscores.';
        }
        if (password.value.length < 12) return 'Password must be at least 12 characters.';
        if (new TextEncoder().encode(password.value).length > 72) return 'Password must be at most 72 UTF-8 bytes.';
        if (!/[A-Za-z]/.test(password.value) || !/\d/.test(password.value)) {
            return 'Password must contain at least one letter and one number.';
        }
        if (password.value !== confirm.value) return 'Passwords do not match.';
        return null;
    }

    eye.addEventListener('click', () => {
        const reveal = password.type === 'password';
        password.type = reveal ? 'text' : 'password';
        confirm.type = password.type;
        eye.querySelector('i').className = reveal ? 'bx bx-hide' : 'bx bx-show';
        eye.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
        eye.setAttribute('aria-pressed', String(reveal));
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        const invalid = validate();
        if (invalid) {
            show(invalid, 'error');
            return;
        }
        busy = true;
        submit.disabled = true;
        show('');
        try {
            const result = await window.apiRequest('/api/auth/admin-access-requests', {
                method: 'POST',
                auth: false,
                body: {
                    username: username.value.trim(),
                    fullName: fullName.value.trim(),
                    password: password.value,
                    reason: reason.value.trim()
                }
            });
            form.reset();
            show(result.message || 'Request submitted for approval.', 'info');
        } catch (error) {
            show(error.message || 'The request could not be submitted.', 'error');
        } finally {
            password.value = '';
            confirm.value = '';
            busy = false;
            submit.disabled = false;
        }
    });

    window.addEventListener('pagehide', () => {
        password.value = '';
        confirm.value = '';
    });
})();
