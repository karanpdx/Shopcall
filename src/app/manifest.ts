import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Shopcall",
    short_name: "Shopcall",
    description: "Call your storefront into existence.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6efe0",
    theme_color: "#f6efe0",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
