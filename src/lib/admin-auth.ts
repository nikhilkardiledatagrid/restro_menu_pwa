import { createHmac, timingSafeEqual } from "crypto";

export const ADMIN_COOKIE = "illy_admin";
export const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function getAdminPassword(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

export function signAdminToken(password: string): string {
  return createHmac("sha256", password).update("admin").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ab.length === 0 || ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function isAdminAuthed(request: Request): boolean {
  const password = getAdminPassword();
  if (!password) return false;
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return false;
  const expected = signAdminToken(password);
  return safeEqualHex(token, expected);
}

export function requireAdmin(request: Request): Response | null {
  if (!isAdminAuthed(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}