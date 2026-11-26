(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    window.LoginControls.mount(byId('loginForm'), {
        username: byId('loginUser'), password: byId('loginPass'), remember: byId('loginRemember'),
        toggle: byId('loginEye'), forgot: byId('loginForgot'), help: byId('loginHelp'),
        key: 'neighborlens:remembered-username:citizen'
    });
})();
