import { handle } from "@hono/vercel";
import { getHttpApp } from "@/http/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(getHttpApp());
