import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function admin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function trackingFingerprint(userAgent: string | null, screen: string | null) {
  const normalizedUa = (userAgent || "")
    .toLowerCase()
    .replace(/(chrome|version|safari|applewebkit)\/[\d.]+/g, "$1")
    .replace(/build\/[\w.]+/g, "build")
    .replace(/\s+/g, " ")
    .trim();
  return `${screen || ""}|${normalizedUa}`;
}

const LAST_EVENT_TYPES = new Set(["time_on_page", "session_end", "lightbox_open", "lightbox_close", "hover"]);

export const Route = createFileRoute("/api/public/track")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        try {
          const raw = await request.text();
          const body = JSON.parse(raw || "{}") as {
            action: "start" | "event" | "heartbeat" | "discard";
            session_id?: string;
            discard_session_id?: string;
            device_id?: string;
            user_agent?: string;
            referrer?: string;
            screen?: string;
            language?: string;
            event_type?: string;
            target_tag?: string;
            target_id?: string;
            target_class?: string;
            target_text?: string;
            path?: string;
            data?: unknown;
          };

          const sb = admin();

          if (body.action === "start") {
            const session_id = body.session_id?.slice(0, 100) ?? crypto.randomUUID();
            const user_agent = body.user_agent?.slice(0, 500) ?? null;
            const referrer = body.referrer?.slice(0, 500) ?? null;
            const screen = body.screen?.slice(0, 50) ?? null;
            const language = body.language?.slice(0, 20) ?? null;
            const path = body.path?.slice(0, 500) ?? null;
            const device_id = body.device_id?.slice(0, 100) ?? null;
            // Upsert device row (track first/last seen).
            if (device_id) {
              await sb
                .from("devices")
                .upsert(
                  { device_id, last_seen_at: new Date().toISOString() },
                  { onConflict: "device_id" },
                );
            }

            // Client-generated id makes retried/duplicated start beacons
            // idempotent while still keeping separate real visits separate.
            const { error } = await sb
              .from("analytics_sessions")
              .upsert(
                { id: session_id, user_agent, referrer, screen, language, device_id },
                { onConflict: "id", ignoreDuplicates: true },
              );
            if (error) return json({ error: error.message }, 500);

            if (body.discard_session_id && body.discard_session_id !== session_id) {
              const discardId = body.discard_session_id.slice(0, 100);
              await sb.from("analytics_events").delete().eq("session_id", discardId);
              await sb.from("analytics_sessions").delete().eq("id", discardId);
            }

            // Also log a page_load event, once for this created session.
            await sb.from("analytics_events").insert({
              session_id,
              event_type: "page_load",
              path,
            });
            return json({ session_id });
          }

          if (!body.session_id) return json({ error: "session_id required" }, 400);

          if (body.action === "discard") {
            // Remove a passive (no-interaction) session row + its events so
            // the table only contains sessions with real engagement.
            await sb.from("analytics_events").delete().eq("session_id", body.session_id);
            await sb.from("analytics_sessions").delete().eq("id", body.session_id);
            return json({ ok: true });
          }

          if (body.action === "heartbeat") {
            await sb
              .from("analytics_sessions")
              .update({ last_event_at: new Date().toISOString() })
              .eq("id", body.session_id);
            return json({ ok: true });
          }

          if (body.action === "event") {
            const eventType = (body.event_type || "click").slice(0, 50);
            const insert = sb.from("analytics_events").insert({
              session_id: body.session_id,
              event_type: eventType,
              target_tag: body.target_tag?.slice(0, 50),
              target_id: body.target_id?.slice(0, 200),
              target_class: body.target_class?.slice(0, 300),
              target_text: body.target_text?.slice(0, 300),
              path: body.path?.slice(0, 500),
              data: body.data ?? null,
            });

            const [{ error: e1 }, updateRes] = await Promise.all([
              insert,
              LAST_EVENT_TYPES.has(eventType)
                ? sb
                    .from("analytics_sessions")
                    .update({ last_event_at: new Date().toISOString() })
                    .eq("id", body.session_id)
                : Promise.resolve({ error: null }),
            ]);
            if (e1) return json({ error: e1.message }, 500);
            if (updateRes.error) return json({ error: updateRes.error.message }, 500);
            return json({ ok: true });
          }

          return json({ error: "unknown action" }, 400);
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});
