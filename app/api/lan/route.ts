// Dev helper: tells the host page the laptop's Wi-Fi address so the QR code
// works on phones even when the host page was opened as "localhost".
import { networkInterfaces } from "node:os";

export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address)
    .sort((a, b) => Number(!a.startsWith("192.168.")) - Number(!b.startsWith("192.168.")));
  return Response.json({ ips });
}
