export function isCacheFresh(lastSyncedAt) {
  return Boolean(lastSyncedAt);
}

export function normalizeHandle(raw) {
  const input = (raw || "").trim();
  if (!input) return null;
  if (/^UC[\w-]{20,}$/.test(input)) return { type: "id", value: input };
  return { type: "handle", value: input.startsWith("@") ? input : "@" + input };
}

export function parseChannelAttempts(raw) {
  const input = (raw || "").trim();
  if (!input) return null;

  let url = null;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
  } catch {
    url = null;
  }

  if (url && /(^|\.)youtube\.com$/.test(url.hostname.replace(/^www\./, ""))) {
    const pathName = url.pathname.replace(/\/+$/, "");
    let m;
    if ((m = pathName.match(/^\/channel\/(UC[\w-]{20,})/))) {
      return [{ param: "id", value: m[1] }];
    }
    if ((m = pathName.match(/^\/@([^/]+)/))) {
      return [{ param: "forHandle", value: "@" + m[1] }];
    }
    if ((m = pathName.match(/^\/c\/([^/]+)/))) {
      return [
        { param: "forHandle", value: "@" + m[1] },
        { param: "forUsername", value: m[1] },
      ];
    }
    if ((m = pathName.match(/^\/user\/([^/]+)/))) {
      return [
        { param: "forUsername", value: m[1] },
        { param: "forHandle", value: "@" + m[1] },
      ];
    }
    const seg = pathName.split("/").filter(Boolean).pop();
    if (seg) return [{ param: "forHandle", value: "@" + seg.replace(/^@/, "") }];
  }

  if (/^UC[\w-]{20,}$/.test(input)) {
    return [{ param: "id", value: input }];
  }

  const handle = input.replace(/^@/, "");
  return [
    { param: "forHandle", value: "@" + handle },
    { param: "forUsername", value: handle.replace(/\s+/g, "") },
  ];
}

export function lookupHandleKey(raw) {
  const attempts = parseChannelAttempts(raw);
  if (!attempts) return null;
  const handleAttempt = attempts.find((a) => a.param === "forHandle");
  if (handleAttempt) return handleAttempt.value.toLowerCase();
  const idAttempt = attempts.find((a) => a.param === "id");
  if (idAttempt) return idAttempt.value;
  const userAttempt = attempts.find((a) => a.param === "forUsername");
  if (userAttempt) return ("@" + userAttempt.value).toLowerCase();
  return (raw || "").trim().toLowerCase();
}
