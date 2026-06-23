import { createFileRoute } from "@tanstack/react-router";
import { setCookie } from "@tanstack/react-start/server";
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_MAX_AGE,
  getAdminPassword,
  safeEqualString,
  signAdminToken,
} from "@/lib/admin-auth";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/admin/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const password = getAdminPassword();
        if (!password) return json({ error: "Admin not configured" }, 503);

        let body: { password?: string } = {};
        try {
          body = (await request.json()) as { password?: string };
        } catch {
          return json({ error: "Invalid request" }, 400);
        }
        const submitted = typeof body.password === "string" ? body.password : "";
        if (!submitted || !safeEqualString(submitted, password)) {
          return json({ error: "Invalid password" }, 401);
        }

        setCookie(ADMIN_COOKIE, signAdminToken(password), {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: ADMIN_COOKIE_MAX_AGE,
        });
        return json({ ok: true });
      },
    },
  },
});