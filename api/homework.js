// /api/homework — server-side proxy to WebUntis.
// Runs on Vercel, never in the browser, so your WebUntis password
// (stored as environment variables) is never exposed to the page.

function untisDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

module.exports = async function handler(req, res) {
  const SCHOOL = process.env.WEBUNTIS_SCHOOL;
  const SERVER = process.env.WEBUNTIS_SERVER;
  const USER = process.env.WEBUNTIS_USER;
  const PASS = process.env.WEBUNTIS_PASS;
  const DAYS_AHEAD = Number(process.env.WEBUNTIS_DAYS_AHEAD || 7);

  if (!SCHOOL || !SERVER || !USER || !PASS) {
    res.status(500).json({ error: "Missing WebUntis environment variables on the server." });
    return;
  }

  try {
    // 1. Log in
    const authRes = await fetch(`https://${SERVER}/WebUntis/jsonrpc.do?school=${encodeURIComponent(SCHOOL)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ipad-homework-widget",
        method: "authenticate",
        params: { user: USER, password: PASS, client: "ipad-homework-widget" },
        jsonrpc: "2.0",
      }),
    });
    const authData = await authRes.json();

    if (!authData.result || !authData.result.sessionId) {
      res.status(401).json({ error: "WebUntis login failed. Check WEBUNTIS_USER / WEBUNTIS_PASS.", details: authData.result || authData.error });
      return;
    }

    const sessionId = authData.result.sessionId;
    const schoolB64 = Buffer.from(SCHOOL).toString("base64");
    const cookie = `JSESSIONID=${sessionId}; schoolname=_${schoolB64}`;

    // 2. Fetch homework for the next N days
    const today = new Date();
    const end = new Date();
    end.setDate(end.getDate() + DAYS_AHEAD);

    const hwRes = await fetch(
      `https://${SERVER}/WebUntis/api/homeworks/lessons?startDate=${untisDate(today)}&endDate=${untisDate(end)}`,
      { headers: { Cookie: cookie } }
    );
    const hwData = await hwRes.json();
    const homeworks = (hwData.data && hwData.data.homeworks) || [];

    // The homework endpoint sometimes includes a "lessons" array that maps
    // lessonId -> subject info. Use it if present; otherwise fall back gracefully.
    const lessonsMap = {};
    if (hwData.data && Array.isArray(hwData.data.lessons)) {
      for (const l of hwData.data.lessons) {
        lessonsMap[l.id] = l.subject || l.longName || l.name || null;
      }
    }

    const items = homeworks
      .map((hw) => ({
        id: hw.id,
        assignedDate: hw.date,
        dueDate: hw.dueDate,
        text: hw.text,
        remark: hw.remark || "",
        completed: !!hw.completed,
        subject: lessonsMap[hw.lessonId] || null,
      }))
      .filter((hw) => !hw.completed)
      .sort((a, b) => a.dueDate - b.dueDate);

    // 3. Best-effort logout (don't block the response on it)
    fetch(`https://${SERVER}/WebUntis/jsonrpc.do?school=${encodeURIComponent(SCHOOL)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ id: "logout", method: "logout", params: {}, jsonrpc: "2.0" }),
    }).catch(() => {});

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ items, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Server error while contacting WebUntis.", message: err.message });
  }
};
