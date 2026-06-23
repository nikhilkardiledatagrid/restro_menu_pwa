import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "illy Caffè — Menu" },
      { name: "description", content: "illy Caffè interactive menu." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <iframe
      src="/standalone.html"
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
