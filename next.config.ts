import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  turbopack: {
    // Ensures this directory is treated as root
    // (prevents Next.js from picking up parent workspace lockfiles)
    root: process.cwd(),
  },
}

export default nextConfig
