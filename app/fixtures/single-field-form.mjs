import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.FORM_FIXTURE_PORT ?? 18083);
let observed = null;

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Visa form fill test</title></head>
<body>
  <h1>Visa form fill test</h1>
  <p>This page uses fictional data. It does not submit an application.</p>
  <label for="arrival-date">Planned arrival date (YYYY-MM-DD)</label>
  <input id="arrival-date" name="arrivalDate" type="text" autocomplete="off" placeholder="YYYY-MM-DD">
  <p id="status" role="status">Waiting for input</p>
  <script>
    const field = document.querySelector('#arrival-date');
    field.addEventListener('input', async () => {
      const response = await fetch('/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: field.value }),
      });
      document.querySelector('#status').textContent = response.ok ? 'Value captured' : 'Capture failed';
    });
  </script>
</body>
</html>`;

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ observed }));
    return;
  }
  if (req.method === "POST" && req.url === "/capture") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) {
        res.writeHead(413).end();
        return;
      }
    }
    try {
      const { value } = JSON.parse(body);
      if (typeof value !== "string" || value.length > 20) throw new Error("Invalid value");
      observed = value;
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  res.writeHead(404).end();
}).listen(port, host, () => {
  console.log(`Form fixture listening at http://${host}:${port}/`);
});
