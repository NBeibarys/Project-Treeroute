import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "AIzaSyDxCXochIcNlYjs1LpJDel9ZDLfTRVMGX0",
  },
};

export default nextConfig;
