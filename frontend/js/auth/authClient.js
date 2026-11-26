(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.AuthClient = api.create(root);
    root.AuthRegistration = api.registration;
  }
})(typeof self !== "undefined" ? self : this, function () {
  function create(env) {
    let generation = 0;
    const requests = new Set();
    env.addEventListener?.("pagehide", () => {
      generation++;
      requests.forEach((controller) => controller.abort());
    });
    async function request(
      path,
      data,
      token,
      method = data ? "POST" : "GET",
      expected = 200,
    ) {
      const signingIn = /^\/api\/auth\/(?:login|(?:citizen|admin|barangay)\/login)$/.test(path);
      const enrolling = path.startsWith("/api/auth/enrollment/");
      const multipart = typeof env.FormData === "function" && data instanceof env.FormData;
      const controller = new AbortController();
      requests.add(controller);
      const timer = setTimeout(() => controller.abort(), path === "/api/auth/enrollment/capture" ? 30000 : 20000);
      try {
        const url = env.neighborLensApiUrl
          ? env.neighborLensApiUrl(path)
          : path;
        if (env.location) {
          const target = new URL(url, env.location.href);
          if (
            target.protocol !== "https:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
          )
            throw new Error(
              "HTTPS is required for account and identity information.",
            );
        }
        const res = await env.fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            ...(data && !multipart ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(data ? { body: multipart ? data : JSON.stringify(data) } : {}),
        });
        if (signingIn && res.status === 404) {
          const error = new Error("Authentication endpoint unavailable. Restart the API server and reload this page.");
          error.status = res.status;
          throw error;
        }
        const body = await res.json().catch(() => {
          throw new Error(
            signingIn
              ? "The authentication server returned an invalid response. Please retry after checking the API server."
              : "Invalid server response. Log in to check account status before retrying registration.",
          );
        });
        if (!res.ok) {
          const error = new Error(
            ["REGISTRATION_ID_ALREADY_USED", "REGISTRATION_VERIFICATION_UNAVAILABLE", "REGISTRATION_LOCATION_UNAVAILABLE"].includes(body.code)
              ? String(body.error || "ID verification could not be completed.").slice(0, 240)
              : res.status === 409
              ? "Username is already registered. Log in or choose another username."
              : res.status === 401
                ? "Invalid credentials or expired session. Please log in."
                : res.status === 429
                  ? "Too many requests. Please wait and retry."
                  : [400, 403, 422].includes(res.status)
                    ? String(
                        body.message ||
                          body.error ||
                          "Check the entered information.",
                      ).slice(0, 240)
                    : "Server unavailable. Please retry.",
          );
          error.status = res.status;
          error.code = body.code;
          if (enrolling) {
            error.screening = body.screening;
            error.decision = body.decision;
          }
          throw error;
        }
        if (res.status !== expected)
          throw new Error(
            "The server did not confirm the operation. Log in to check account status.",
          );
        return body;
      } catch (error) {
        if (error.name === "AbortError")
          throw new Error(
            signingIn || enrolling
              ? "The request timed out. Please retry."
              : "Request timed out. Log in to check whether your account was created.",
          );
        if (error instanceof TypeError)
          throw new Error("Cannot reach the server. Check your connection.");
        throw error;
      } finally {
        clearTimeout(timer);
        requests.delete(controller);
      }
    }
    async function authenticate(path, data, status, portal) {
      const current = ++generation;
      const body = await request(path, data, null, "POST", status);
      const user = body.user;
      if (current !== generation)
        throw new Error("Authentication was replaced. Please log in again.");
      if (
        !Number.isSafeInteger(Number(user?.id)) ||
        Number(user.id) < 1 ||
        typeof user.username !== "string" ||
        !user.username ||
        !["citizen", "admin", "barangay"].includes(user.role) ||
        typeof body.token !== "string" ||
        !body.token ||
        (status === 201 && user.role !== "citizen") ||
        (portal && user.role !== portal)
      )
        throw new Error(
          "The server did not return a valid authenticated account.",
        );
      if (path === "/api/auth/register" && data.token) {
        const status = body.identity?.documentValidationStatus;
        const limited = user.accountStatus === "ACTIVE_LIMITED" && user.identityStatus === "UNVERIFIED" && status === "needs_review";
        if (status !== "pass" && !limited)
          throw new Error("The server did not confirm registration. Log in to check your account.");
      }
      const session = {
        id: Number(user.id),
        username: user.username,
        role: user.role,
        barangay: user.barangay || null,
        fullName: user.full_name || "",
        apiToken: body.token,
        ...(typeof user.residencyVerified === 'boolean' ? { residencyVerified: user.residencyVerified } : {}),
        ...(user.accountStatus ? { accountStatus: user.accountStatus, identityStatus: user.identityStatus } : {}),
      };
      try {
        env.sessionStorage.setItem("up_session", JSON.stringify(session));
      } catch {
        throw new Error(
          "Session storage is unavailable. Enable it and log in to recover.",
        );
      }
      return path === "/api/auth/register" && data.token
        ? { account: session, identity: body.identity }
        : session;
    }
    return {
      request,
      login: (username, password, portal = 'citizen') => {
        if (!['citizen', 'admin', 'barangay'].includes(portal)) return Promise.reject(new Error('Invalid login portal.'));
        return authenticate(`/api/auth/${portal}/login`, { username, password }, 200, portal);
      },
      register: (data) => authenticate("/api/auth/register", data, 201),
      startEnrollment: (position) => request("/api/auth/enrollment/start", { position }),
      enrollmentStatus: (token) => request("/api/auth/enrollment/status", null, token),
      submitEnrollmentCapture: (token, position, image) => {
        const form = new env.FormData();
        form.set("position", JSON.stringify(position));
        form.append("frames", image, "capture.jpg");
        return request("/api/auth/enrollment/capture", form, token);
      },
      stored: () => {
        try {
          return JSON.parse(env.sessionStorage.getItem("up_session"));
        } catch {
          return null;
        }
      },
      identity: (token) => request("/api/identity/me", null, token),
      verify: (token) => request("/api/me", null, token),
      saveIdentity: async (token, facts) => {
        const result = await request("/api/identity", facts, token);
        if (
          !["pass", "fail", "needs_review"].includes(
            result.identity?.documentValidationStatus,
          )
        )
          throw new Error(
            "Identity persistence was not confirmed. Retry identity submission.",
          );
        return result.identity;
      },
    };
  }
  function registration(client, existing = null) {
    let account = existing;
    let pending = null;
    let uncertain = false;
    return {
      account: () => account,
      uncertain: () => uncertain,
      submit(credentials, facts) {
        if (pending) return pending;
        pending = (async () => {
          if (!account) {
            if (uncertain)
              throw new Error(
                "Account creation is uncertain. Log in to recover before registering again.",
              );
            try {
              if (credentials.token) {
                const result = await client.register({ ...credentials, identity: facts });
                account = result.account;
                return result;
              }
              account = await client.register(credentials);
            } catch (error) {
              if (!error.status || error.status >= 500) uncertain = true;
              throw error;
            }
          }
          if (account.role !== "citizen")
            throw new Error("A citizen account is required.");
          return {
            account,
            identity: await client.saveIdentity(account.apiToken, facts),
          };
        })().finally(() => {
          pending = null;
        });
        return pending;
      },
    };
  }
  return { create, registration };
});
