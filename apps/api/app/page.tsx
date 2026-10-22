export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", padding: "0 1rem", lineHeight: 1.6 }}>
      <h1 style={{ fontFamily: "Georgia, serif" }}>LaTeX API</h1>
      <p>This is the API server. Useful endpoints:</p>
      <ul>
        <li>
          <a href="/reference">/reference</a> — interactive API reference
        </li>
        <li>
          <a href="/openapi.json">/openapi.json</a> — OpenAPI 3.1 document
        </li>
        <li>
          <a href="/health">/health</a> — health check
        </li>
        <li>
          <a href="/v1/templates">/v1/templates</a> — template catalog
        </li>
      </ul>
    </main>
  );
}
