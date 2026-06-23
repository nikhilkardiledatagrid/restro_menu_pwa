
CREATE TABLE public.analytics_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  referrer text,
  screen text,
  language text
);

CREATE TABLE public.analytics_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.analytics_sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  target_tag text,
  target_id text,
  target_class text,
  target_text text,
  path text,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_session ON public.analytics_events(session_id);
CREATE INDEX idx_events_type_created ON public.analytics_events(event_type, created_at DESC);
CREATE INDEX idx_sessions_started ON public.analytics_sessions(started_at DESC);

ALTER TABLE public.analytics_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

-- No public read or write via anon key. All access via server routes with service role.
-- (Empty RLS = locked for anon/authenticated roles; service role bypasses RLS.)
