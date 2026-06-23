import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/admin-auth";

function admin() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/admin/device")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = requireAdmin(request);
        if (denied) return denied;
        try {
          const body = (await request.json().catch(() => ({}))) as {
            device_id?: string;
            label?: string | null;
            serial?: string | null;
            location?: string | null;
          };
          if (!body.device_id) return json({ error: "device_id required" }, 400);

          const sb = admin();
          const { error } = await sb.from("devices").upsert(
            {
              device_id: body.device_id.slice(0, 100),
              label: body.label?.slice(0, 200) ?? null,
              serial: body.serial?.slice(0, 200) ?? null,
              location: body.location?.slice(0, 200) ?? null,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "device_id" },
          );
          if (error) return json({ error: error.message }, 500);
          return json({ ok: true });
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});
