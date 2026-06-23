import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie } from "@tanstack/react-start/server";
import { ADMIN_COOKIE } from "@/lib/admin-auth";

export const Route = createFileRoute("/api/admin/logout")({
  server: {
    handlers: {
      POST: async () => {
        deleteCookie(ADMIN_COOKIE, { path: "/" });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});