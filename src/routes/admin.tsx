import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

type Session = {
  id: string;
  started_at: string;
  last_event_at: string;
  user_agent: string | null;
  referrer: string | null;
  screen: string | null;
  language: string | null;
  device_id: string | null;
};
type Device = {
  device_id: string;
  label: string | null;
  serial: string | null;
  location: string | null;
  first_seen_at: string;
  last_seen_at: string;
};
type Event = {
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

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin · Analytics" }] }),
  component: AdminPage,
});

const BOUNCE_SECONDS = 10;
const REAL_ENGAGEMENT_EVENTS = new Set([
  "lightbox_open",
  "lightbox_close",
  "hover",
  "time_on_page",
  "session_end",
]);

const TZ = "Asia/Dubai"; // Gulf Standard Time (UTC+4)
const EXCLUDED_SESSION_IDS = new Set<string>([
  "f67aa4c3-08f5-4dda-81e6-2749fb7d5faa", // synthetic debug session
  "b8bb10c9-977a-46b0-b29d-d7140b913cdd",
  "75075df0-286e-440e-a56d-da352622f0fb",
  "25e67c8a-89ca-4ee1-9384-6157ce0d9bd1",
  "8be0256a-0e71-491e-9a4d-d2890f1ccb47",
  "040b8319-fd5c-470e-b4f9-813c5b9a6f38",
  "173b9e63-9a7f-43ff-89cf-eebccf6e4701",
  "9e974077-1a82-4f4e-b484-ea72e98ecf42",
]);

// Production launch cutoff: anything before this is pre-launch test data
// and is excluded from default reporting. (16 May 2026, 4:40pm GST.)
const LAUNCH_AT = "2026-05-16T12:40:00Z";
const LAUNCH_MS = Date.parse(LAUNCH_AT);

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}); // yields YYYY-MM-DD in GST
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtDay = (iso: string) => dayFmt.format(new Date(iso));
const fmtDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

const dowFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
});
const dayOfWeek = (yyyymmdd: string) => dowFmt.format(new Date(`${yyyymmdd}T12:00:00Z`)); // UTC noon = 4pm GST, same date

const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const gstMinutesOfDay = (iso: string) => {
  const [h, m] = hmFmt.format(new Date(iso)).split(":").map(Number);
  return h * 60 + m;
};

const isWeekendISO = (iso: string) => {
  const d = dowFmt.format(new Date(iso));
  return d === "Sat" || d === "Sun";
};

// Local date string -> ISO at start/end of GST day. We treat the date input as GST.
// GST is UTC+4, so "YYYY-MM-DD 00:00 GST" = "YYYY-MM-DDT00:00:00-04:00" in ISO form
// using the offset ... but simpler: build a UTC time and shift by -4h.
const gstDateToISO = (yyyymmdd: string, endOfDay = false) => {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  // GST is UTC+4, so 00:00 GST = previous day 20:00 UTC
  return new Date(utcMs - 4 * 3600 * 1000).toISOString();
};

const todayGST = () => dayFmt.format(new Date());

const fmtMSS = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

type Band = { label: string; test: (min: number) => boolean };

const TIME_BANDS: Band[] = [
  { label: "9:00am – 12:00pm", test: (m) => m >= 540 && m < 720 },
  { label: "12:00pm – 3:30pm", test: (m) => m >= 720 && m < 930 },
  { label: "3:30pm – 7:30pm", test: (m) => m >= 930 && m < 1170 },
  { label: "7:30pm – 10:30pm", test: (m) => m >= 1170 && m < 1350 },
  { label: "10:30pm – 12:30am", test: (m) => m >= 1350 || m < 30 },
];

function AdminPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allSessions, setSessions] = useState<Session[]>([]);
  const [allEvents, setEvents] = useState<Event[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [authed, setAuthed] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  type RangePreset = "24h" | "7d" | "30d" | "90d" | "365d" | "custom";
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const d = new Date(Date.now() - 7 * 86400000);
    return dayFmt.format(d);
  });
  const [customTo, setCustomTo] = useState<string>(() => todayGST());
  type DayFilter =
    | "all"
    | "weekdays"
    | "weekends"
    | "Mon"
    | "Tue"
    | "Wed"
    | "Thu"
    | "Fri"
    | "Sat"
    | "Sun";
  const [dayFilter, setDayFilter] = useState<DayFilter>("all");
  const WEEKDAY_LABEL: Record<Exclude<DayFilter, "all" | "weekdays" | "weekends">, string> = {
    Mon: "Monday",
    Tue: "Tuesday",
    Wed: "Wednesday",
    Thu: "Thursday",
    Fri: "Friday",
    Sat: "Saturday",
    Sun: "Sunday",
  };

  const presetDays: Record<Exclude<RangePreset, "custom">, number> = {
    "24h": 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "365d": 365,
  };

  async function load(opts?: { preset?: RangePreset; from?: string; to?: string }) {
    const p = opts?.preset ?? preset;
    setLoading(true);
    setError(null);
    try {
      let from: string;
      let to: string | undefined;
      if (p === "custom") {
        from = opts?.from ?? gstDateToISO(customFrom);
        to = opts?.to ?? gstDateToISO(customTo, true);
      } else {
        from = new Date(Date.now() - presetDays[p] * 86400000).toISOString();
        to = new Date().toISOString();
      }
      const r = await fetch("/api/admin/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      if (r.status === 401) {
        setAuthed(false);
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      setSessions(j.sessions);
      setEvents(j.events);
      setDevices(j.devices ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (r.status === 401) {
          setAuthed(false);
        } else {
          setAuthed(true);
          await load();
        }
      } catch {
        setAuthed(false);
      } finally {
        setAuthChecking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLoginError(j.error || "Login failed");
        return;
      }
      setLoginPassword("");
      setAuthed(true);
      await load();
    } catch (err) {
      setLoginError((err as Error).message);
    } finally {
      setLoggingIn(false);
    }
  }

  const { stats, sessions, recentSessions, sessionDuration, sessionDisplayStartedAt } = useMemo(() => {
    const matchesDayFilter = (iso: string) => {
      if (dayFilter === "all") return true;
      if (dayFilter === "weekdays" || dayFilter === "weekends") {
        const wknd = isWeekendISO(iso);
        return dayFilter === "weekends" ? wknd : !wknd;
      }
      return dowFmt.format(new Date(iso)) === dayFilter;
    };
    const visits = allSessions.filter(
      (s) =>
        !EXCLUDED_SESSION_IDS.has(s.id) &&
        new Date(s.started_at).getTime() >= LAUNCH_MS &&
        matchesDayFilter(s.started_at),
    );
    const visibleSessionIds = new Set(visits.map((s) => s.id));
    const events = allEvents.filter(
      (e) =>
        visibleSessionIds.has(e.session_id) &&
        new Date(e.created_at).getTime() >= LAUNCH_MS &&
        matchesDayFilter(e.created_at),
    );

    const pageLoads = events.filter((e) => e.event_type === "page_load");
    const clicks = events.filter((e) => e.event_type === "lightbox_open"); // "click" = lightbox open
    const timeEvents = events.filter((e) => e.event_type === "time_on_page");
    const sessionEndEvents = events.filter((e) => e.event_type === "session_end");

    const firstEngagementAt: Record<string, number> = {};
    for (const e of events) {
      if (!REAL_ENGAGEMENT_EVENTS.has(e.event_type)) continue;
      const t = new Date(e.created_at).getTime();
      if (!firstEngagementAt[e.session_id] || t < firstEngagementAt[e.session_id]) {
        firstEngagementAt[e.session_id] = t;
      }
    }

    // Best recorded visible-time per session (ms). Sessions without a
    // time_on_page event have no entry here.
    const timePerSession: Record<string, number> = {};
    for (const e of timeEvents) {
      const ms = (e.data as { ms?: number } | null)?.ms ?? 0;
      // Ignore zero-ms flushes (early/empty kiosk flushes) so the wall-clock
      // fallback below can produce a sensible duration instead of locking at 0s.
      if (ms <= 0) continue;
      if (!timePerSession[e.session_id] || ms > timePerSession[e.session_id]) {
        timePerSession[e.session_id] = ms;
      }
    }

    const endedMsPerSession: Record<string, number> = {};
    const endedAtPerSession: Record<string, number> = {};
    for (const e of sessionEndEvents) {
      const ms = (e.data as { ms?: number } | null)?.ms ?? 0;
      endedAtPerSession[e.session_id] = Math.max(
        endedAtPerSession[e.session_id] || 0,
        new Date(e.created_at).getTime(),
      );
      if (ms <= 0) continue;
      if (!endedMsPerSession[e.session_id] || ms > endedMsPerSession[e.session_id]) {
        endedMsPerSession[e.session_id] = ms;
      }
    }

    // Effective duration per session (sec). Prefer explicit session_end wall
    // time, then active time, then the stored server-side fallback.
    const MAX_FALLBACK_SEC = 60;
    const sessionDuration: Record<string, number> = {};
    const sessionDisplayStartedAt: Record<string, string> = {};
    for (const s of visits) {
      const fromEnd = endedMsPerSession[s.id];
      const fromTime = timePerSession[s.id];
      const startedAt = new Date(s.started_at).getTime();
      const engagedAt = firstEngagementAt[s.id];
      const idleBeforeEngagement = engagedAt ? engagedAt - startedAt : 0;
      if (engagedAt && idleBeforeEngagement > BOUNCE_SECONDS * 1000) {
        sessionDisplayStartedAt[s.id] = new Date(engagedAt).toISOString();
      }
      if (fromEnd != null) {
        const endAt = endedAtPerSession[s.id];
        const serverWallMs = endAt ? Math.max(0, endAt - startedAt) : null;
        const adjustedMs =
          engagedAt && endAt && idleBeforeEngagement > BOUNCE_SECONDS * 1000
            ? Math.max(0, endAt - engagedAt)
            : fromEnd;
        const trustedMs =
          serverWallMs != null && adjustedMs - serverWallMs > 3000 ? serverWallMs : adjustedMs;
        sessionDuration[s.id] = Math.max(0, Math.round(trustedMs / 1000));
      } else if (fromTime != null) {
        sessionDuration[s.id] = Math.max(0, Math.round(fromTime / 1000));
      } else {
        const raw = Math.round(
          (new Date(s.last_event_at).getTime() - new Date(s.started_at).getTime()) / 1000,
        );
        sessionDuration[s.id] = Math.max(0, Math.min(raw, MAX_FALLBACK_SEC));
      }
    }

    // Sessions that contain explicit engagement/end timing — never bounces.
    const engagedSessionIds = new Set(events.filter((e) => REAL_ENGAGEMENT_EVENTS.has(e.event_type)).map((e) => e.session_id));

    // Bounce: shorter than threshold AND no real engagement recorded.
    const bouncedIds = new Set<string>();
    for (const s of visits) {
      const sec = sessionDuration[s.id] ?? 0;
      if (sec < BOUNCE_SECONDS && !engagedSessionIds.has(s.id)) {
        bouncedIds.add(s.id);
      }
    }
    const bounces = bouncedIds.size;

    // "Sessions" metric = every session that did NOT bounce.
    const sessions = visits.filter((s) => !bouncedIds.has(s.id));

    // Avg time on page = average of time_on_page across sessions that
    // recorded one (any session, bounced or not).
    const timeValues = Object.values(timePerSession);
    const avgTimeOnPage =
      timeValues.length > 0
        ? Math.round(timeValues.reduce((a, b) => a + b, 0) / timeValues.length / 1000)
        : 0;

    const bounceRate = visits.length > 0 ? Math.round((bounces / visits.length) * 1000) / 10 : 0;

    // Per-bucket helper.
    const buildBucket = (loads: number, sessList: Session[], bouncedCount: number) => {
      const durs = sessList.map((s) => timePerSession[s.id]).filter((v): v is number => v != null);
      const avg =
        durs.length > 0 ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length / 1000) : null;
      const totalSess = sessList.length + bouncedCount;
      const br = totalSess > 0 ? Math.round((bouncedCount / totalSess) * 1000) / 10 : null;
      return { loads, sessions: sessList.length, avgTime: avg, bounceRate: br };
    };

    // ----- Per day -----
    const loadsByDay: Record<string, number> = {};
    for (const p of pageLoads) {
      const d = fmtDay(p.created_at);
      loadsByDay[d] = (loadsByDay[d] || 0) + 1;
    }
    const sessByDay: Record<string, Session[]> = {};
    for (const s of sessions) {
      const d = fmtDay(s.started_at);
      (sessByDay[d] ||= []).push(s);
    }
    const bouncedByDay: Record<string, number> = {};
    for (const s of visits) {
      if (!bouncedIds.has(s.id)) continue;
      const d = fmtDay(s.started_at);
      bouncedByDay[d] = (bouncedByDay[d] || 0) + 1;
    }
    const allDays = new Set<string>([
      ...Object.keys(loadsByDay),
      ...Object.keys(sessByDay),
      ...Object.keys(bouncedByDay),
    ]);
    const daySeries = Array.from(allDays)
      .sort((a, b) => (a < b ? 1 : -1))
      .map((d) => ({
        day: d,
        dow: dayOfWeek(d),
        ...buildBucket(loadsByDay[d] || 0, sessByDay[d] || [], bouncedByDay[d] || 0),
      }));

    // ----- Per time band -----
    const bandSeries = TIME_BANDS.map((b) => {
      const loads = pageLoads.filter((p) => b.test(gstMinutesOfDay(p.created_at))).length;
      const sessList = sessions.filter((s) => b.test(gstMinutesOfDay(s.started_at)));
      const bouncedCount = visits.filter(
        (s) => bouncedIds.has(s.id) && b.test(gstMinutesOfDay(s.started_at)),
      ).length;
      return { label: b.label, ...buildBucket(loads, sessList, bouncedCount) };
    });

    // (legacy generic click breakdown removed — replaced by itemViews below)

    // ---- Other event types ----
    const scrollEvents = events.filter((e) => e.event_type === "scroll_depth");
    const hoverEvents = events.filter((e) => e.event_type === "hover");
    const sectionEvents = events.filter((e) => e.event_type === "section_view");
    const closeEvents = events.filter((e) => e.event_type === "lightbox_close");

    // Highest scroll threshold reached per session — exclusive buckets.
    // Every session counts in the 25% bucket as a baseline (they loaded the page);
    // sessions that scrolled further bump up to 50/75/100 and are removed from lower buckets.
    const maxScrollBySession: Record<string, number> = {};
    for (const e of scrollEvents) {
      const t = Number(e.target_id || 0);
      if (!t) continue;
      if (!maxScrollBySession[e.session_id] || t > maxScrollBySession[e.session_id]) {
        maxScrollBySession[e.session_id] = t;
      }
    }
    const scrollByThreshold: Record<string, Set<string>> = {
      "25": new Set(),
      "50": new Set(),
      "75": new Set(),
      "100": new Set(),
    };
    for (const s of sessions) {
      const max = maxScrollBySession[s.id] || 0;
      const bucket = max >= 100 ? "100" : max >= 75 ? "75" : max >= 50 ? "50" : "25";
      scrollByThreshold[bucket].add(s.id);
    }
    const scrollDepth = ["25", "50", "75", "100"].map((t) => ({
      threshold: t,
      sessions: scrollByThreshold[t].size,
      pct:
        sessions.length > 0
          ? Math.round((scrollByThreshold[t].size / sessions.length) * 1000) / 10
          : 0,
    }));

    const hoverCounts: Record<string, number> = {};
    for (const e of hoverEvents) {
      const k = (e.target_text || "?").trim().slice(0, 60);
      hoverCounts[k] = (hoverCounts[k] || 0) + 1;
    }
    const topHovers = Object.entries(hoverCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25);

    const sectionByKey: Record<string, { title: string; sessions: Set<string> }> = {};
    for (const e of sectionEvents) {
      const id = e.target_id || "?";
      if (!sectionByKey[id]) sectionByKey[id] = { title: e.target_text || id, sessions: new Set() };
      sectionByKey[id].sessions.add(e.session_id);
    }
    const sectionSeries = Object.entries(sectionByKey)
      .map(([id, v]) => ({
        id,
        title: v.title,
        sessions: v.sessions.size,
        pct: sessions.length > 0 ? Math.round((v.sessions.size / sessions.length) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    // Combined per-item: views (lightbox_open) + avg dwell (lightbox_close)
    type ItemAgg = {
      name: string;
      sub: string;
      sessions: Set<string>;
      opens: number;
      dwellTotal: number;
      dwellN: number;
    };
    const itemMap: Record<string, ItemAgg> = {};
    const keyOf = (sub: string, name: string) => `${sub}\u0001${name}`;
    for (const e of clicks) {
      const name = (e.target_text || "?").trim().slice(0, 80);
      const sub = (e.target_class || "").trim().slice(0, 60);
      const k = keyOf(sub, name);
      if (!itemMap[k])
        itemMap[k] = { name, sub, sessions: new Set(), opens: 0, dwellTotal: 0, dwellN: 0 };
      itemMap[k].opens += 1;
      itemMap[k].sessions.add(e.session_id);
    }
    let dwellTotal = 0;
    let dwellN = 0;
    for (const e of closeEvents) {
      const ms = (e.data as { dwell_ms?: number } | null)?.dwell_ms ?? 0;
      if (ms <= 0) continue;
      dwellTotal += ms;
      dwellN += 1;
      const name = (e.target_text || "?").trim().slice(0, 80);
      const sub = (e.target_class || "").trim().slice(0, 60);
      const k = keyOf(sub, name);
      if (!itemMap[k])
        itemMap[k] = { name, sub, sessions: new Set(), opens: 0, dwellTotal: 0, dwellN: 0 };
      itemMap[k].dwellTotal += ms;
      itemMap[k].dwellN += 1;
    }
    const avgLightboxDwell = dwellN > 0 ? Math.round(dwellTotal / dwellN / 1000) : 0;
    const itemViews = Object.values(itemMap)
      .map((d) => ({
        name: d.name,
        sub: d.sub,
        uniqueSessions: d.sessions.size,
        totalOpens: d.opens,
        avgSec: d.dwellN > 0 ? Math.round(d.dwellTotal / d.dwellN / 1000) : 0,
      }))
      .sort((a, b) => b.uniqueSessions - a.uniqueSessions || b.totalOpens - a.totalOpens);

    // ---- Session classification (kiosk-aware) ----
    const lightboxSessionIds = new Set(clicks.map((e) => e.session_id));
    const sectionViewSessionIds = new Set(sectionEvents.map((e) => e.session_id));
    const noiseReloadIds = new Set<string>();
    const quickGlanceIds = new Set<string>();
    const engagedIds = new Set<string>();
    for (const s of visits) {
      const sec = sessionDuration[s.id] ?? 0;
      const maxScroll = maxScrollBySession[s.id] || 0;
      const opened = lightboxSessionIds.has(s.id);
      const sawSection = sectionViewSessionIds.has(s.id);
      const meaningful = opened || sawSection || maxScroll >= 25 || sec >= 15;
      if (sec < 3 && !meaningful) {
        noiseReloadIds.add(s.id);
        continue;
      }
      if (meaningful) engagedIds.add(s.id);
      if (sec >= 3 && sec < 15 && !opened && !engagedIds.has(s.id)) {
        quickGlanceIds.add(s.id);
      }
    }
    const rawVisits = visits.length;
    const noiseCount = noiseReloadIds.size;
    const validCount = rawVisits - noiseCount;
    const engagedCount = engagedIds.size;
    const quickGlanceCount = quickGlanceIds.size;
    const engagementRate =
      validCount > 0 ? Math.round((engagedCount / validCount) * 1000) / 10 : 0;
    const quickGlanceRate =
      validCount > 0 ? Math.round((quickGlanceCount / validCount) * 1000) / 10 : 0;
    const noiseRate =
      rawVisits > 0 ? Math.round((noiseCount / rawVisits) * 1000) / 10 : 0;

    return {
      stats: {
        totalPageLoads: pageLoads.length,
        totalSessions: sessions.length,
        rawVisits,
        validCount,
        engagedCount,
        quickGlanceCount,
        noiseCount,
        engagementRate,
        quickGlanceRate,
        noiseRate,
        totalClicks: clicks.length,
        avgClicksPerSession:
          sessions.length > 0 ? Math.round((clicks.length / sessions.length) * 10) / 10 : 0,
        avgTimeOnPage,
        avgLightboxDwell,
        bounceRate,
        bounces,
        daySeries,
        bandSeries,
        itemViews,
        scrollDepth,
        topHovers,
        sectionSeries,
      },
      sessions,
      recentSessions: sessions,
      sessionDuration,
      sessionDisplayStartedAt,
    };
  }, [allSessions, allEvents, dayFilter]);

  const presetLabel: Record<RangePreset, string> = {
    "24h": "Last 24h",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    "365d": "Last year",
    custom: `${customFrom} → ${customTo}`,
  };
  const dayFilterLabel =
    dayFilter === "all"
      ? ""
      : dayFilter === "weekdays"
        ? " · weekdays only"
        : dayFilter === "weekends"
          ? " · weekends only"
          : ` · ${WEEKDAY_LABEL[dayFilter]}s only`;

  if (authChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
        >
          <div>
            <h1 className="text-lg font-semibold text-foreground">Admin sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter the admin password to view analytics.
            </p>
          </div>
          <input
            type="password"
            autoFocus
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
          {loginError && <p className="text-sm text-destructive">{loginError}</p>}
          <button
            type="submit"
            disabled={loggingIn || !loginPassword}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Menu Analytics</h1>
            <p className="text-sm text-muted-foreground">
              {presetLabel[preset]}
              {dayFilterLabel} · engaged = lightbox open, section view, scroll ≥25%, or
              ≥15s on page
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Default reporting excludes test data before 16 May 2026, 4:40pm GST.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={preset}
              onChange={(e) => {
                const p = e.target.value as RangePreset;
                setPreset(p);
                if (p !== "custom") load({ preset: p });
              }}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="365d">Last year</option>
              <option value="custom">Custom range…</option>
            </select>

            {preset === "custom" && (
              <>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-2 text-sm"
                />
                <span className="text-muted-foreground text-sm">→</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={todayGST()}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-2 text-sm"
                />
                <button
                  onClick={() => load({ preset: "custom" })}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
                >
                  Apply
                </button>
              </>
            )}

            <select
              value={dayFilter}
              onChange={(e) => setDayFilter(e.target.value as typeof dayFilter)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="all">All days</option>
              <option value="weekdays">Weekdays (Mon–Fri)</option>
              <option value="weekends">Weekends (Sat–Sun)</option>
              <optgroup label="Single weekday">
                <option value="Mon">Mondays</option>
                <option value="Tue">Tuesdays</option>
                <option value="Wed">Wednesdays</option>
                <option value="Thu">Thursdays</option>
                <option value="Fri">Fridays</option>
                <option value="Sat">Saturdays</option>
                <option value="Sun">Sundays</option>
              </optgroup>
            </select>

            <button
              onClick={() => load()}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
            >
              {loading ? "…" : "Refresh"}
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Menu Opens"
            value={stats.totalPageLoads}
            sub="deduped page loads"
          />
          <Stat
            label="Valid Guest Sessions"
            value={stats.validCount}
            sub={`${stats.rawVisits} raw visits`}
          />
          <Stat
            label="Engagement Rate"
            value={`${stats.engagementRate}%`}
            sub={`${stats.engagedCount} engaged / ${stats.validCount} valid`}
          />
          <Stat
            label="Quick Glance Rate"
            value={`${stats.quickGlanceRate}%`}
            sub={`${stats.quickGlanceCount} sessions`}
          />
          <Stat
            label="Noise / Reload"
            value={stats.noiseCount}
            sub={`${stats.noiseRate}% of raw visits`}
          />
          <Stat
            label="Avg clicks / session"
            value={stats.avgClicksPerSession}
            sub={`${stats.totalClicks} total`}
          />
          <Stat
            label="Avg time on page"
            value={fmtMSS(stats.avgTimeOnPage)}
            sub={stats.avgTimeOnPage ? "from time_on_page" : "no data yet"}
          />
          <Stat
            label="Avg lightbox dwell"
            value={fmtMSS(stats.avgLightboxDwell)}
            sub="time inside popups"
          />
        </section>

        <Card title="Per day">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Date</th>
                  <th className="py-2">Day</th>
                  <th className="py-2 text-right">Page loads</th>
                  <th className="py-2 text-right">Sessions</th>
                  <th className="py-2 text-right">Avg time</th>
                  <th className="py-2 text-right">Bounce rate</th>
                </tr>
              </thead>
              <tbody>
                {stats.daySeries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-muted-foreground">
                      No data yet.
                    </td>
                  </tr>
                )}
                {stats.daySeries.map((row) => (
                  <tr key={row.day} className="border-t border-border">
                    <td className="py-2 whitespace-nowrap">{row.day}</td>
                    <td className="py-2 text-muted-foreground">{row.dow}</td>
                    <td className="py-2 tabular-nums text-right">{row.loads}</td>
                    <td className="py-2 tabular-nums text-right">{row.sessions}</td>
                    <td className="py-2 tabular-nums text-right">
                      {row.avgTime == null ? "—" : fmtMSS(row.avgTime)}
                    </td>
                    <td className="py-2 tabular-nums text-right">
                      {row.bounceRate == null ? "—" : `${row.bounceRate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="By time of day (GST)">
          <p className="-mt-2 mb-3 text-xs text-muted-foreground">
            Time bands aggregate activity across all selected days.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Time band</th>
                  <th className="py-2 text-right">Page loads</th>
                  <th className="py-2 text-right">Sessions</th>
                  <th className="py-2 text-right">Avg time</th>
                  <th className="py-2 text-right">Bounce rate</th>
                </tr>
              </thead>
              <tbody>
                {stats.bandSeries.map((row) => (
                  <tr key={row.label} className="border-t border-border">
                    <td className="py-2 whitespace-nowrap">{row.label}</td>
                    <td className="py-2 tabular-nums text-right">{row.loads}</td>
                    <td className="py-2 tabular-nums text-right">{row.sessions}</td>
                    <td className="py-2 tabular-nums text-right">
                      {row.avgTime == null ? "—" : fmtMSS(row.avgTime)}
                    </td>
                    <td className="py-2 tabular-nums text-right">
                      {row.bounceRate == null ? "—" : `${row.bounceRate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Scroll depth (sessions by highest threshold reached)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Threshold</th>
                  <th className="py-2 text-right">Sessions</th>
                  <th className="py-2 text-right">% of sessions</th>
                </tr>
              </thead>
              <tbody>
                {stats.scrollDepth.map((r) => (
                  <tr key={r.threshold} className="border-t border-border">
                    <td className="py-2">{r.threshold}%</td>
                    <td className="py-2 text-right tabular-nums">{r.sessions}</td>
                    <td className="py-2 text-right tabular-nums">{r.pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Top hovered items (≥1s dwell, deduped per session)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Item</th>
                  <th className="py-2 text-right">Hovers</th>
                </tr>
              </thead>
              <tbody>
                {stats.topHovers.length === 0 && (
                  <tr>
                    <td colSpan={2} className="py-4 text-muted-foreground">
                      No hovers yet (touch devices have no hover).
                    </td>
                  </tr>
                )}
                {stats.topHovers.map(([k, n]) => (
                  <tr key={k} className="border-t border-border">
                    <td className="py-2 truncate max-w-[420px]" title={k}>
                      {k}
                    </td>
                    <td className="py-2 text-right tabular-nums">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Menu item views and average dwell">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Sub Category</th>
                  <th className="py-2">Item Name</th>
                  <th className="py-2 text-right">Unique Interested Sessions</th>
                  <th className="py-2 text-right">Total Opens</th>
                  <th className="py-2 text-right">Average dwell</th>
                </tr>
              </thead>
              <tbody>
                {stats.itemViews.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-4 text-muted-foreground">
                      No menu item views yet.
                    </td>
                  </tr>
                )}
                {stats.itemViews.map((r) => (
                  <tr key={`${r.sub}\u0001${r.name}`} className="border-t border-border">
                    <td className="py-2 truncate max-w-[200px]" title={r.sub}>
                      {r.sub || "—"}
                    </td>
                    <td className="py-2 truncate max-w-[320px]" title={r.name}>
                      {r.name}
                    </td>
                    <td className="py-2 text-right tabular-nums">{r.uniqueSessions}</td>
                    <td className="py-2 text-right tabular-nums">{r.totalOpens}</td>
                    <td className="py-2 text-right tabular-nums">
                      {r.avgSec > 0 ? fmtMSS(r.avgSec) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <DevicesCard devices={devices} onRefresh={() => load()} />

        <Card title="Recent sessions">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Started</th>
                  <th className="py-2">Duration</th>
                  <th className="py-2">Device</th>
                  <th className="py-2">Referrer</th>
                  <th className="py-2">Screen</th>
                  <th className="py-2">User agent</th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.slice(0, 100).map((s) => {
                  const sec = sessionDuration[s.id] ?? 0;
                  const displayStartedAt = sessionDisplayStartedAt[s.id] ?? s.started_at;
                  const dev = s.device_id ? devices.find((d) => d.device_id === s.device_id) : null;
                  const devLabel = dev?.label || (s.device_id ? s.device_id.slice(0, 8) : "—");
                  return (
                    <tr key={s.id} className="border-t border-border">
                      <td className="py-2 whitespace-nowrap">{fmtDateTime(displayStartedAt)}</td>
                      <td className="py-2 tabular-nums">{sec}s</td>
                      <td className="py-2 truncate max-w-[160px]" title={s.device_id || ""}>
                        {devLabel}
                      </td>
                      <td className="py-2 truncate max-w-[200px]" title={s.referrer || ""}>
                        {s.referrer || "—"}
                      </td>
                      <td className="py-2">{s.screen || "—"}</td>
                      <td className="py-2 truncate max-w-[300px]" title={s.user_agent || ""}>
                        {s.user_agent || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function DevicesCard({
  devices: allDevices,
  onRefresh,
}: {
  devices: Device[];
  onRefresh: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, { label: string; location: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  // Only show devices that haven't been configured yet (no label saved)
  const devices = allDevices.filter((d) => !d.label || d.label.trim() === "");

  const getRow = (d: Device) =>
    edits[d.device_id] ?? {
      label: d.label ?? "",
      location: d.location ?? "",
    };

  const setField = (id: string, field: "label" | "location", value: string) => {
    setEdits((prev) => ({
      ...prev,
      [id]: {
        ...getRow({
          device_id: id,
          label: null,
          serial: null,
          location: null,
          first_seen_at: "",
          last_seen_at: "",
        }),
        ...prev[id],
        [field]: value,
      },
    }));
  };

  const save = async (d: Device) => {
    const row = getRow(d);
    setSavingId(d.device_id);
    try {
      const r = await fetch("/api/admin/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: d.device_id, ...row }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Save failed");
      setEdits((prev) => {
        const copy = { ...prev };
        delete copy[d.device_id];
        return copy;
      });
      onRefresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Card title={`Devices (${devices.length})`}>
      <p className="mb-3 text-xs text-muted-foreground">
        Each tablet generates a persistent device ID on first visit. Label them once (e.g. "Store 1
        — Counter") and add a location. Sessions will then show the friendly name.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">Device ID</th>
              <th className="py-2">Label</th>
              <th className="py-2">Location</th>
              <th className="py-2">Last seen</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-muted-foreground">
                  No devices recorded yet.
                </td>
              </tr>
            )}
            {devices.map((d) => {
              const row = getRow(d);
              const dirty = edits[d.device_id] != null;
              return (
                <tr key={d.device_id} className="border-t border-border">
                  <td className="py-2 font-mono text-xs" title={d.device_id}>
                    {d.device_id.slice(0, 8)}…
                  </td>
                  <td className="py-2">
                    <input
                      value={row.label}
                      onChange={(e) => setField(d.device_id, "label", e.target.value)}
                      placeholder="e.g. Store 1 — Counter"
                      className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2">
                    <input
                      value={row.location}
                      onChange={(e) => setField(d.device_id, "location", e.target.value)}
                      placeholder="Location"
                      className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 whitespace-nowrap text-muted-foreground text-xs">
                    {fmtDateTime(d.last_seen_at)}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => save(d)}
                      disabled={!dirty || savingId === d.device_id}
                      className="rounded-md border border-input bg-background px-3 py-1 text-xs hover:bg-accent disabled:opacity-40"
                    >
                      {savingId === d.device_id ? "…" : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
