import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/admin-auth";

function admin() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type AnalyticsSession = {
  id: string;
  started_at: string;
  last_event_at: string;
  user_agent: string | null;
  referrer: string | null;
  screen: string | null;
  language: string | null;
  device_id: string | null;
};

type AnalyticsEvent = {
  id: number;
  session_id: string;
  event_type: string;
  target_tag: string | null;
  target_id: string | null;
  target_class: string | null;
  target_text: string | null;
  path: string | null;
  data: unknown;
  created_at: string;
};

export const Route = createFileRoute("/api/admin/stats")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = requireAdmin(request);
        if (denied) return denied;
        try {
          const body = (await request.json().catch(() => ({}))) as {
            from?: string;
            to?: string;
          };

          const sb = admin();
          const from =
            body.from ||
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const to = body.to || new Date().toISOString();

          const [sessionsRes, eventsRes, devicesRes] = await Promise.all([
            sb
              .from("analytics_sessions")
              .select("id, started_at, last_event_at, user_agent, referrer, screen, language, device_id")
              .gte("started_at", from)
              .lte("started_at", to)
              .order("started_at", { ascending: false })
              .limit(5000),
            sb
              .from("analytics_events")
              .select("id, session_id, event_type, target_tag, target_id, target_class, target_text, path, data, created_at")
              .gte("created_at", from)
              .lte("created_at", to)
              .order("created_at", { ascending: false })
              .limit(10000),
            sb
              .from("devices")
              .select("device_id, label, serial, location, first_seen_at, last_seen_at")
              .order("last_seen_at", { ascending: false }),
          ]);

          if (sessionsRes.error) return json({ error: sessionsRes.error.message }, 500);
          if (eventsRes.error) return json({ error: eventsRes.error.message }, 500);
          if (devicesRes.error) return json({ error: devicesRes.error.message }, 500);

          const rawSessions = (sessionsRes.data ?? []) as AnalyticsSession[];
          const rawEvents = (eventsRes.data ?? []) as AnalyticsEvent[];
          const seenPageLoads = new Set<string>();
          const events = rawEvents.flatMap((event) => {
            const session_id = event.session_id;
            if (event.event_type === "page_load") {
              if (seenPageLoads.has(session_id)) return [];
              seenPageLoads.add(session_id);
            }
            return [{ ...event, session_id }];
          });

          return json({
            sessions: rawSessions.sort(
              (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
            ),
            events,
            devices: devicesRes.data ?? [],
          });
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});
