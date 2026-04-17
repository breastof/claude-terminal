import { NextResponse } from "next/server";
import { ROOTS } from "@/lib/explorer-roots";

export async function GET() {
  const roots = Object.entries(ROOTS).map(([key, r]) => ({
    key,
    label: r.label,
    writable: r.writable,
  }));
  return NextResponse.json({ roots });
}
