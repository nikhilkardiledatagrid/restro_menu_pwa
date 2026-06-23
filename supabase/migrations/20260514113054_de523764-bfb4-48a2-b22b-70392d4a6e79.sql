
ALTER TABLE public.analytics_sessions ADD COLUMN IF NOT EXISTS device_id text;
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_device_id ON public.analytics_sessions(device_id);

CREATE TABLE IF NOT EXISTS public.devices (
  device_id text PRIMARY KEY,
  label text,
  serial text,
  location text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
