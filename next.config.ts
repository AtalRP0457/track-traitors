import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phones on the LAN load the dev server through the laptop's IP.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
};

export default nextConfig;
