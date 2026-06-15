export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 40, maxWidth: 640 }}>
      <h1>BKREA MCP (remote)</h1>
      <p>
        This is a Model Context Protocol server. The endpoint is{" "}
        <code>/api/mcp</code> and requires the shared secret. Add it to Claude as a
        custom connector — see the repo README.
      </p>
    </main>
  );
}
