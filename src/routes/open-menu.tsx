import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/open-menu")({
  head: () => ({
    meta: [
      { title: "illy Caffè — Menu" },
      { name: "description", content: "illy Caffè interactive menu." },
    ],
  }),
  component: OpenMenu,
});

function OpenMenu() {
  const [src, setSrc] = useState("/standalone.html");

  useEffect(() => {
    const isPair = new URLSearchParams(window.location.search).get("pair") === "1";
    if (isPair) setSrc("/standalone.html?pair=1");
  }, []);

  return (
    <iframe
      src={src}
      title="illy Caffè Menu"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        border: 0,
      }}
    />
  );
}
