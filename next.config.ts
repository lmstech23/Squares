import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  // `*.dev.tsx` pages exist in `next dev` only. The defaults are unchanged, so
  // every existing route resolves as before; a production build simply does not
  // see the dev-only UI gallery at all.
  pageExtensions:
    process.env.NODE_ENV === "development"
      ? ["tsx", "ts", "jsx", "js", "dev.tsx"]
      : ["tsx", "ts", "jsx", "js"],
};

export default nextConfig;
