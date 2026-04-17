import { NextRequest } from "next/server";
import { verifyToken, type JwtPayload } from "@/lib/auth";

export function getUser(req: NextRequest): JwtPayload | null {
  const token = req.cookies.get("auth-token")?.value;
  return token ? verifyToken(token) : null;
}
